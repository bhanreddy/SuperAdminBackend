/**
 * NexSyrus Client Billing — SaaS subscription invoicing (GST tax invoice + non-GST receipt).
 *
 * Mounted at /api/super-admin/billing (behind verifySuperAdminMiddleware).
 *
 * Data model (STEP-0 audit): there is no central `clients` table — clients live
 * in per-cluster DBs across two verticals. Per the chosen "free-text snapshot
 * only" model, every document freezes its own client snapshot at issue time;
 * `client_id`/`client_kind`/`client_cluster_id` are optional, informational only.
 *
 * Document numbers come exclusively from `billing_document_counters` inside a
 * single row-locked transaction — the frontend never supplies or guesses one.
 */

const express = require('express');
const sql = require('../../config/db');
const { sendResponse, sendError } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const {
  BillingError,
  computeFinancialYear,
  isValidGstin,
  formatDocumentNumber,
  normaliseLineItems,
  computeTaxBreakup,
  renderDocumentHtml,
} = require('../../utils/billingDocument');

const router = express.Router();
router.use(verifySuperAdminMiddleware);

// ─── Typed error mapping (no bare catch — always log + return a stable code) ──
function failBilling(res, err, context) {
  if (err instanceof BillingError) {
    console.error(`[billing] ${context} :: ${err.code} :: ${err.message}`);
    return sendError(res, err.httpStatus, err.code, err.message);
  }
  // Postgres lock/serialization failures surface as specific SQLSTATEs.
  const pgCode = err && err.code;
  if (pgCode === '55P03' || pgCode === '40001' || pgCode === '40P01') {
    console.error(`[billing] ${context} :: COUNTER_LOCK_FAILED :: pg=${pgCode} :: ${err.message}`);
    return sendError(res, 409, 'COUNTER_LOCK_FAILED', 'Could not acquire the document counter lock — please retry');
  }
  if (pgCode === '23505') {
    console.error(`[billing] ${context} :: DUPLICATE_DOCUMENT_NUMBER :: ${err.message}`);
    return sendError(res, 409, 'DUPLICATE_DOCUMENT_NUMBER', 'A document with this number already exists — please retry');
  }
  // 42P01 undefined_table / 42703 undefined_column — migration not applied yet.
  if (pgCode === '42P01' || pgCode === '42703') {
    console.error(`[billing] ${context} :: NOT_MIGRATED :: pg=${pgCode} :: ${err.message}`);
    return sendError(res, 503, 'NOT_MIGRATED', 'Billing tables are missing — apply migration 05_billing.sql to the central database');
  }
  console.error(`[billing] ${context} :: INTERNAL :: ${err && err.stack ? err.stack : err}`);
  return sendError(res, 500, 'INTERNAL', 'Unexpected billing failure');
}

// ─── Config helpers ──────────────────────────────────────────────────────────
async function loadConfig(executor = sql) {
  const [row] = await executor`SELECT * FROM billing_config WHERE id = 1`;
  if (!row) {
    throw new BillingError('CONFIG_MISSING', 'Billing config row is missing — run migration 05_billing.sql', 500);
  }
  return row;
}

function requireSupplierIdentity(config) {
  if (!config.supplier_gstin || !config.supplier_state_code) {
    throw new BillingError(
      'CONFIG_MISSING',
      'Supplier GSTIN and state code must be set in billing config before issuing documents',
      400,
    );
  }
}

/**
 * Validate the issue/preview payload and derive every computed field. Pure (no
 * DB) apart from the config passed in. Returns the full row-shaped object ready
 * for insert, minus the document_number / id which the transaction assigns.
 */
function buildDocumentDraft(body, config) {
  const documentType = body && body.document_type;
  if (documentType !== 'tax_invoice' && documentType !== 'receipt') {
    throw new BillingError('VALIDATION_ERROR', "document_type must be 'tax_invoice' or 'receipt'");
  }

  const client = (body && body.client) || {};
  const clientLegalName = String(client.legal_name ?? '').trim();
  const clientBillingAddress = String(client.billing_address ?? '').trim();
  if (!clientLegalName) throw new BillingError('VALIDATION_ERROR', 'client.legal_name is required');
  if (!clientBillingAddress) throw new BillingError('VALIDATION_ERROR', 'client.billing_address is required');

  const { lineItems, taxableValue } = normaliseLineItems(body.line_items, {
    defaultSacCode: config.default_sac_code,
  });

  let clientGstin = client.gstin ? String(client.gstin).trim().toUpperCase() : null;
  let clientStateCode = client.state_code ? String(client.state_code).trim() : null;
  let placeOfSupply;
  let gstRate;

  if (documentType === 'tax_invoice') {
    if (!clientGstin) {
      throw new BillingError('GSTIN_REQUIRED', 'A client GSTIN is required for a tax invoice', 422);
    }
    if (!isValidGstin(clientGstin)) {
      // Never silently fall back to receipt mode.
      throw new BillingError('GSTIN_INVALID', 'The client GSTIN failed format validation', 422);
    }
    clientStateCode = clientGstin.slice(0, 2);
    placeOfSupply = String(body.place_of_supply_state_code ?? clientStateCode).trim();
    gstRate = body.gst_rate != null ? Number(body.gst_rate) : Number(config.default_gst_rate);
    if (!Number.isFinite(gstRate) || gstRate < 0) {
      throw new BillingError('VALIDATION_ERROR', 'A valid gst_rate (or billing_config.default_gst_rate) is required');
    }
  } else {
    // Receipt: no GST. Place of supply still satisfies the NOT NULL column.
    if (clientGstin && !isValidGstin(clientGstin)) clientGstin = null; // optional + lenient on receipts
    if (clientGstin) clientStateCode = clientGstin.slice(0, 2);
    placeOfSupply = String(
      body.place_of_supply_state_code ?? clientStateCode ?? config.supplier_state_code,
    ).trim();
    gstRate = null;
  }

  const tax = computeTaxBreakup({
    documentType,
    taxableValue,
    gstRate,
    supplierStateCode: config.supplier_state_code,
    placeOfSupplyStateCode: placeOfSupply,
  });

  return {
    document_type: documentType,
    client_id: client.id || null,
    client_kind: client.kind === 'school' || client.kind === 'medical' ? client.kind : null,
    client_cluster_id: client.cluster_id || null,
    client_legal_name: clientLegalName,
    client_gstin: clientGstin,
    client_billing_address: clientBillingAddress,
    client_state_code: clientStateCode,
    supplier_gstin: config.supplier_gstin,
    supplier_state_code: config.supplier_state_code,
    place_of_supply_state_code: placeOfSupply,
    line_items: lineItems,
    taxable_value: taxableValue,
    gst_rate: gstRate,
    ...tax,
  };
}

// ─── GET /config — supplier + defaults (drives the frontend form) ────────────
router.get('/config', async (req, res) => {
  try {
    const config = await loadConfig();
    return sendResponse(res, 200, config);
  } catch (err) {
    return failBilling(res, err, 'GET /config');
  }
});

// ─── PUT /config — update supplier identity / defaults ───────────────────────
router.put('/config', async (req, res) => {
  try {
    const b = req.body || {};
    const [row] = await sql`
      UPDATE billing_config SET
        supplier_legal_name = ${b.supplier_legal_name ?? null},
        supplier_gstin      = ${b.supplier_gstin ? String(b.supplier_gstin).trim().toUpperCase() : null},
        supplier_state_code = ${b.supplier_state_code ?? null},
        supplier_address    = ${b.supplier_address ?? null},
        supplier_logo_url   = ${b.supplier_logo_url ?? null},
        invoice_prefix      = COALESCE(${b.invoice_prefix ?? null}, invoice_prefix),
        default_gst_rate    = COALESCE(${b.default_gst_rate ?? null}, default_gst_rate),
        default_sac_code    = ${b.default_sac_code ?? null},
        updated_at          = now()
      WHERE id = 1
      RETURNING *
    `;
    return sendResponse(res, 200, row);
  } catch (err) {
    return failBilling(res, err, 'PUT /config');
  }
});

// ─── POST /documents/preview — compute totals without consuming a number ─────
router.post('/documents/preview', async (req, res) => {
  try {
    const config = await loadConfig();
    requireSupplierIdentity(config);
    const draft = buildDocumentDraft(req.body, config);
    return sendResponse(res, 200, {
      document_type: draft.document_type,
      line_items: draft.line_items,
      taxable_value: draft.taxable_value,
      cgst_rate: draft.cgst_rate,
      cgst_amount: draft.cgst_amount,
      sgst_rate: draft.sgst_rate,
      sgst_amount: draft.sgst_amount,
      igst_rate: draft.igst_rate,
      igst_amount: draft.igst_amount,
      total_amount: draft.total_amount,
      place_of_supply_state_code: draft.place_of_supply_state_code,
    });
  } catch (err) {
    return failBilling(res, err, 'POST /documents/preview');
  }
});

// ─── POST /documents/issue — number + persist + render, in one transaction ───
router.post('/documents/issue', async (req, res) => {
  try {
    const config = await loadConfig();
    requireSupplierIdentity(config);
    const draft = buildDocumentDraft(req.body, config);

    const issuedAt = new Date();
    const { fyFull, fyShort } = computeFinancialYear(issuedAt);
    const createdBy = req.superAdmin && req.superAdmin.id ? req.superAdmin.id : null;

    const inserted = await sql.begin(async (tx) => {
      // Ensure the counter row exists for this (FY, type) before locking it.
      await tx`
        INSERT INTO billing_document_counters (financial_year, document_type, last_number)
        VALUES (${fyFull}, ${draft.document_type}, 0)
        ON CONFLICT (financial_year, document_type) DO NOTHING
      `;
      // Row-level lock — serialises concurrent issuers for this counter.
      await tx`
        SELECT last_number FROM billing_document_counters
        WHERE financial_year = ${fyFull} AND document_type = ${draft.document_type}
        FOR UPDATE
      `;
      const [{ last_number: sequence }] = await tx`
        UPDATE billing_document_counters
        SET last_number = last_number + 1
        WHERE financial_year = ${fyFull} AND document_type = ${draft.document_type}
        RETURNING last_number
      `;

      const documentNumber = formatDocumentNumber({
        prefix: config.invoice_prefix || 'NEX',
        fyShort,
        documentType: draft.document_type,
        sequence,
      });

      // Pre-generate the id so pdf_url is set at INSERT time — the immutability
      // trigger forbids post-issue UPDATEs to an issued row.
      const [{ id }] = await tx`SELECT gen_random_uuid() AS id`;
      const pdfUrl = `/api/super-admin/billing/documents/${id}/document.html`;

      const [row] = await tx`
        INSERT INTO billing_documents (
          id, document_number, document_type, financial_year,
          client_id, client_kind, client_cluster_id,
          client_legal_name, client_gstin, client_billing_address, client_state_code,
          supplier_gstin, supplier_state_code, place_of_supply_state_code,
          line_items, taxable_value,
          cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount,
          total_amount, status, pdf_url, issued_at, created_by
        ) VALUES (
          ${id}, ${documentNumber}, ${draft.document_type}, ${fyFull},
          ${draft.client_id}, ${draft.client_kind}, ${draft.client_cluster_id},
          ${draft.client_legal_name}, ${draft.client_gstin}, ${draft.client_billing_address}, ${draft.client_state_code},
          ${draft.supplier_gstin}, ${draft.supplier_state_code}, ${draft.place_of_supply_state_code},
          ${tx.json(draft.line_items)}, ${draft.taxable_value},
          ${draft.cgst_rate}, ${draft.cgst_amount}, ${draft.sgst_rate}, ${draft.sgst_amount}, ${draft.igst_rate}, ${draft.igst_amount},
          ${draft.total_amount}, 'issued', ${pdfUrl}, ${issuedAt.toISOString()}, ${createdBy}
        )
        RETURNING *
      `;
      return row;
    });

    return sendResponse(res, 201, inserted);
  } catch (err) {
    return failBilling(res, err, 'POST /documents/issue');
  }
});

// ─── GET /documents — paginated + filterable list ────────────────────────────
router.get('/documents', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 25));
    const offset = (page - 1) * pageSize;

    const fy = req.query.financial_year ? String(req.query.financial_year) : null;
    const docType = req.query.document_type ? String(req.query.document_type) : null;
    const status = req.query.status ? String(req.query.status) : null;
    const clientId = req.query.client_id ? String(req.query.client_id) : null;

    const rows = await sql`
      SELECT id, document_number, document_type, financial_year,
             client_id, client_legal_name, client_gstin,
             taxable_value, total_amount, status, pdf_url, issued_at, created_at
      FROM billing_documents
      WHERE (${fy}::text IS NULL OR financial_year = ${fy})
        AND (${docType}::text IS NULL OR document_type = ${docType})
        AND (${status}::text IS NULL OR status = ${status})
        AND (${clientId}::uuid IS NULL OR client_id = ${clientId}::uuid)
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM billing_documents
      WHERE (${fy}::text IS NULL OR financial_year = ${fy})
        AND (${docType}::text IS NULL OR document_type = ${docType})
        AND (${status}::text IS NULL OR status = ${status})
        AND (${clientId}::uuid IS NULL OR client_id = ${clientId}::uuid)
    `;
    return sendResponse(res, 200, { data: rows, page, page_size: pageSize, total: count });
  } catch (err) {
    return failBilling(res, err, 'GET /documents');
  }
});

// ─── GET /documents/:id — full detail ────────────────────────────────────────
router.get('/documents/:id', async (req, res) => {
  try {
    const [row] = await sql`SELECT * FROM billing_documents WHERE id = ${req.params.id}::uuid`;
    if (!row) return sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'No billing document with that id');
    return sendResponse(res, 200, row);
  } catch (err) {
    return failBilling(res, err, 'GET /documents/:id');
  }
});

// ─── POST /documents/:id/cancel — status -> cancelled (never delete) ─────────
router.post('/documents/:id/cancel', async (req, res) => {
  try {
    const [existing] = await sql`SELECT status FROM billing_documents WHERE id = ${req.params.id}::uuid`;
    if (!existing) return sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'No billing document with that id');
    if (existing.status === 'cancelled') {
      return sendError(res, 409, 'ALREADY_CANCELLED', 'This document is already cancelled');
    }
    const [row] = await sql`
      UPDATE billing_documents SET status = 'cancelled'
      WHERE id = ${req.params.id}::uuid
      RETURNING *
    `;
    return sendResponse(res, 200, row);
  } catch (err) {
    return failBilling(res, err, 'POST /documents/:id/cancel');
  }
});

// ─── GET /documents/:id/document.html — print-ready artifact (the "pdf_url") ──
router.get('/documents/:id/document.html', async (req, res) => {
  try {
    const [row] = await sql`SELECT * FROM billing_documents WHERE id = ${req.params.id}::uuid`;
    if (!row) return sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'No billing document with that id');
    const config = await loadConfig();
    let html;
    try {
      html = renderDocumentHtml({
        ...row,
        supplier_legal_name: config.supplier_legal_name,
        supplier_address: config.supplier_address,
        supplier_logo_url: config.supplier_logo_url,
      });
    } catch (renderErr) {
      console.error(`[billing] document.html :: PDF_RENDER_FAILED :: ${renderErr && renderErr.stack ? renderErr.stack : renderErr}`);
      return sendError(res, 500, 'PDF_RENDER_FAILED', 'Failed to render the billing document');
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return failBilling(res, err, 'GET /documents/:id/document.html');
  }
});

module.exports = router;

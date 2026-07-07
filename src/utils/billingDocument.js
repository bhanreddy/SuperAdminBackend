/**
 * Billing document helpers — financial-year math, GSTIN validation, GST tax
 * computation, document-number formatting, and a dependency-free print-ready
 * HTML renderer used as the "PDF" artifact.
 *
 * Intentionally pure (no DB, no Express) so it is unit-testable in isolation and
 * reusable by both the issue flow and the live-preview endpoint.
 */

const { defaultLogoDataUri } = require('./brandLogo');

// GSTIN: 2-digit state code + 5 alpha (PAN) + 4 digit + 1 alpha + 1 entity char + 'Z' + 1 checksum.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** Typed error so callers can map a stable `code` to an HTTP response. */
class BillingError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Indian financial year = 1 April → 31 March.
 * @returns {{ fyFull: string, fyShort: string }} e.g. { fyFull: '2026-27', fyShort: '26-27' }
 */
function computeFinancialYear(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new BillingError('VALIDATION_ERROR', 'Invalid date supplied for financial-year computation');
  }
  const month = d.getUTCMonth(); // 0 = Jan
  const year = d.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1; // Jan–Mar belong to the previous FY
  const endYear = startYear + 1;
  const fyFull = `${startYear}-${String(endYear).slice(-2)}`;
  const fyShort = `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`;
  return { fyFull, fyShort };
}

function isValidGstin(gstin) {
  return typeof gstin === 'string' && GSTIN_REGEX.test(gstin.trim());
}

/** Format the human-facing document number, e.g. NEX/26-27/TI/0001. */
function formatDocumentNumber({ prefix, fyShort, documentType, sequence }) {
  const typeSeg = documentType === 'tax_invoice' ? 'TI' : 'RCT';
  const padded = String(sequence).padStart(4, '0');
  return `${prefix}/${fyShort}/${typeSeg}/${padded}`;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Validate + normalise the line items array.
 * @returns {{ lineItems: Array, taxableValue: number }}
 */
function normaliseLineItems(rawItems, { defaultSacCode } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new BillingError('VALIDATION_ERROR', 'At least one line item is required');
  }
  const lineItems = rawItems.map((item, idx) => {
    const description = String(item?.description ?? '').trim();
    if (!description) {
      throw new BillingError('VALIDATION_ERROR', `Line item ${idx + 1} is missing a description`);
    }
    const quantity = Number(item?.quantity);
    const rate = Number(item?.rate);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BillingError('VALIDATION_ERROR', `Line item ${idx + 1} has an invalid quantity`);
    }
    if (!Number.isFinite(rate) || rate < 0) {
      throw new BillingError('VALIDATION_ERROR', `Line item ${idx + 1} has an invalid rate`);
    }
    const amount = round2(quantity * rate);
    return {
      description,
      sac_code: String(item?.sac_code ?? defaultSacCode ?? '').trim() || null,
      quantity,
      rate: round2(rate),
      amount,
    };
  });
  const taxableValue = round2(lineItems.reduce((sum, li) => sum + li.amount, 0));
  return { lineItems, taxableValue };
}

/**
 * Compute the GST breakup.
 *
 * Receipts carry no tax: taxable_value == total_amount, all tax fields null.
 *
 * Tax invoices: intra-state (supplier state == place of supply) → CGST + SGST,
 * each at half the rate; inter-state → IGST at the full rate.
 *
 * @returns the full set of tax columns + total_amount.
 */
function computeTaxBreakup({
  documentType,
  taxableValue,
  gstRate,
  supplierStateCode,
  placeOfSupplyStateCode,
}) {
  if (documentType === 'receipt') {
    return {
      cgst_rate: null,
      cgst_amount: null,
      sgst_rate: null,
      sgst_amount: null,
      igst_rate: null,
      igst_amount: null,
      total_amount: round2(taxableValue),
    };
  }

  const rate = Number(gstRate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new BillingError('VALIDATION_ERROR', 'A valid GST rate is required for a tax invoice');
  }

  const intraState = String(supplierStateCode) === String(placeOfSupplyStateCode);
  if (intraState) {
    const halfRate = round2(rate / 2);
    const halfAmount = round2(taxableValue * (rate / 2 / 100));
    return {
      cgst_rate: halfRate,
      cgst_amount: halfAmount,
      sgst_rate: halfRate,
      sgst_amount: halfAmount,
      igst_rate: null,
      igst_amount: null,
      total_amount: round2(taxableValue + halfAmount * 2),
    };
  }

  const igstAmount = round2(taxableValue * (rate / 100));
  return {
    cgst_rate: null,
    cgst_amount: null,
    sgst_rate: null,
    sgst_amount: null,
    igst_rate: round2(rate),
    igst_amount: igstAmount,
    total_amount: round2(taxableValue + igstAmount),
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(n) {
  if (n === null || n === undefined) return '';
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Render a self-contained, print-ready A4 HTML document.
 *
 * This is the "PDF" artifact: it opens, prints (browser print-to-PDF) and shares
 * with zero binary dependency on the backend host. To emit a true binary PDF
 * later, swap this single function for pdfkit/puppeteer behind the same call
 * site — nothing else in the flow changes.
 *
 * TODO(Bhanu): confirm SAC code + whether the GST e-invoicing turnover threshold
 * applies to NexSyrus's volume with your CA before the first PRODUCTION invoice.
 */
/** Indian-format amount in words, e.g. 110000 -> "One Lakh Ten Thousand Rupees Only". */
function amountInWords(amount) {
  const value = Number(amount) || 0;
  const rupees = Math.floor(value);
  const paise = Math.round((value - rupees) * 100);
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''));
  const three = (n) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return (h ? ones[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : '');
  };
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  let n = rupees;
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  let words = '';
  if (crore) words += three(crore) + ' Crore ';
  if (lakh) words += two(lakh) + ' Lakh ';
  if (thousand) words += two(thousand) + ' Thousand ';
  if (n) words += three(n) + ' ';
  words = (words.trim() || 'Zero') + ' Rupees';
  if (paise) words += ' and ' + two(paise) + ' Paise';
  return words + ' Only';
}

function renderDocumentHtml(doc) {
  const isTax = doc.document_type === 'tax_invoice';
  const title = isTax ? 'Tax Invoice' : 'Payment Receipt';

  const itemRows = (doc.line_items || [])
    .map(
      (li, i) => `
        <tr>
          <td class="num idx">${i + 1}</td>
          <td><span class="desc">${escapeHtml(li.description)}</span>${li.sac_code ? `<div class="sac">SAC ${escapeHtml(li.sac_code)}</div>` : ''}</td>
          <td class="num">${escapeHtml(li.quantity)}</td>
          <td class="num">${formatMoney(li.rate)}</td>
          <td class="num strong">${formatMoney(li.amount)}</td>
        </tr>`,
    )
    .join('');

  const taxRows = isTax
    ? doc.igst_amount != null
      ? `<tr><td>IGST <span class="muted">@ ${doc.igst_rate}%</span></td><td class="num">${formatMoney(doc.igst_amount)}</td></tr>`
      : `<tr><td>CGST <span class="muted">@ ${doc.cgst_rate}%</span></td><td class="num">${formatMoney(doc.cgst_amount)}</td></tr>
         <tr><td>SGST <span class="muted">@ ${doc.sgst_rate}%</span></td><td class="num">${formatMoney(doc.sgst_amount)}</td></tr>`
    : '';

  const issuedDate = doc.issued_at
    ? new Date(doc.issued_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';

  const supplierName = doc.supplier_legal_name || 'NexSyrus';
  const monogram =
    supplierName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'N';
  const words = amountInWords(doc.total_amount);
  const isCancelled = doc.status === 'cancelled';
  const logo = doc.supplier_logo_url || defaultLogoDataUri();
  const generatedAt = new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const totalLabel = isCancelled ? 'Total (Cancelled)' : isTax ? 'Amount Payable' : 'Amount Received';
  const documentTone = isTax ? 'GST compliant SaaS invoice' : 'Premium payment receipt';
  const statusLabel = isCancelled ? 'Cancelled' : isTax ? 'Original for Recipient' : 'Paid';
  const supplyLabel = isTax
    ? `Place of supply: State ${doc.place_of_supply_state_code || '-'}`
    : 'Receipt issued against payment confirmation';
  const logoSrc = logo ? escapeHtml(logo) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(doc.document_number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  :root {
    --brand: #4F46E5;
    --brand-2: #8B5CF6;
    --brand-3: #22D3EE;
    --ink: #0F172A;
    --ink-soft: #334155;
    --muted: #64748B;
    --line: #E5E7F0;
    --tint: #F8F7FF;
    --cream: #FFFBF4;
    --ok: #0E9F6E;
    --danger: #E11D48;
  }
  * { box-sizing: border-box; }
  @page { size: A4; margin: 0; }
  html { min-height: 100%; }
  body {
    font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); margin: 0; padding: 10px;
    background:
      radial-gradient(900px 500px at 85% -10%, rgba(139,92,246,0.20) 0%, rgba(139,92,246,0) 60%),
      radial-gradient(900px 520px at -10% 95%, rgba(34,211,238,0.18) 0%, rgba(34,211,238,0) 56%),
      linear-gradient(135deg, #F6F7FB 0%, #ECEFF7 100%);
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1, 'cv01' 1;
  }
  .sheet {
    width: min(100%, 210mm); min-height: 297mm; margin: 28px auto; background: #fff; position: relative;
    border-radius: 28px; overflow: hidden; border: 1px solid rgba(15,23,42,0.06);
    box-shadow:
      0 1px 0 rgba(255,255,255,0.9) inset,
      0 34px 90px rgba(30,41,59,0.20),
      0 8px 22px rgba(79,70,229,0.10);
  }
  .accent { height: 9px; background: linear-gradient(90deg, var(--brand), var(--brand-2) 52%, var(--brand-3)); }
  .sheet::before {
    content: ''; position: absolute; top: -140px; right: -120px; width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(124,111,255,0.12), rgba(124,111,255,0) 70%);
    pointer-events: none; z-index: 0;
  }
  .sheet::after {
    content: ''; position: absolute; bottom: -160px; left: -120px; width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(56,200,244,0.10), rgba(56,200,244,0) 70%);
    pointer-events: none; z-index: 0;
  }
  .pad { min-height: calc(297mm - 9px); padding: 42px 48px 38px; position: relative; z-index: 2; }
  .wm-logo {
    position: absolute; top: 50%; left: 50%; width: 460px; height: auto;
    transform: translate(-50%, -50%); opacity: 0.055; filter: grayscale(1);
    mix-blend-mode: multiply; pointer-events: none; z-index: 8;
  }
  .watermark {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 120px; font-weight: 800; color: rgba(244,63,94,0.10); letter-spacing: 14px;
    transform: rotate(-20deg); pointer-events: none; z-index: 9;
  }
  .logo-wrap {
    width: 60px; height: 60px; border-radius: 18px; flex-shrink: 0; background: #fff;
    border: 1px solid var(--line); padding: 7px; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 14px 34px rgba(30,41,59,0.12);
  }
  .logo-img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }

  /* Header */
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .supplier { display: flex; gap: 14px; align-items: flex-start; }
  .mono {
    width: 58px; height: 58px; border-radius: 18px; flex-shrink: 0;
    background: linear-gradient(135deg, var(--ink), var(--brand) 55%, var(--brand-2));
    color: #fff; font-weight: 800; font-size: 20px; letter-spacing: 0.5px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 14px 32px rgba(79,70,229,0.34);
  }
  .brand { font-size: 21px; font-weight: 800; letter-spacing: -0.45px; color: var(--ink); }
  .sup-line { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.5; white-space: pre-line; max-width: 320px; }
  .sup-gstin { font-size: 12px; color: var(--ink); font-weight: 600; margin-top: 4px; }

  .doc-meta { text-align: right; min-width: 220px; }
  .doc-pill {
    display: inline-block; padding: 8px 16px; border-radius: 999px; font-size: 11px;
    font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; color: #fff;
    background: linear-gradient(135deg, var(--ink), var(--brand), var(--brand-2));
    box-shadow: 0 10px 24px rgba(79,70,229,0.24);
  }
  .doc-pill.receipt { background: linear-gradient(135deg, #0E7490, #38C8F4); }
  .meta-tbl { margin-top: 14px; margin-left: auto; border-collapse: collapse; }
  .meta-tbl td { padding: 3px 0; font-size: 12px; }
  .meta-tbl td.k { color: var(--muted); text-align: right; padding-right: 12px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 10px; }
  .meta-tbl td.v { color: var(--ink); font-weight: 700; text-align: right; }

  .hero {
    display: flex; align-items: stretch; justify-content: space-between; gap: 24px;
    margin: 30px 0 16px; padding: 26px; border-radius: 24px; position: relative; overflow: hidden;
    background:
      linear-gradient(135deg, rgba(15,23,42,0.96), rgba(49,46,129,0.94) 52%, rgba(79,70,229,0.90)),
      radial-gradient(circle at 92% 18%, rgba(34,211,238,0.34), rgba(34,211,238,0) 34%);
    color: #fff; box-shadow: 0 22px 44px rgba(30,41,59,0.22);
  }
  .hero::after {
    content: ''; position: absolute; right: -55px; top: -70px; width: 210px; height: 210px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.20);
  }
  .eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: 1.8px; color: rgba(255,255,255,0.66); font-weight: 800; }
  .hero h1 { margin: 7px 0 7px; font-size: 34px; line-height: 1; letter-spacing: -1.4px; }
  .hero p { margin: 0; font-size: 12px; color: rgba(255,255,255,0.72); font-weight: 500; }
  .hero-total {
    min-width: 238px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end;
    padding-left: 24px; border-left: 1px solid rgba(255,255,255,0.18); position: relative; z-index: 1;
  }
  .hero-total span { font-size: 10px; text-transform: uppercase; letter-spacing: 1.4px; color: rgba(255,255,255,0.68); font-weight: 800; }
  .hero-total strong { margin-top: 8px; font-size: 30px; line-height: 1; letter-spacing: -1px; }
  .stat-grid { display: grid; grid-template-columns: 1.25fr 0.85fr 0.9fr; gap: 10px; margin-bottom: 18px; }
  .stat {
    border: 1px solid var(--line); background: linear-gradient(180deg, #FFFFFF 0%, #FBFBFF 100%);
    border-radius: 16px; padding: 12px 14px; min-width: 0;
  }
  .stat span { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 1.1px; color: var(--muted); font-weight: 800; margin-bottom: 5px; }
  .stat strong { display: block; font-size: 12px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Parties */
  .parties { display: flex; gap: 16px; }
  .party {
    flex: 1; position: relative; background: linear-gradient(180deg, #FFFFFF 0%, #FCFCFF 100%);
    border: 1px solid var(--line); border-radius: 18px; padding: 18px 20px 18px 24px; overflow: hidden;
    box-shadow: 0 10px 24px rgba(30,41,59,0.06);
  }
  .party::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
    background: linear-gradient(180deg, var(--brand), var(--brand-2));
  }
  .party.alt::before { background: linear-gradient(180deg, #1E9BC7, #38C8F4); }
  .ptitle { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--brand); font-weight: 800; margin-bottom: 8px; }
  .party.alt .ptitle { color: #1E9BC7; }
  .pname { font-weight: 800; font-size: 15px; letter-spacing: -0.15px; }
  .pline { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.5; white-space: pre-line; }
  .pgstin { font-size: 12px; color: var(--ink); font-weight: 600; margin-top: 5px; }

  /* Items */
  table.items {
    width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 26px;
    border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
  }
  table.items thead th {
    background: linear-gradient(135deg, #111827, #312E81); color: #fff; text-align: left; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.9px; padding: 13px 14px; font-weight: 700;
  }
  table.items td { padding: 14px; font-size: 13px; border-bottom: 1px solid var(--line); vertical-align: top; background: rgba(255,255,255,0.88); }
  table.items tbody tr:nth-child(even) td { background: #FAFAFE; }
  table.items tbody tr:last-child td { border-bottom: none; }
  .num { text-align: right; }
  .idx { color: var(--muted); }
  .desc { font-weight: 600; }
  .strong { font-weight: 700; }
  .sac { font-size: 10px; color: var(--muted); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
  .muted { color: var(--muted); font-weight: 500; }

  /* Summary */
  .summary { display: flex; gap: 20px; margin-top: 24px; align-items: flex-start; }
  .words {
    flex: 1; background: linear-gradient(135deg, var(--cream), #FFFFFF);
    border: 1px solid #F4E7C5; border-radius: 16px; padding: 17px 18px;
  }
  .words .wlabel { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); font-weight: 700; margin-bottom: 5px; }
  .words .wval { font-size: 13px; font-weight: 600; color: var(--ink); line-height: 1.5; }
  .totals {
    width: 310px; flex-shrink: 0; padding: 10px; border-radius: 18px;
    background: #fff; border: 1px solid var(--line); box-shadow: 0 12px 26px rgba(30,41,59,0.07);
  }
  .totals .trow { display: flex; justify-content: space-between; padding: 7px 6px; font-size: 13px; color: var(--ink); }
  .totals .trow .muted { color: var(--muted); }
  .grand {
    display: flex; justify-content: space-between; align-items: center; margin-top: 8px;
    background: linear-gradient(135deg, var(--ink), var(--brand), var(--brand-2)); color: #fff;
    padding: 15px 18px; border-radius: 14px; box-shadow: 0 14px 30px rgba(79,70,229,0.30);
  }
  .grand .glabel { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; opacity: 0.9; }
  .grand .gval { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }

  /* Sign + footer */
  .sign { display: flex; justify-content: flex-end; margin-top: 42px; }
  .sign-box { text-align: center; min-width: 228px; padding: 16px 18px 0; border-radius: 18px; background: linear-gradient(180deg, rgba(248,247,255,0.85), rgba(255,255,255,0)); }
  .sign-line { border-top: 1.5px solid var(--ink); margin-top: 38px; padding-top: 8px; font-size: 12px; color: var(--muted); }
  .sign-for { font-size: 12px; color: var(--ink); font-weight: 700; }
  .footer { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 16px; font-size: 11px; color: var(--muted); line-height: 1.6; }
  .footer .thanks { color: var(--brand); font-weight: 700; }
  .foot-strip {
    display: flex; justify-content: space-between; gap: 16px; margin-top: 30px;
    padding: 12px 16px; background: linear-gradient(135deg, var(--tint), #F0FDFF);
    border: 1px solid var(--line); border-radius: 14px; font-size: 10.5px; color: var(--muted);
  }
  .foot-strip b { color: var(--ink-soft); font-weight: 700; }

  /* Status seal */
  .seal {
    position: absolute; right: 58px; bottom: 142px; width: 116px; height: 116px; border-radius: 50%;
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
    border: 2.5px solid var(--ok); color: var(--ok); transform: rotate(-12deg); opacity: 0.9;
    z-index: 4; pointer-events: none; box-shadow: inset 0 0 0 4px rgba(14,159,110,0.10), 0 12px 30px rgba(14,159,110,0.12);
    font-weight: 800; letter-spacing: 1.5px; font-size: 16px; text-transform: uppercase;
  }
  .seal.brand { border-color: var(--brand); color: var(--brand); box-shadow: inset 0 0 0 4px rgba(91,78,209,0.10); }
  .seal small { font-size: 7px; letter-spacing: 1px; opacity: 0.85; margin-top: 4px; font-weight: 700; }

  @media print {
    html, body { width: 210mm; min-height: 297mm; background: #fff; padding: 0; overflow: hidden; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sheet {
      width: 210mm; min-height: 297mm; margin: 0; box-shadow: none; border-radius: 0;
      max-width: none; border: none; overflow: hidden; page-break-after: avoid;
    }
    .pad { min-height: calc(297mm - 9px); padding: 10mm 12mm 9mm; }
    .sheet::before, .sheet::after { display: none; }
    .accent, .grand, .hero, .stat, .words, .mono, .doc-pill, .logo-wrap, .wm-logo, .party::before, .seal,
    table.items thead th {
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .head { gap: 16px; }
    .logo-wrap { width: 14mm; height: 14mm; border-radius: 4mm; }
    .brand { font-size: 18px; }
    .sup-line, .sup-gstin, .pline, .pgstin { font-size: 10.5px; line-height: 1.38; }
    .doc-meta { min-width: 48mm; }
    .meta-tbl { margin-top: 8px; }
    .meta-tbl td { font-size: 10.5px; }
    .hero { margin: 7mm 0 4mm; padding: 7mm; border-radius: 6mm; box-shadow: none; }
    .hero h1 { font-size: 28px; margin: 5px 0; }
    .hero p { font-size: 10.5px; }
    .hero-total { min-width: 56mm; padding-left: 7mm; }
    .hero-total strong { font-size: 26px; }
    .stat-grid { gap: 8px; margin-bottom: 5mm; }
    .stat { padding: 8px 10px; border-radius: 4mm; }
    .parties { gap: 10px; }
    .party { padding: 12px 13px 12px 16px; border-radius: 4mm; }
    table.items { margin-top: 6mm; border-radius: 4mm; }
    table.items thead th { padding: 9px 10px; font-size: 9px; }
    table.items td { padding: 8px 10px; font-size: 11px; }
    .summary { gap: 12px; margin-top: 6mm; }
    .words { padding: 11px 12px; border-radius: 4mm; }
    .words .wval { font-size: 11px; line-height: 1.38; }
    .totals { width: 78mm; padding: 8px; border-radius: 4mm; }
    .totals .trow { padding: 5px 4px; font-size: 11px; }
    .grand { padding: 10px 12px; border-radius: 4mm; }
    .grand .gval { font-size: 18px; }
    .sign { margin-top: 8mm; }
    .sign-box { min-width: 56mm; padding-top: 10px; }
    .sign-line { margin-top: 9mm; }
    .footer { margin-top: 5mm; padding-top: 4mm; font-size: 9.5px; line-height: 1.45; }
    .foot-strip { margin-top: 5mm; padding: 8px 10px; font-size: 9px; border-radius: 4mm; }
    .seal { right: 14mm; bottom: 34mm; width: 28mm; height: 28mm; font-size: 13px; }
    .hero, .stat-grid, .parties, table.items, .summary, .sign, .footer, .foot-strip {
      break-inside: avoid; page-break-inside: avoid;
    }
    .totals, .party, .logo-wrap { box-shadow: none; }
  }
  @media (max-width: 720px) {
    body { padding: 0; }
    .sheet { margin: 0; border-radius: 0; }
    .pad { padding: 30px 22px; }
    .head, .hero, .parties, .summary { flex-direction: column; }
    .doc-meta { text-align: left; min-width: 0; }
    .meta-tbl { margin-left: 0; }
    .meta-tbl td.k, .meta-tbl td.v { text-align: left; }
    .hero-total { align-items: flex-start; border-left: 0; border-top: 1px solid rgba(255,255,255,0.18); padding: 18px 0 0; min-width: 0; }
    .stat-grid { grid-template-columns: 1fr; }
    .totals { width: 100%; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="accent"></div>
    ${logoSrc ? `<img class="wm-logo" src="${logoSrc}" alt="" />` : ''}
    ${isCancelled ? '<div class="watermark">CANCELLED</div>' : ''}
    <div class="pad">
      <div class="head">
        <div class="supplier">
          ${logoSrc
            ? `<div class="logo-wrap"><img class="logo-img" src="${logoSrc}" alt="${escapeHtml(supplierName)}" /></div>`
            : `<div class="mono">${escapeHtml(monogram)}</div>`}
          <div>
            <div class="brand">${escapeHtml(supplierName)}</div>
            ${doc.supplier_address ? `<div class="sup-line">${escapeHtml(doc.supplier_address)}</div>` : ''}
            ${doc.supplier_gstin ? `<div class="sup-gstin">GSTIN ${escapeHtml(doc.supplier_gstin)}</div>` : ''}
          </div>
        </div>
        <div class="doc-meta">
          <span class="doc-pill ${isTax ? 'tax' : 'receipt'}">${title}</span>
          <table class="meta-tbl">
            <tr><td class="k">Number</td><td class="v">${escapeHtml(doc.document_number)}</td></tr>
            <tr><td class="k">Date</td><td class="v">${escapeHtml(issuedDate)}</td></tr>
            <tr><td class="k">FY</td><td class="v">${escapeHtml(doc.financial_year)}</td></tr>
            ${isTax ? `<tr><td class="k">Place of Supply</td><td class="v">State ${escapeHtml(doc.place_of_supply_state_code)}</td></tr>` : ''}
          </table>
        </div>
      </div>

      <div class="hero">
        <div>
          <div class="eyebrow">${escapeHtml(documentTone)}</div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(supplyLabel)}</p>
        </div>
        <div class="hero-total">
          <span>${escapeHtml(totalLabel)}</span>
          <strong>${formatMoney(doc.total_amount)}</strong>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat">
          <span>Document</span>
          <strong>${escapeHtml(doc.document_number)}</strong>
        </div>
        <div class="stat">
          <span>Status</span>
          <strong>${escapeHtml(statusLabel)}</strong>
        </div>
        <div class="stat">
          <span>Issued</span>
          <strong>${escapeHtml(issuedDate || '-')}</strong>
        </div>
      </div>

      <div class="parties">
        <div class="party">
          <div class="ptitle">Billed To</div>
          <div class="pname">${escapeHtml(doc.client_legal_name)}</div>
          <div class="pline">${escapeHtml(doc.client_billing_address)}</div>
          ${doc.client_gstin ? `<div class="pgstin">GSTIN ${escapeHtml(doc.client_gstin)}</div>` : ''}
        </div>
        <div class="party alt">
          <div class="ptitle">${isTax ? 'Supplier' : 'Received By'}</div>
          <div class="pname">${escapeHtml(supplierName)}</div>
          ${doc.supplier_gstin ? `<div class="pgstin">GSTIN ${escapeHtml(doc.supplier_gstin)}</div>` : ''}
          ${doc.supplier_state_code ? `<div class="pline">State code ${escapeHtml(doc.supplier_state_code)}</div>` : ''}
        </div>
      </div>

      <table class="items">
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Description</th>
            <th class="num">Qty</th>
            <th class="num">Rate</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div class="summary">
        <div class="words">
          <div class="wlabel">Amount in words</div>
          <div class="wval">${escapeHtml(words)}</div>
        </div>
        <div class="totals">
          <div class="trow"><span class="muted">${isTax ? 'Taxable value' : 'Subtotal'}</span><span>${formatMoney(doc.taxable_value)}</span></div>
          ${taxRows
            .replace(/<tr><td>/g, '<div class="trow"><span class="muted">')
            .replace(/<\/td><td class="num">/g, '</span><span>')
            .replace(/<\/td><\/tr>/g, '</span></div>')}
          <div class="grand">
            <span class="glabel">${totalLabel}</span>
            <span class="gval">${formatMoney(doc.total_amount)}</span>
          </div>
        </div>
      </div>

      ${isCancelled
        ? ''
        : isTax
          ? '<div class="seal brand">Original<small>For Recipient</small></div>'
          : '<div class="seal">Paid<small>Received with thanks</small></div>'}

      <div class="sign">
        <div class="sign-box">
          <div class="sign-for">For ${escapeHtml(supplierName)}</div>
          <div class="sign-line">Authorised Signatory</div>
        </div>
      </div>

      <div class="footer">
        ${isTax
          ? 'This is a GST tax invoice issued under Section 31 of the CGST Act, 2017. This is a computer-generated document and does not require a physical signature.'
          : 'This is a payment receipt and is not a GST tax invoice. No input tax credit may be claimed against this document. This is a computer-generated document.'}
        <br /><span class="thanks">Thank you for your business.</span>
      </div>

      <div class="foot-strip">
        <span>Document <b>${escapeHtml(doc.document_number)}</b></span>
        <span>Generated ${escapeHtml(generatedAt)}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  GSTIN_REGEX,
  BillingError,
  computeFinancialYear,
  isValidGstin,
  formatDocumentNumber,
  normaliseLineItems,
  computeTaxBreakup,
  renderDocumentHtml,
  round2,
};

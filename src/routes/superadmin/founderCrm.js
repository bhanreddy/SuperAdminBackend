const express = require('express');
const multer = require('multer');
const sql = require('../../config/db');
const crmSql = require('../../config/crmDb');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { requireCrmWrite, requireFinanceApproval, requireOrgSettings } = require('../../middleware/crmAccess');
const { imageKind } = require('../../utils/uploadBytes');
const { resolveCrmScope } = require('../../services/crm/accessPolicy');
const { sendCrmError } = require('../../services/crm/errors');
const sales = require('../../services/crm/salesCrm');
const { salesReport } = require('../../services/crm/reporting');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// All routes require super admin verification
router.use(verifySuperAdminMiddleware);

// ==========================================
// ANALYTICS
// ==========================================

router.get('/analytics', async (req, res) => {
  try {
    const [
      pendingRows,
      incomeRows,
      expenseV2Rows,
      expenseRoiRows,
    ] = await Promise.all([
      sql`
        SELECT 
          (SELECT COALESCE(sum(amount), 0) FROM collections WHERE status = 'APPROVED') AS approved_income,
          (SELECT COALESCE(sum(amount), 0) FROM collections WHERE status = 'PENDING') AS pending_collections,
          (SELECT COALESCE(sum(amount), 0) FROM expenses WHERE status = 'APPROVED' AND school_id IS NULL) AS approved_expenses,
          ((SELECT COALESCE(sum(amount), 0) FROM collections WHERE status = 'APPROVED') - 
           (SELECT COALESCE(sum(amount), 0) FROM expenses WHERE status = 'APPROVED' AND school_id IS NULL)) AS net_profit
        LIMIT 1
      `.catch(() => []),
      sql`SELECT * FROM monthly_income_summary ORDER BY year ASC, month ASC`.catch(() => []),
      sql`
        SELECT EXTRACT(year FROM created_at) AS year,
               EXTRACT(month FROM created_at) AS month,
               category,
               sum(amount) AS total_amount
        FROM expenses
        WHERE status = 'APPROVED' AND school_id IS NULL
        GROUP BY 1, 2, 3
        ORDER BY year ASC, month ASC
      `.catch(() => []),
      sql`
        SELECT EXTRACT(year FROM created_at) AS year,
               EXTRACT(month FROM created_at) AS month,
               sum(amount) AS total_amount
        FROM expenses
        WHERE status = 'APPROVED' AND school_id IS NULL
        GROUP BY 1, 2
        ORDER BY year ASC, month ASC
      `.catch(() => []),
    ]);

    const report = await salesReport(crmSql, resolveCrmScope(req.superAdmin), req.query);
    return sendResponse(res, 200, {
      pending: pendingRows.length > 0 ? pendingRows[0] : null,
      incomeRows,
      expenseV2Rows,
      expenseRoiRows,
      enquiryRows: report.source_conversion,
      closedDealsRows: report.outcomes_by_currency,
      conversionRows: [{ win_rate: report.win_rate, legacy_unknown_excluded: report.legacy_unknown_excluded }],
      costPerLeadRows: [],
      leadsByWebsiteRows: report.source_conversion,
      leadPerformanceRows: report.stage_aging,
      salesReport: report,
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ==========================================
// EXPENSES
// ==========================================

router.get('/expenses', async (req, res) => {
  try {
    const { status, category } = req.query;
    let rows;
    if (status && status !== 'ALL' && category && category !== 'ALL') {
      rows = await sql`
        SELECT id, title, description, amount, category, status, receipt_url,
               created_by_founder_id, approved_by_founder_id, rejection_reason,
               created_at, updated_at
        FROM expenses
        WHERE status = ${status} AND category = ${category} AND school_id IS NULL
        ORDER BY created_at DESC
      `;
    } else if (status && status !== 'ALL') {
      rows = await sql`
        SELECT id, title, description, amount, category, status, receipt_url,
               created_by_founder_id, approved_by_founder_id, rejection_reason,
               created_at, updated_at
        FROM expenses
        WHERE status = ${status} AND school_id IS NULL
        ORDER BY created_at DESC
      `;
    } else if (category && category !== 'ALL') {
      rows = await sql`
        SELECT id, title, description, amount, category, status, receipt_url,
               created_by_founder_id, approved_by_founder_id, rejection_reason,
               created_at, updated_at
        FROM expenses
        WHERE category = ${category} AND school_id IS NULL
        ORDER BY created_at DESC
      `;
    } else {
      rows = await sql`
        SELECT id, title, description, amount, category, status, receipt_url,
               created_by_founder_id, approved_by_founder_id, rejection_reason,
               created_at, updated_at
        FROM expenses
        WHERE school_id IS NULL
        ORDER BY created_at DESC
      `;
    }
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Error listing expenses:', err);
    return res.status(500).json({ error: 'Failed to list expenses' });
  }
});

router.post('/expenses', requireCrmWrite, async (req, res) => {
  try {
    const { title, description, amount, category, receipt_url } = req.body;
    if (!title || !amount || !category) {
      return res.status(400).json({ error: 'title, amount, and category are required' });
    }
    const [row] = await sql`
      INSERT INTO expenses (title, description, amount, category, receipt_url, status, created_by_founder_id)
      VALUES (${title}, ${description || null}, ${amount}, ${category}, ${receipt_url || null}, 'PENDING', ${req.superAdmin.founderId || null})
      RETURNING *
    `;
    return sendResponse(res, 201, row);
  } catch (err) {
    console.error('Error creating expense:', err);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

router.post('/expenses/:id/approve', requireFinanceApproval, async (req, res) => {
  try {
    const { id } = req.params;
    await sql`
      UPDATE expenses
      SET status = 'APPROVED', approved_by_founder_id = ${req.superAdmin.founderId || null}, rejection_reason = NULL
      WHERE id = ${id}
    `;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error approving expense:', err);
    return res.status(500).json({ error: 'Failed to approve expense' });
  }
});

router.post('/expenses/:id/reject', requireFinanceApproval, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await sql`
      UPDATE expenses
      SET status = 'REJECTED', approved_by_founder_id = ${req.superAdmin.founderId || null}, rejection_reason = ${reason || null}
      WHERE id = ${id}
    `;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error rejecting expense:', err);
    return res.status(500).json({ error: 'Failed to reject expense' });
  }
});

router.post('/expenses/:id/receipt', requireCrmWrite, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const sniffed = imageKind(req.file.buffer);
    if (!sniffed || sniffed.mime !== req.file.mimetype) {
      return res.status(400).json({ error: 'Receipt must be a png, jpeg, or webp image' });
    }
    const [expense] = await sql`SELECT id FROM expenses WHERE id = ${id}`;
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    const mimeType = sniffed.mime;
    const storagePath = `receipts/${id}.${sniffed.ext}`;

    const { error: uploadError } = await schoolSupabaseAdmin.storage
      .from('expense-receipts')
      .upload(storagePath, req.file.buffer, { contentType: mimeType, upsert: true });

    if (uploadError) throw uploadError;

    await sql`UPDATE expenses SET receipt_url = ${storagePath} WHERE id = ${id}`;

    return sendResponse(res, 200, { success: true, path: storagePath });
  } catch (err) {
    console.error('Error uploading receipt:', err);
    return res.status(500).json({ error: 'Failed to upload receipt' });
  }
});

router.get('/expenses/:id/receipt-url', async (req, res) => {
  try {
    const { id } = req.params;
    const expires = parseInt(req.query.expires) || 3600;

    const [expense] = await sql`SELECT receipt_url FROM expenses WHERE id = ${id}`;
    if (!expense || !expense.receipt_url) {
      return sendResponse(res, 200, { signedUrl: null });
    }

    if (expense.receipt_url.startsWith('http')) {
      return sendResponse(res, 200, { signedUrl: expense.receipt_url });
    }

    const { data, error } = await schoolSupabaseAdmin.storage
      .from('expense-receipts')
      .createSignedUrl(expense.receipt_url, expires);

    if (error) {
      return sendResponse(res, 200, { signedUrl: null });
    }
    return sendResponse(res, 200, { signedUrl: data.signedUrl });
  } catch (err) {
    console.error('Error getting receipt URL:', err);
    return res.status(500).json({ error: 'Failed to get receipt URL' });
  }
});

// ==========================================
// COLLECTIONS
// ==========================================

router.get('/collections', async (req, res) => {
  try {
    const { period, status, business_unit_id, page = '0', pageSize = '50' } = req.query;
    const pg = parseInt(page) || 0;
    const ps = parseInt(pageSize) || 50;
    const offset = pg * ps;

    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;

    let statusFilter = sql``;
    if (status && status !== 'ALL') {
      statusFilter = sql`AND c.status = ${status}`;
    }

    let unitFilter = sql``;
    if (business_unit_id && business_unit_id !== 'ALL') {
      unitFilter = sql`AND c.business_unit_id = ${business_unit_id}`;
    }

    let periodFilter = sql``;
    if (period === 'THIS_MONTH') {
      periodFilter = sql`AND c.year = ${y} AND c.month = ${m}`;
    } else if (period === 'LAST_MONTH') {
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      periodFilter = sql`AND c.year = ${ly} AND c.month = ${lm}`;
    } else if (period === 'THIS_YEAR') {
      periodFilter = sql`AND c.year = ${y}`;
    }

    const rows = await sql`
      SELECT c.*, bu.name AS business_unit_name, bu.code AS business_unit_code
      FROM collections c
      LEFT JOIN business_units bu ON c.business_unit_id = bu.id
      WHERE TRUE ${statusFilter} ${periodFilter} ${unitFilter}
      ORDER BY c.created_at DESC
      LIMIT ${ps} OFFSET ${offset}
    `;

    const [countResult] = await sql`
      SELECT COUNT(*) AS total FROM collections c
      WHERE TRUE ${statusFilter} ${periodFilter} ${unitFilter}
    `;

    const shaped = rows.map((r) => ({
      ...r,
      business_units: r.business_unit_name
        ? { name: r.business_unit_name, code: r.business_unit_code }
        : null,
    }));

    return sendResponse(res, 200, { rows: shaped, total: parseInt(countResult.total) || 0 });
  } catch (err) {
    console.error('Error listing collections:', err);
    return res.status(500).json({ error: 'Failed to list collections' });
  }
});

// Financial summary for the Founder Console. Business units currently own
// collections, not expenses, so expense totals deliberately remain platform-wide.
router.get('/financial-summary', async (req, res) => {
  try {
    const { period = 'THIS_MONTH', business_unit_id } = req.query;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    let collectionPeriod = sql``;
    let expensePeriod = sql``;
    let billingPeriod = sql``;

    if (period === 'THIS_MONTH') {
      collectionPeriod = sql`AND c.year = ${year} AND c.month = ${month}`;
      expensePeriod = sql`AND EXTRACT(YEAR FROM e.created_at) = ${year} AND EXTRACT(MONTH FROM e.created_at) = ${month}`;
      billingPeriod = sql`AND EXTRACT(YEAR FROM b.issued_at) = ${year} AND EXTRACT(MONTH FROM b.issued_at) = ${month}`;
    } else if (period === 'LAST_MONTH') {
      const lastMonth = month === 1 ? 12 : month - 1;
      const lastYear = month === 1 ? year - 1 : year;
      collectionPeriod = sql`AND c.year = ${lastYear} AND c.month = ${lastMonth}`;
      expensePeriod = sql`AND EXTRACT(YEAR FROM e.created_at) = ${lastYear} AND EXTRACT(MONTH FROM e.created_at) = ${lastMonth}`;
      billingPeriod = sql`AND EXTRACT(YEAR FROM b.issued_at) = ${lastYear} AND EXTRACT(MONTH FROM b.issued_at) = ${lastMonth}`;
    } else if (period === 'THIS_YEAR') {
      collectionPeriod = sql`AND c.year = ${year}`;
      expensePeriod = sql`AND EXTRACT(YEAR FROM e.created_at) = ${year}`;
      billingPeriod = sql`AND EXTRACT(YEAR FROM b.issued_at) = ${year}`;
    }

    const unitFilter = business_unit_id && business_unit_id !== 'ALL'
      ? sql`AND c.business_unit_id = ${business_unit_id}`
      : sql``;
    const [[revenue], [expenses], [billing]] = await Promise.all([
      sql`SELECT COALESCE(SUM(c.amount), 0) AS total FROM collections c WHERE c.status = 'APPROVED' ${collectionPeriod} ${unitFilter}`,
      sql`SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e WHERE e.status = 'APPROVED' AND e.school_id IS NULL ${expensePeriod}`,
      // Billing documents are marked issued only once the founder records the
      // client charge. Cancelled documents are excluded from collected money.
      sql`SELECT COALESCE(SUM(b.total_amount), 0) AS total FROM billing_documents b WHERE b.status = 'issued' ${billingPeriod}`,
    ]);
    const businessUnitCollections = Number(revenue.total || 0);
    const clientBillingCollected = Number(billing.total || 0);
    const totalRevenue = businessUnitCollections + clientBillingCollected;
    const totalExpenses = Number(expenses.total || 0);
    const netProfit = totalRevenue - totalExpenses;
    return sendResponse(res, 200, {
      period,
      business_unit_id: business_unit_id || 'ALL',
      revenue: totalRevenue,
      business_unit_collections: businessUnitCollections,
      client_billing_collected: clientBillingCollected,
      expenses: totalExpenses,
      net_profit: netProfit,
      profit_margin: totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : null,
      expenses_scope: 'platform',
    });
  } catch (err) {
    console.error('Error fetching financial summary:', err);
    return res.status(500).json({ error: 'Failed to fetch financial summary' });
  }
});

router.post('/collections', requireCrmWrite, async (req, res) => {
  try {
    const { business_unit_id, amount, month, year, payment_mode, notes } =
      req.body;
    if (!business_unit_id || !amount || !month || !year || !payment_mode) {
      return res
        .status(400)
        .json({ error: 'business_unit_id, amount, month, year, and payment_mode are required' });
    }

    const [row] = await sql`
      INSERT INTO collections (business_unit_id, amount, month, year, payment_mode, status, created_by_founder_id, notes)
      VALUES (${business_unit_id}, ${amount}, ${month}, ${year}, ${payment_mode}, 'PENDING', ${req.superAdmin.founderId || null}, ${notes || null})
      RETURNING *
    `;

    const [bu] = await sql`SELECT name, code FROM business_units WHERE id = ${business_unit_id}`;
    row.business_units = bu || null;

    return sendResponse(res, 201, row);
  } catch (err) {
    console.error('Error creating collection:', err);
    return res.status(500).json({ error: 'Failed to create collection' });
  }
});

router.post('/collections/:id/approve', requireFinanceApproval, async (req, res) => {
  try {
    const { id } = req.params;
    await sql`
      UPDATE collections
      SET status = 'APPROVED', approved_by_founder_id = ${req.superAdmin.founderId || null}, rejection_reason = NULL
      WHERE id = ${id}
    `;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error approving collection:', err);
    return res.status(500).json({ error: 'Failed to approve collection' });
  }
});

router.post('/collections/:id/reject', requireFinanceApproval, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await sql`
      UPDATE collections
      SET status = 'REJECTED', approved_by_founder_id = ${req.superAdmin.founderId || null}, rejection_reason = ${reason || null}
      WHERE id = ${id}
    `;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error rejecting collection:', err);
    return res.status(500).json({ error: 'Failed to reject collection' });
  }
});

// ==========================================
// ENQUIRIES
// ==========================================

router.get('/enquiries', async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    const owner = scope.kind === 'platform'
      ? (req.query.assignedTo && req.query.assignedTo !== 'ALL' && req.query.assignedTo !== 'UNASSIGNED' ? req.query.assignedTo : null)
      : scope.founderId;
    const legacyStatus = req.query.status && req.query.status !== 'ALL' ? req.query.status : null;
    const page = await sales.listLeads(crmSql, scope, {
      ...req.query,
      status: legacyStatus,
      owner,
      unassigned: scope.kind === 'platform' && req.query.assignedTo === 'UNASSIGNED',
      q: req.query.q,
      stage: req.query.stage,
      outcome: req.query.outcome,
      source: req.query.source && req.query.source !== 'ALL' ? req.query.source : null,
      category: req.query.category && req.query.category !== 'ALL' ? req.query.category : null,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    return sendResponse(res, 200, page);
  } catch (err) {
    return sendCrmError(res, err);
  }
});

router.get('/enquiries/stats', async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    const founderId = scope.kind === 'platform' ? null : scope.founderId;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [todayResult] = await crmSql`
      SELECT COUNT(*) AS count FROM enquiries
      WHERE created_at >= ${start.toISOString()}
        AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
    `;
    const [unassignedResult] = await crmSql`
      SELECT COUNT(*) AS count FROM enquiries
      WHERE assigned_to IS NULL
        AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
    `;
    return sendResponse(res, 200, {
      enquiriesToday: parseInt(todayResult.count, 10) || 0,
      unassignedEnquiries: scope.kind === 'platform' ? (parseInt(unassignedResult.count, 10) || 0) : 0,
    });
  } catch (err) {
    return sendCrmError(res, err);
  }
});

router.patch('/enquiries/:id', requireCrmWrite, async (req, res) => {
  try {
    const scope = resolveCrmScope(req.superAdmin);
    const lead = await sales.applyLegacyPatch(crmSql, scope, req.params.id, req.body || {});
    return sendResponse(res, 200, { success: true, lead });
  } catch (err) {
    return sendCrmError(res, err, { enquiry_id: req.params.id });
  }
});

// ==========================================
// BUSINESS UNITS
// ==========================================

const ALLOWED_BU_SUBSCRIPTION_PLANS = new Set(['FREE', 'STARTER', 'PRO', 'ENTERPRISE']);

function normalizeBuSubscriptionPlan(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toUpperCase();
  return ALLOWED_BU_SUBSCRIPTION_PLANS.has(s) ? s : null;
}

function normalizeBuPhone(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 32) return { error: 'phone must be at most 32 characters' };
  const digits = s.replace(/\D/g, '').length;
  if (digits < 7) return { error: 'phone must contain at least 7 digits' };
  return s;
}

router.get('/business-units', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    let rows;
    if (includeInactive) {
      rows = await sql`
        SELECT id, name, code, subscription_price, subscription_plan, phone, is_active, created_at
        FROM business_units ORDER BY name ASC`;
    } else {
      rows = await sql`
        SELECT id, name, code, subscription_price, subscription_plan, phone, is_active, created_at
        FROM business_units WHERE is_active = true ORDER BY name ASC`;
    }
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Error listing business units:', err);
    return res.status(500).json({ error: 'Failed to list business units' });
  }
});

router.post('/business-units', requireCrmWrite, async (req, res) => {
  try {
    const { name, code, subscription_price, subscription_plan, phone } = req.body;
    const nameTrim = name != null ? String(name).trim() : '';
    if (!nameTrim) return res.status(400).json({ error: 'name is required' });
    const codeTrim = code != null ? String(code).trim() : '';
    if (!codeTrim) return res.status(400).json({ error: 'code is required' });
    const subPlan = normalizeBuSubscriptionPlan(subscription_plan);
    if (!subPlan) {
      return res.status(400).json({
        error: 'subscription_plan is required and must be FREE, STARTER, PRO, or ENTERPRISE',
      });
    }
    if (subscription_price === undefined || subscription_price === null || subscription_price === '') {
      return res.status(400).json({ error: 'subscription_price is required' });
    }
    const n = Number(subscription_price);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'subscription_price must be a non-negative number' });
    }
    const phoneNorm = normalizeBuPhone(phone);
    if (phoneNorm && typeof phoneNorm === 'object' && phoneNorm.error) {
      return res.status(400).json({ error: phoneNorm.error });
    }
    const phoneVal = phoneNorm === undefined ? null : phoneNorm;
    const [row] = await sql`
      INSERT INTO business_units (name, code, subscription_price, subscription_plan, phone, is_active)
      VALUES (${nameTrim}, ${codeTrim}, ${n}, ${subPlan}, ${phoneVal}, true)
      RETURNING id, name, code, subscription_price, subscription_plan, phone, is_active, created_at
    `;
    return sendResponse(res, 201, row);
  } catch (err) {
    console.error('Error creating business unit:', err);
    return res.status(500).json({ error: 'Failed to create business unit' });
  }
});

router.patch('/business-units/:id', requireCrmWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, is_active, subscription_price, subscription_plan, phone } = req.body;

    if (is_active !== undefined) {
      await sql`UPDATE business_units SET is_active = ${is_active} WHERE id = ${id}`;
    }
    if (name !== undefined || code !== undefined) {
      if (name !== undefined && code !== undefined) {
        const nt = String(name).trim();
        const ct = String(code).trim();
        if (!nt) return res.status(400).json({ error: 'name cannot be empty' });
        if (!ct) return res.status(400).json({ error: 'code cannot be empty' });
        await sql`UPDATE business_units SET name = ${nt}, code = ${ct} WHERE id = ${id}`;
      } else if (name !== undefined) {
        const nt = String(name).trim();
        if (!nt) return res.status(400).json({ error: 'name cannot be empty' });
        await sql`UPDATE business_units SET name = ${nt} WHERE id = ${id}`;
      } else {
        const ct = String(code).trim();
        if (!ct) return res.status(400).json({ error: 'code cannot be empty' });
        await sql`UPDATE business_units SET code = ${ct} WHERE id = ${id}`;
      }
    }
    if (subscription_price !== undefined) {
      if (subscription_price === null || subscription_price === '') {
        return res.status(400).json({ error: 'subscription_price is required' });
      }
      const n = Number(subscription_price);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'subscription_price must be a non-negative number' });
      }
      await sql`UPDATE business_units SET subscription_price = ${n} WHERE id = ${id}`;
    }
    if (subscription_plan !== undefined) {
      const subPlan = normalizeBuSubscriptionPlan(subscription_plan);
      if (!subPlan) {
        return res.status(400).json({
          error: 'subscription_plan must be FREE, STARTER, PRO, or ENTERPRISE',
        });
      }
      await sql`UPDATE business_units SET subscription_plan = ${subPlan} WHERE id = ${id}`;
    }
    if (phone !== undefined) {
      const phoneNorm = normalizeBuPhone(phone);
      if (phoneNorm && typeof phoneNorm === 'object' && phoneNorm.error) {
        return res.status(400).json({ error: phoneNorm.error });
      }
      await sql`UPDATE business_units SET phone = ${phoneNorm} WHERE id = ${id}`;
    }
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error updating business unit:', err);
    return res.status(500).json({ error: 'Failed to update business unit' });
  }
});

// ==========================================
// NOTIFICATIONS
// ==========================================

function notificationActor(req) {
  const actor = req.superAdmin;
  return {
    platform: actor?.isSuperAdmin === true,
    userId: actor?.id || null,
    founderId: actor?.founderId || null,
  };
}

function ownsNotification(scope, row) {
  if (!row) return false;
  if (scope.platform) return true;
  if (scope.userId && row.user_id === scope.userId) return true;
  if (scope.founderId && row.founder_id === scope.founderId) return true;
  return false;
}

async function ownedNotification(req, id) {
  const scope = notificationActor(req);
  const [row] = await sql`
    SELECT id, user_id, founder_id
    FROM notifications
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!ownsNotification(scope, row)) return null;
  return row;
}

router.get('/notifications', async (req, res) => {
  try {
    const scope = notificationActor(req);
    let rows;
    if (!scope.platform) {
      rows = await sql`
        SELECT id, user_id, founder_id, title, body, type, read_at, created_at
        FROM notifications
        WHERE user_id = ${scope.userId}
           OR (${scope.founderId}::uuid IS NOT NULL AND founder_id = ${scope.founderId})
        ORDER BY created_at DESC LIMIT 200
      `;
    } else {
      const { user_id, founder_id } = req.query;
      if (founder_id) {
        rows = await sql`
          SELECT id, user_id, founder_id, title, body, type, read_at, created_at
          FROM notifications
          WHERE user_id = ${user_id} OR founder_id = ${founder_id}
          ORDER BY created_at DESC LIMIT 200
        `;
      } else if (user_id) {
        rows = await sql`
          SELECT id, user_id, founder_id, title, body, type, read_at, created_at
          FROM notifications
          WHERE user_id = ${user_id}
          ORDER BY created_at DESC LIMIT 200
        `;
      } else {
        rows = await sql`
          SELECT id, user_id, founder_id, title, body, type, read_at, created_at
          FROM notifications
          ORDER BY created_at DESC LIMIT 200
        `;
      }
    }
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Error listing notifications:', err);
    return res.status(500).json({ error: 'Failed to list notifications' });
  }
});

router.get('/notifications/unread-count', async (req, res) => {
  try {
    const scope = notificationActor(req);
    let result;
    if (!scope.platform) {
      [result] = await sql`
        SELECT COUNT(*) AS count FROM notifications
        WHERE read_at IS NULL
          AND (
            user_id = ${scope.userId}
            OR (${scope.founderId}::uuid IS NOT NULL AND founder_id = ${scope.founderId})
          )
      `;
    } else {
      const { user_id, founder_id } = req.query;
      if (founder_id) {
        [result] = await sql`
          SELECT COUNT(*) AS count FROM notifications
          WHERE read_at IS NULL AND (user_id = ${user_id} OR founder_id = ${founder_id})
        `;
      } else if (user_id) {
        [result] = await sql`
          SELECT COUNT(*) AS count FROM notifications
          WHERE read_at IS NULL AND user_id = ${user_id}
        `;
      } else {
        [result] = await sql`SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL`;
      }
    }
    return sendResponse(res, 200, { count: parseInt(result.count) || 0 });
  } catch (err) {
    console.error('Error getting unread count:', err);
    return res.status(500).json({ error: 'Failed to get unread notification count' });
  }
});

router.patch('/notifications/:id/read', async (req, res) => {
  try {
    const row = await ownedNotification(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    await sql`UPDATE notifications SET read_at = NOW() WHERE id = ${row.id}`;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error marking notification read:', err);
    return res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

router.patch('/notifications/:id/unread', async (req, res) => {
  try {
    const row = await ownedNotification(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    await sql`UPDATE notifications SET read_at = NULL WHERE id = ${row.id}`;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error marking notification unread:', err);
    return res.status(500).json({ error: 'Failed to mark notification unread' });
  }
});

router.delete('/notifications/:id', async (req, res) => {
  try {
    const row = await ownedNotification(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    await sql`DELETE FROM notifications WHERE id = ${row.id}`;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error deleting notification:', err);
    return res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// ==========================================
// AUDIT LOGS
// ==========================================

router.get('/audit-logs', requireOrgSettings, async (req, res) => {
  try {
    const { entity_type, action } = req.query;

    const rows = await sql`
      WITH combined_logs AS (
        SELECT id, entity_type, action, actor_id, metadata, created_at
        FROM activity_logs
        UNION ALL
        SELECT id, COALESCE(entity, 'SYSTEM') AS entity_type, action,
               user_id AS actor_id, details AS metadata, created_at
        FROM audit_logs
      )
      SELECT id, entity_type, action, actor_id, metadata, created_at
      FROM combined_logs
      WHERE TRUE
        ${entity_type && entity_type !== 'ALL' ? sql`AND entity_type = ${entity_type}` : sql``}
        ${action && action !== 'ALL' ? sql`AND action = ${action}` : sql``}
      ORDER BY created_at DESC LIMIT 300
    `;
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Error listing audit logs:', err);
    return res.status(500).json({ error: 'Failed to list audit logs' });
  }
});

// ==========================================
// SETTINGS
// ==========================================

router.get('/settings', requireOrgSettings, async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key query parameter is required' });

    const [row] = await sql`SELECT value FROM settings WHERE key = ${key}`;
    return sendResponse(res, 200, { value: row?.value ?? null });
  } catch (err) {
    console.error('Error getting setting:', err);
    return res.status(500).json({ error: 'Failed to get setting' });
  }
});

router.put('/settings', requireOrgSettings, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    await sql`
      INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error upserting setting:', err);
    return res.status(500).json({ error: 'Failed to upsert setting' });
  }
});

router.get('/settings/founders', requireOrgSettings, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, user_id, email, full_name, role, is_active, created_at
      FROM founders
      ORDER BY full_name ASC
    `;
    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Error listing founders:', err);
    return res.status(500).json({ error: 'Failed to list founders' });
  }
});

router.patch('/settings/founders/:id/toggle', requireOrgSettings, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }
    await sql`UPDATE founders SET is_active = ${is_active} WHERE id = ${id}`;
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error toggling founder:', err);
    return res.status(500).json({ error: 'Failed to toggle founder' });
  }
});

module.exports = router;

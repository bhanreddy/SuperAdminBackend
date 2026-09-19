const express = require('express');
const sql = require('../../config/db');
const appConfig = require('../../config/env');
const { sendResponse, sendError } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { renderEmployeeDocumentHtml, TITLES } = require('../../utils/employeeDocument');

const router = express.Router();
router.use(verifySuperAdminMiddleware);

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];
const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'EXITED'];
const DOCUMENT_TYPES = Object.keys(TITLES);
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const todayPeriod = () => ({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });

function periodFrom(req) {
  const current = todayPeriod();
  const year = Number(req.body?.year ?? req.query?.year ?? current.year);
  const month = Number(req.body?.month ?? req.query?.month ?? current.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw Object.assign(new Error('A valid payroll month and year are required'), { status: 400 });
  }
  return { year, month };
}

function activeDays(employee, year, month) {
  const days = new Date(year, month, 0).getDate();
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month - 1, days));
  const joined = new Date(`${employee.joining_date}T00:00:00Z`);
  const exited = employee.exit_date ? new Date(`${employee.exit_date}T00:00:00Z`) : null;
  if (joined > periodEnd || (exited && exited < periodStart)) return { workingDays: days, paidDays: 0 };
  const paidStart = joined > periodStart ? joined : periodStart;
  const paidEnd = exited && exited < periodEnd ? exited : periodEnd;
  const paidDays = Math.max(0, Math.floor((paidEnd - paidStart) / 86400000) + 1);
  return { workingDays: days, paidDays };
}

function calculatePayroll(employee, config, year, month) {
  const { workingDays, paidDays } = activeDays(employee, year, month);
  const ratio = workingDays ? paidDays / workingDays : 0;
  const basic = round2(Number(employee.basic_salary) * ratio);
  const hra = round2(Number(employee.hra) * ratio);
  const allowances = round2(Number(employee.allowances) * ratio);
  const gross = round2(basic + hra + allowances);
  const pf = employee.pf_enabled ? round2(basic * Number(config.pf_rate) / 100) : 0;
  const esi = employee.esi_enabled && gross <= Number(config.esi_gross_limit)
    ? round2(gross * Number(config.esi_rate) / 100) : 0;
  const other = round2(Number(employee.fixed_deductions) * ratio);
  const deductions = round2(pf + esi + other);
  return { workingDays, paidDays, basic, hra, allowances, gross, pf, esi, other, deductions, net: Math.max(0, round2(gross - deductions)) };
}

function docNumber(type, employeeCode, year, month) {
  const codes = { PAYSLIP: 'PAY', EMPLOYMENT_CERTIFICATE: 'EMP', EXPERIENCE_CERTIFICATE: 'EXP', INTERNSHIP_CERTIFICATE: 'INT', OFFER_LETTER: 'OFR', RELIEVING_LETTER: 'REL' };
  const suffix = type === 'PAYSLIP'
    ? `${year}${String(month).padStart(2, '0')}`
    : `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return `NEX/HR/${codes[type]}/${String(employeeCode).replace(/[^A-Z0-9-]/gi, '')}/${suffix}`;
}

const SIGNATURE_MAX_CHARS = 700000;
let payrollSchemaReady = false;

async function ensurePayrollSchema() {
  if (payrollSchemaReady) return;
  try {
    await sql`ALTER TABLE payroll_config ADD COLUMN IF NOT EXISTS authorised_signatory_image TEXT`;
  } catch (err) {
    console.error(`[payroll] could not ensure signature column: ${err.message}`);
  }
  payrollSchemaReady = true;
}

function sanitizeSignatureImage(value) {
  if (value == null || value === '') return null;
  const image = String(value).trim().replace(/\s/g, '');
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    throw Object.assign(new Error('Signature must be a PNG, JPEG or WebP image'), { status: 400 });
  }
  if (image.length > SIGNATURE_MAX_CHARS) {
    throw Object.assign(new Error('Signature image is too large. Use a PNG under 500 KB.'), { status: 400 });
  }
  return image;
}

async function getConfig() {
  await ensurePayrollSchema();
  const [config] = await sql`SELECT * FROM payroll_config WHERE id = 1`;
  if (!config) throw Object.assign(new Error('Payroll migration has not been applied'), { status: 503 });
  return config;
}

router.get('/config', async (_req, res) => {
  try { return sendResponse(res, 200, await getConfig()); }
  catch (err) { return sendError(res, err.status || 500, 'PAYROLL_ERROR', err.message); }
});

router.put('/config', async (req, res) => {
  try {
    const current = await getConfig();
    const next = { ...current, ...req.body };
    const signatureImage = Object.prototype.hasOwnProperty.call(req.body || {}, 'authorised_signatory_image')
      ? sanitizeSignatureImage(req.body.authorised_signatory_image)
      : current.authorised_signatory_image;
    const [row] = await sql`UPDATE payroll_config SET
      organisation_name = ${String(next.organisation_name || 'NexSyrus').trim()},
      organisation_address = ${next.organisation_address || null},
      authorised_signatory = ${next.authorised_signatory || null},
      authorised_signatory_title = ${next.authorised_signatory_title || null},
      authorised_signatory_image = ${signatureImage},
      salary_day = ${Number(next.salary_day)}, auto_process_enabled = ${Boolean(next.auto_process_enabled)},
      pf_rate = ${Number(next.pf_rate)}, esi_rate = ${Number(next.esi_rate)},
      esi_gross_limit = ${Number(next.esi_gross_limit)}, updated_at = now()
      WHERE id = 1 RETURNING *`;
    return sendResponse(res, 200, row);
  } catch (err) { return sendError(res, err.status || 500, 'PAYROLL_ERROR', err.message); }
});

router.get('/employees', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const status = String(req.query.status || 'ALL');
    const rows = await sql`SELECT *, (basic_salary + hra + allowances) AS gross_salary
      FROM employees
      WHERE (${status} = 'ALL' OR status = ${status})
        AND (${query} = '' OR full_name ILIKE ${`%${query}%`} OR employee_code ILIKE ${`%${query}%`} OR department ILIKE ${`%${query}%`})
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'ON_LEAVE' THEN 1 ELSE 2 END, full_name`;
    return sendResponse(res, 200, rows);
  } catch (err) { return sendError(res, 500, 'PAYROLL_ERROR', err.message); }
});

router.post('/employees', async (req, res) => {
  try {
    const body = req.body || {};
    if (!String(body.full_name || '').trim() || !String(body.designation || '').trim() || !String(body.department || '').trim() || !body.joining_date) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Name, designation, department and joining date are required');
    }
    const employmentType = EMPLOYMENT_TYPES.includes(body.employment_type) ? body.employment_type : 'FULL_TIME';
    const status = EMPLOYEE_STATUSES.includes(body.status) ? body.status : 'ACTIVE';
    const code = String(body.employee_code || '').trim() || (await sql`SELECT 'NEX-' || nextval('employee_code_seq') AS code`)[0].code;
    const [row] = await sql`INSERT INTO employees (
      employee_code, full_name, email, phone, designation, department, employment_type, status,
      joining_date, exit_date, date_of_birth, pan_number, bank_account_number, bank_ifsc,
      basic_salary, hra, allowances, fixed_deductions, pf_enabled, esi_enabled, notes
    ) VALUES (
      ${code}, ${String(body.full_name).trim()}, ${body.email || null}, ${body.phone || null},
      ${String(body.designation).trim()}, ${String(body.department).trim()}, ${employmentType}, ${status},
      ${body.joining_date}, ${body.exit_date || null}, ${body.date_of_birth || null}, ${body.pan_number || null},
      ${body.bank_account_number || null}, ${body.bank_ifsc || null}, ${Number(body.basic_salary || 0)},
      ${Number(body.hra || 0)}, ${Number(body.allowances || 0)}, ${Number(body.fixed_deductions || 0)},
      ${Boolean(body.pf_enabled)}, ${Boolean(body.esi_enabled)}, ${body.notes || null}
    ) RETURNING *, (basic_salary + hra + allowances) AS gross_salary`;
    return sendResponse(res, 201, row);
  } catch (err) {
    if (err.code === '23505') return sendError(res, 409, 'DUPLICATE_EMPLOYEE_CODE', 'Employee code already exists');
    return sendError(res, 500, 'PAYROLL_ERROR', err.message);
  }
});

router.patch('/employees/:id', async (req, res) => {
  try {
    const [existing] = await sql`SELECT * FROM employees WHERE id = ${req.params.id}::uuid`;
    if (!existing) return sendError(res, 404, 'NOT_FOUND', 'Employee not found');
    const b = { ...existing, ...req.body };
    if (!EMPLOYMENT_TYPES.includes(b.employment_type) || !EMPLOYEE_STATUSES.includes(b.status)) return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid employee type or status');
    const [row] = await sql`UPDATE employees SET
      employee_code=${b.employee_code}, full_name=${b.full_name}, email=${b.email || null}, phone=${b.phone || null},
      designation=${b.designation}, department=${b.department}, employment_type=${b.employment_type}, status=${b.status},
      joining_date=${b.joining_date}, exit_date=${b.exit_date || null}, date_of_birth=${b.date_of_birth || null},
      pan_number=${b.pan_number || null}, bank_account_number=${b.bank_account_number || null}, bank_ifsc=${b.bank_ifsc || null},
      basic_salary=${Number(b.basic_salary)}, hra=${Number(b.hra)}, allowances=${Number(b.allowances)},
      fixed_deductions=${Number(b.fixed_deductions)}, pf_enabled=${Boolean(b.pf_enabled)}, esi_enabled=${Boolean(b.esi_enabled)},
      notes=${b.notes || null}, updated_at=now() WHERE id=${req.params.id}::uuid
      RETURNING *, (basic_salary + hra + allowances) AS gross_salary`;
    return sendResponse(res, 200, row);
  } catch (err) { return sendError(res, 500, 'PAYROLL_ERROR', err.message); }
});

router.get('/summary', async (req, res) => {
  try {
    const { year, month } = periodFrom(req);
    const [[employees], [payroll], [docs]] = await Promise.all([
      sql`SELECT count(*)::int AS active_count, COALESCE(sum(basic_salary + hra + allowances),0) AS monthly_gross FROM employees WHERE status IN ('ACTIVE','ON_LEAVE')`,
      sql`SELECT count(*)::int AS processed_count, count(*) FILTER (WHERE status='PAID')::int AS paid_count, COALESCE(sum(net_pay),0) AS net_payroll FROM payroll_runs WHERE payroll_year=${year} AND payroll_month=${month}`,
      sql`SELECT count(*)::int AS document_count FROM employee_documents`,
    ]);
    return sendResponse(res, 200, { year, month, ...employees, ...payroll, ...docs });
  } catch (err) { return sendError(res, err.status || 500, 'PAYROLL_ERROR', err.message); }
});

router.get('/runs', async (req, res) => {
  try {
    const { year, month } = periodFrom(req);
    const rows = await sql`SELECT p.*, e.employee_code, e.full_name, e.designation, e.department
      FROM payroll_runs p JOIN employees e ON e.id=p.employee_id
      WHERE p.payroll_year=${year} AND p.payroll_month=${month} ORDER BY e.full_name`;
    return sendResponse(res, 200, rows);
  } catch (err) { return sendError(res, err.status || 500, 'PAYROLL_ERROR', err.message); }
});

async function processPayrollPeriod(year, month) {
  const config = await getConfig();
  const employees = await sql`SELECT * FROM employees WHERE status IN ('ACTIVE','ON_LEAVE') OR (status='EXITED' AND exit_date >= ${`${year}-${String(month).padStart(2, '0')}-01`}::date)`;
  let processed = 0;
  for (const employee of employees) {
    const c = calculatePayroll(employee, config, year, month);
    if (c.paidDays <= 0) continue;
    const [run] = await sql`INSERT INTO payroll_runs (
      employee_id,payroll_month,payroll_year,working_days,paid_days,basic_pay,hra_pay,allowance_pay,gross_pay,
      pf_deduction,esi_deduction,other_deductions,total_deductions,net_pay,status,calculation_snapshot
    ) VALUES (${employee.id},${month},${year},${c.workingDays},${c.paidDays},${c.basic},${c.hra},${c.allowances},${c.gross},${c.pf},${c.esi},${c.other},${c.deductions},${c.net},'PROCESSED',${sql.json({ pf_rate: config.pf_rate, esi_rate: config.esi_rate, esi_gross_limit: config.esi_gross_limit })})
    ON CONFLICT (employee_id,payroll_year,payroll_month) DO UPDATE SET
      working_days=EXCLUDED.working_days,paid_days=EXCLUDED.paid_days,basic_pay=EXCLUDED.basic_pay,hra_pay=EXCLUDED.hra_pay,
      allowance_pay=EXCLUDED.allowance_pay,gross_pay=EXCLUDED.gross_pay,pf_deduction=EXCLUDED.pf_deduction,
      esi_deduction=EXCLUDED.esi_deduction,other_deductions=EXCLUDED.other_deductions,total_deductions=EXCLUDED.total_deductions,
      net_pay=EXCLUDED.net_pay,status=CASE WHEN payroll_runs.status='PAID' THEN 'PAID' ELSE 'PROCESSED' END,
      calculation_snapshot=EXCLUDED.calculation_snapshot,processed_at=now(),updated_at=now() RETURNING *`;
    await sql`INSERT INTO employee_documents (employee_id,payroll_run_id,document_type,document_number,title,payload)
      VALUES (${employee.id},${run.id},'PAYSLIP',${docNumber('PAYSLIP', employee.employee_code, year, month)},${TITLES.PAYSLIP},${sql.json({ year, month })})
      ON CONFLICT (payroll_run_id,document_type) WHERE document_type='PAYSLIP'
      DO UPDATE SET payload=EXCLUDED.payload, generated_at=now()`;
    processed += 1;
  }
  return { success: true, processed, year, month };
}

router.post('/runs/process', async (req, res) => {
  try {
    const { year, month } = periodFrom(req);
    return sendResponse(res, 200, await processPayrollPeriod(year, month));
  } catch (err) { return sendError(res, err.status || 500, 'PAYROLL_ERROR', err.message); }
});

router.post('/runs/:id/paid', async (req, res) => {
  try {
    const [row] = await sql`UPDATE payroll_runs SET status='PAID',paid_at=now(),updated_at=now() WHERE id=${req.params.id}::uuid RETURNING *`;
    if (!row) return sendError(res, 404, 'NOT_FOUND', 'Payroll record not found');
    return sendResponse(res, 200, row);
  } catch (err) { return sendError(res, 500, 'PAYROLL_ERROR', err.message); }
});

router.get('/documents', async (req, res) => {
  try {
    const employeeId = req.query.employee_id ? String(req.query.employee_id) : null;
    const rows = await sql`SELECT d.*, e.full_name, e.employee_code, e.designation
      FROM employee_documents d JOIN employees e ON e.id=d.employee_id
      WHERE (${employeeId}::text IS NULL OR d.employee_id::text=${employeeId}) ORDER BY d.generated_at DESC LIMIT 200`;
    return sendResponse(res, 200, rows);
  } catch (err) { return sendError(res, 500, 'PAYROLL_ERROR', err.message); }
});

function isoDate(value, fallback = null) {
  const raw = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : raw;
}

router.post('/employees/:id/documents', async (req, res) => {
  try {
    const type = String(req.body?.document_type || '');
    if (!DOCUMENT_TYPES.includes(type) || type === 'PAYSLIP') return sendError(res, 400, 'VALIDATION_ERROR', 'Choose a supported certificate type');
    const [employee] = await sql`SELECT * FROM employees WHERE id=${req.params.id}::uuid`;
    if (!employee) return sendError(res, 404, 'NOT_FOUND', 'Employee not found');
    const startDate = isoDate(req.body?.start_date, isoDate(employee.joining_date));
    const endDate = isoDate(req.body?.end_date, isoDate(employee.exit_date));
    if (startDate && endDate && startDate > endDate) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'The from date must be on or before the to date');
    }
    const [row] = await sql`INSERT INTO employee_documents (employee_id,document_type,document_number,title,payload)
      VALUES (${employee.id},${type},${docNumber(type, employee.employee_code)},${TITLES[type]},${sql.json({ start_date: startDate, end_date: endDate, notes: req.body?.notes || null })}) RETURNING *`;
    return sendResponse(res, 201, row);
  } catch (err) { return sendError(res, 500, 'PAYROLL_ERROR', err.message); }
});

router.get('/documents/:id/document.html', async (req, res) => {
  try {
    const [row] = await sql`SELECT d.*, row_to_json(e) AS employee,
      CASE WHEN p.id IS NULL THEN NULL ELSE row_to_json(p) END AS payroll
      FROM employee_documents d JOIN employees e ON e.id=d.employee_id
      LEFT JOIN payroll_runs p ON p.id=d.payroll_run_id WHERE d.id=${req.params.id}::uuid`;
    if (!row) return sendError(res, 404, 'NOT_FOUND', 'Document not found');
    const config = await getConfig();
    const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const requestOrigin = `${forwardedProtocol || req.protocol}://${req.get('host')}`;
    const publicOrigin = String(appConfig.publicBaseUrl || requestOrigin).replace(/\/+$/, '');
    const verificationUrl = `${publicOrigin}/api/public/hr-documents/verify/${row.verification_token}`;
    const html = renderEmployeeDocumentHtml({ document: row, employee: row.employee, payroll: row.payroll, config, verificationUrl });
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) { return sendError(res, 500, 'DOCUMENT_RENDER_FAILED', err.message); }
});

module.exports = router;
module.exports.processPayrollPeriod = processPayrollPeriod;

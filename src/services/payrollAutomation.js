const sql = require('../config/db');
const { processPayrollPeriod } = require('../routes/superadmin/payroll');

let timer = null;

async function tick() {
  try {
    const [tables] = await sql`SELECT
      to_regclass('public.payroll_config') AS config,
      to_regclass('public.employees') AS employees,
      to_regclass('public.payroll_runs') AS runs`;
    if (!tables.config || !tables.employees || !tables.runs) return;
    const [config] = await sql`SELECT salary_day, auto_process_enabled FROM payroll_config WHERE id=1`;
    const now = new Date();
    if (!config?.auto_process_enabled || now.getDate() < Number(config.salary_day)) return;
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const [[headcount], [runs]] = await Promise.all([
      sql`SELECT count(*)::int AS count FROM employees WHERE status IN ('ACTIVE','ON_LEAVE') AND joining_date <= CURRENT_DATE`,
      sql`SELECT count(*)::int AS count FROM payroll_runs WHERE payroll_year=${year} AND payroll_month=${month}`,
    ]);
    if (Number(runs.count) >= Number(headcount.count)) return;
    const result = await processPayrollPeriod(year, month);
    console.log(`[payroll-autopilot] ${year}-${String(month).padStart(2, '0')}: processed ${result.processed} employee(s)`);
  } catch (err) {
    console.error('[payroll-autopilot] tick failed:', err.message);
  }
}

function startPayrollAutomationWorker() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 6 * 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = { startPayrollAutomationWorker, tick };

const { ensure, date } = require('./domain');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const calendar = value => value instanceof Date ? value.toISOString().slice(0, 10) : value;
// PostgreSQL aggregates return exact decimal strings. Never silently round ledger totals.
function exact(value) {
  const n = BigInt(value || 0);
  ensure(n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER),
    'Report amount exceeds the supported exact range', 422);
  return Number(n);
}
const sum = values => exact(values.reduce((total, value) => total + BigInt(value), 0n));
function range(filter = {}) {
  const from = date(filter.from || '2000-01-01', 'Start date');
  const to = date(filter.to || today(), 'End date');
  ensure(to >= from, 'End date must follow start date');
  return { from, to };
}
async function accountBalances(tx, from, to) {
  const trial = await tx`SELECT a.*,
    COALESCE(sum(l.debit) FILTER(WHERE j.date<${from}),0) AS opening_debit,
    COALESCE(sum(l.credit) FILTER(WHERE j.date<${from}),0) AS opening_credit,
    COALESCE(sum(l.debit),0) AS debit,COALESCE(sum(l.credit),0) AS credit,
    COALESCE(sum(l.debit) FILTER(WHERE j.date>=${from}),0) AS period_debit,
    COALESCE(sum(l.credit) FILTER(WHERE j.date>=${from}),0) AS period_credit
    FROM books_accounts a LEFT JOIN (books_journal_lines l JOIN books_journals j ON j.id=l.journal_id AND j.date<=${to})
    ON l.account_code=a.code GROUP BY a.code ORDER BY a.code`;
  for (const a of trial) {
    for (const key of ['opening_debit','opening_credit','debit','credit','period_debit','period_credit']) exact(a[key]);
    a.opening_balance = sum([a.opening_debit, -BigInt(a.opening_credit)]);
    a.balance = sum([a.debit, -BigInt(a.credit)]);
    a.period_balance = sum([a.period_debit, -BigInt(a.period_credit)]);
  }
  return trial;
}
async function statements(tx, from, to) {
  const trial = await accountBalances(tx, from, to);
  const section = (type, period = false) => trial.filter(a => a.type === type).map(a => ({
    code: a.code, name: a.name, type: a.type,
    amount: exact(BigInt(period ? a.period_balance : a.balance) * (['income','liability','equity'].includes(type) ? -1n : 1n)),
  }));
  const incomeRows = section('income', true), expenseRows = section('expense', true);
  const income = sum(incomeRows.map(a => a.amount)), expenses = sum(expenseRows.map(a => a.amount));
  const profit = sum([income, -BigInt(expenses)]);
  const assetsRows = section('asset'), liabilitiesRows = section('liability'), equityRows = section('equity');
  const assets = sum(assetsRows.map(a => a.amount)), liabilities = sum(liabilitiesRows.map(a => a.amount)), equity = sum(equityRows.map(a => a.amount));
  const retained = sum(trial.filter(a => ['income','expense'].includes(a.type)).map(a => -BigInt(a.balance)));
  const priorEarnings = sum([retained, -BigInt(profit)]);
  const cash = sum(trial.filter(a => a.is_cash).map(a => a.balance));
  const openingCash = sum(trial.filter(a => a.is_cash).map(a => a.opening_balance));
  // Net cash per journal excludes transfers between cash accounts. Ambiguous mixed
  // journals stay explicitly unclassified rather than inventing an allocation.
  const movements = await tx`WITH cash_journals AS (
    SELECT l.journal_id,sum(l.debit-l.credit) AS net FROM books_journal_lines l
    JOIN books_accounts a ON a.code=l.account_code JOIN books_journals j ON j.id=l.journal_id
    WHERE a.is_cash AND j.date BETWEEN ${from} AND ${to} GROUP BY l.journal_id
  ), classified AS (
    SELECT j.id,j.date,j.reference,j.source,j.source_id,j.reversal_of,c.net,
      CASE WHEN c.net=0 THEN 'unclassified' ELSE COALESCE(j.cash_flow_activity,original.cash_flow_activity,
        CASE WHEN count(DISTINCT a.cash_flow_activity)=1 AND count(*) FILTER(WHERE a.cash_flow_activity IS NULL)=0
          THEN min(a.cash_flow_activity) ELSE 'unclassified' END) END AS activity
    FROM cash_journals c JOIN books_journals j ON j.id=c.journal_id
    LEFT JOIN books_journals original ON original.id=j.reversal_of
    JOIN books_journal_lines l ON l.journal_id=j.id JOIN books_accounts a ON a.code=l.account_code AND NOT a.is_cash
    GROUP BY j.id,original.cash_flow_activity,c.net
  ) SELECT activity,to_char(date,'YYYY-MM') AS month,
    sum(GREATEST(net,0)) AS inflow,sum(GREATEST(-net,0)) AS outflow,count(*) AS journal_count
    FROM classified GROUP BY activity,to_char(date,'YYYY-MM') ORDER BY month,activity`;
  const activities = ['operating','investing','financing','unclassified'].map(activity => {
    const rows = movements.filter(m => m.activity === activity);
    const inflow = sum(rows.map(r => r.inflow)), outflow = sum(rows.map(r => r.outflow));
    return { activity, inflow, outflow, net: sum([inflow, -BigInt(outflow)]), journal_count: sum(rows.map(r => r.journal_count)) };
  });
  const cashflow = [...new Set(movements.map(m => m.month))].map(month => ({
    month, inflow: sum(movements.filter(m => m.month === month).map(m => m.inflow)),
    outflow: sum(movements.filter(m => m.month === month).map(m => m.outflow)),
  }));
  const netChange = sum(activities.map(a => a.net));
  return { trial, income, expenses, profit, assets, liabilities, equity, retained, cash, cashflow,
    profit_loss: { income: incomeRows, expenses: expenseRows, total_income: income, total_expenses: expenses, net_profit: profit },
    balance_sheet: { as_of: to, assets: assetsRows, liabilities: liabilitiesRows, equity: equityRows,
      total_assets: assets, total_liabilities: liabilities, owner_equity: equity,
      prior_earnings: priorEarnings, period_earnings: profit, accumulated_earnings: retained,
      total_equity: sum([equity, retained]), liabilities_and_equity: sum([liabilities, equity, retained]),
      difference: sum([assets, -BigInt(liabilities), -BigInt(equity), -BigInt(retained)]) },
    cash_flow: { method: 'direct', opening_cash: openingCash, closing_cash: cash, activities,
      net_change: netChange, difference: sum([cash, -BigInt(openingCash), -BigInt(netChange)]),
      classification_complete: activities.find(a => a.activity === 'unclassified').journal_count === 0 },
  };
}
async function ledger(db, code, filter = {}) {
  const { from, to } = range(filter);
  const page = filter.page === undefined ? 1 : Number(filter.page);
  const pageSize = filter.page_size === undefined ? 100 : Number(filter.page_size);
  ensure(Number.isSafeInteger(page) && page > 0 && page <= 1000000, 'Invalid ledger page');
  ensure(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 500, 'Ledger page size must be 1–500');
  return db.begin('isolation level repeatable read', async tx => {
    const [account] = await tx`SELECT * FROM books_accounts WHERE code=${code}`;
    ensure(account, 'Account not found', 404);
    const [totals] = await tx`SELECT
      COALESCE(sum(l.debit-l.credit) FILTER(WHERE j.date<${from}),0) AS opening_balance,
      COALESCE(sum(l.debit) FILTER(WHERE j.date>=${from}),0) AS debit,
      COALESCE(sum(l.credit) FILTER(WHERE j.date>=${from}),0) AS credit,
      count(*) FILTER(WHERE j.date>=${from}) AS total
      FROM books_journal_lines l JOIN books_journals j ON j.id=l.journal_id
      WHERE l.account_code=${code} AND j.date<=${to}`;
    const [settings] = await tx`SELECT organization_name,currency FROM books_settings WHERE id=1`;
    const opening = exact(totals.opening_balance);
    const rows = await tx`SELECT * FROM (
      SELECT l.id,l.journal_id,l.account_code,l.debit,l.credit,j.date,j.reference,j.notes,j.source,j.source_id,j.reversal_of,
        ${String(opening)}::numeric + sum(l.debit-l.credit) OVER(ORDER BY j.date,l.id ROWS UNBOUNDED PRECEDING) AS running_balance
      FROM books_journal_lines l JOIN books_journals j ON j.id=l.journal_id
      WHERE l.account_code=${code} AND j.date BETWEEN ${from} AND ${to}
    ) entries ORDER BY date,id LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`;
    return { account, organization_name: settings.organization_name, currency: settings.currency, from, to, opening_balance: opening, period_debit: exact(totals.debit), period_credit: exact(totals.credit),
      closing_balance: sum([opening, totals.debit, -BigInt(totals.credit)]), total: exact(totals.total), page, page_size: pageSize,
      data: rows.map(r => ({ ...r, date: calendar(r.date), running_balance: exact(r.running_balance) })) };
  });
}
module.exports = { accountBalances, statements, ledger, exact, sum, range };

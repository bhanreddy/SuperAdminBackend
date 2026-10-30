const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { createBooksService } = require('../../src/services/books/service');
const { initializeCompanyBooks } = require('../../src/services/books/companySetup');
const { exact } = require('../../src/services/books/statements');
let db, socket, sql, books;
const period = { from: '2026-04-01', to: '2026-04-30' };
async function journal(date, lines, extra = {}) {
  return books.manualJournal({ date, reference: randomUUID(), lines, ...extra }, 'test');
}
test.before(async () => {
  db = new PGlite(); socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 }); await socket.start();
  sql = postgres(`postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`, { max: 1, onnotice() {} });
  await initializeCompanyBooks(sql, 'public', 'Statements test'); books = createBooksService(sql);
});
test.after(async () => { if (sql) await sql.end(); if (socket) await socket.stop(); if (db) await db.close(); });
test('empty statements reconcile, strict dates and pagination reject invalid input', async () => {
  const r = await books.reports(period);
  assert.equal(r.balance_sheet.difference, 0); assert.equal(r.cash_flow.difference, 0); assert.equal(r.profit, 0);
  const l = await books.ledger('1000', period); assert.equal(l.total, 0); assert.deepEqual(l.data, []);
  await assert.rejects(books.reports({ from: '2026-02-30' }), /valid/);
  await assert.rejects(books.reports({ from: period.to, to: period.from }), /End date/);
  await assert.rejects(books.ledger('1000', { ...period, page: '1.5' }), /page/);
  await assert.rejects(books.ledger('1000', { ...period, page_size: 501 }), /size/);
  await assert.rejects(books.ledger('missing', period), /not found/);
  assert.throws(() => exact('9007199254740992'), /exact range/);
});
test('P&L uses the inclusive period; balance sheet includes prior earnings and excludes future/draft records', async () => {
  await journal('2026-03-31', [{ account_code: '1010', debit: 1000 }, { account_code: '3000', credit: 1000 }]);
  await journal('2026-03-31', [{ account_code: '1100', debit: 200 }, { account_code: '4000', credit: 200 }]);
  await journal(period.from, [{ account_code: '1100', debit: '100.01' }, { account_code: '4000', credit: '100.01' }]);
  await journal(period.to, [{ account_code: '5000', debit: '25.02' }, { account_code: '2000', credit: '25.02' }]);
  await journal('2026-05-01', [{ account_code: '1010', debit: 900 }, { account_code: '4000', credit: 900 }]);
  const customer = await books.saveContact({ name: 'Draft only', kind: 'customer' }, 'test');
  await books.createDocument({ kind: 'invoice', contact_id: customer.id, date: period.from, lines: [{ description: 'Draft', quantity: 1, rate: 99999 }] }, 'test');
  const r = await books.reports(period);
  assert.equal(r.income, 10001); assert.equal(r.expenses, 2502); assert.equal(r.profit, 7499);
  assert.equal(r.balance_sheet.prior_earnings, 20000); assert.equal(r.balance_sheet.period_earnings, 7499);
  assert.equal(r.balance_sheet.total_assets, 130001); assert.equal(r.balance_sheet.total_liabilities, 2502);
  assert.equal(r.balance_sheet.total_equity, 127499); assert.equal(r.balance_sheet.difference, 0);
  const short = await books.reports({ from: '2026-04-30', to: period.to });
  assert.equal(short.balance_sheet.total_assets, r.assets); assert.equal(short.retained, r.retained);
  assert.equal(short.profit, -2502); assert.equal(short.balance_sheet.prior_earnings, 30001);
});
test('cash flow separates activities, excludes transfers/non-cash entries and flags ambiguous journals', async () => {
  await books.addAccount({ code: '1500', name: 'Equipment', type: 'asset', cash_flow_activity: 'investing' });
  await books.addAccount({ code: '2500', name: 'Loan', type: 'liability', cash_flow_activity: 'financing' });
  await books.addAccount({ code: '1600', name: 'Needs review', type: 'asset' });
  await journal('2026-04-02', [{ account_code: '1010', debit: 100 }, { account_code: '1100', credit: 100 }]);
  await journal('2026-04-03', [{ account_code: '5000', debit: 20 }, { account_code: '1010', credit: 20 }]);
  await journal('2026-04-04', [{ account_code: '1500', debit: 50 }, { account_code: '1010', credit: 50 }]);
  await journal('2026-04-05', [{ account_code: '1010', debit: 200 }, { account_code: '2500', credit: 200 }]);
  await journal('2026-04-06', [{ account_code: '1000', debit: 75 }, { account_code: '1010', credit: 75 }]);
  await journal('2026-04-07', [{ account_code: '1500', debit: 40 }, { account_code: '2500', credit: 40 }]);
  await journal('2026-04-08', [{ account_code: '1010', debit: 15 }, { account_code: '4000', credit: 10 }, { account_code: '2500', credit: 5 }]);
  await journal('2026-04-09', [{ account_code: '1600', debit: 7 }, { account_code: '1010', credit: 7 }]);
  await journal('2026-04-10', [{ account_code: '1010', debit: 12 }, { account_code: '4000', credit: 10 }, { account_code: '2500', credit: 2 }], { cash_flow_activity: 'financing' });
  const r = await books.reports(period), c = r.cash_flow;
  assert.equal(c.opening_cash, 100000); assert.equal(c.closing_cash, 125000); assert.equal(c.net_change, 25000);
  assert.equal(c.difference, 0); assert.equal(c.classification_complete, false);
  const activity = key => c.activities.find(a => a.activity === key);
  assert.equal(activity('operating').inflow, 10000); assert.equal(activity('operating').outflow, 2000);
  assert.equal(activity('investing').net, -5000); assert.equal(activity('financing').net, 21200);
  assert.equal(activity('unclassified').net, 800); assert.equal(activity('unclassified').journal_count, 2);
  assert.equal(r.cashflow[0].inflow, 32700); assert.equal(r.cashflow[0].outflow, 7700);
  assert.equal(r.balance_sheet.difference, 0);
  await assert.rejects(journal(period.from, [{ account_code: '1000', debit: 1 }, { account_code: '3000', credit: 1 }], { cash_flow_activity: 'invalid' }), /activity/);
});
test('ledger pagination preserves opening and running balances on same-day entries and out-of-range pages', async () => {
  const first = await books.ledger('1010', { ...period, page_size: 2 });
  const second = await books.ledger('1010', { ...period, page: 2, page_size: 2 });
  assert.equal(first.opening_balance, 100000); assert.equal(first.total, 8);
  assert.equal(first.data[0].running_balance, 110000); assert.equal(first.data[1].running_balance, 108000);
  assert.equal(second.data[0].running_balance, 103000); assert.equal(second.data[1].running_balance, 123000);
  assert.equal(first.closing_balance, 117500); assert.equal(second.closing_balance, first.closing_balance);
  assert.equal(first.data[0].date, '2026-04-02');
  const beyond = await books.ledger('1010', { ...period, page: 100 }); assert.equal(beyond.total, first.total); assert.deepEqual(beyond.data, []);
  const credit = await books.ledger('4000', { ...period, page_size: 1 }); assert.equal(credit.opening_balance, -20000); assert.equal(credit.data[0].running_balance, -30001);
  // More than the former silent 2,000-entry ceiling, without thousands of round trips.
  await sql.begin(async tx => {
    const id = randomUUID();
    await tx`INSERT INTO books_journals(id,date,reference,source,source_id) VALUES(${id},'2026-04-20','Bulk','manual',${randomUUID()})`;
    await tx`INSERT INTO books_journal_lines(journal_id,account_code,debit,credit)
      SELECT ${id}::uuid,'1000',1,0 FROM generate_series(1,2005)`;
    await tx`INSERT INTO books_journal_lines(journal_id,account_code,debit,credit) VALUES(${id},'3000',0,2005)`;
  });
  const last = await books.ledger('1000', { ...period, page: 5, page_size: 500 });
  assert.equal(last.total, 2006); assert.equal(last.data.length, 6); assert.equal(last.data.at(-1).running_balance, last.closing_balance);
});
test('dated reversals preserve historical statements and offset original cash classifications', async () => {
  const customer = await books.saveContact({ name: 'Paid invoice', kind: 'customer' }, 'test');
  const doc = await books.createDocument({ kind: 'invoice', contact_id: customer.id, date: '2026-06-01', lines: [{ description: 'Service', quantity: 1, rate: 10 }] }, 'test');
  await books.post(doc.id, 'test');
  const p = await books.recordPayment({ document_id: doc.id, amount: 10, date: '2026-06-01', request_key: randomUUID() }, 'test');
  await books.voidPayment(p.id, 'test'); await books.voidDocument(doc.id, 'test');
  const historical = await books.reports({ from: '2026-06-01', to: '2026-06-01' });
  assert.equal(historical.income, 1000); assert.equal(historical.cash_flow.net_change, 1000);
  const full = await books.reports({ from: '2026-06-01', to: '2099-12-31' });
  assert.equal(full.income, 0); assert.equal(full.cash_flow.net_change, 0); assert.equal(full.cash_flow.difference, 0);
  assert.equal(full.cash_flow.activities.find(a => a.activity === 'operating').outflow, 1000);
});
test('migration is repeatable with populated journals and preserves explicit account classifications', async () => {
  const [before] = await sql`SELECT count(*) AS n FROM books_journals`;
  await initializeCompanyBooks(sql, 'public', 'Ignored name');
  const [after] = await sql`SELECT count(*) AS n FROM books_journals`;
  assert.equal(before.n, after.n);
  assert.equal((await books.accounts()).find(a => a.code === '1500').cash_flow_activity, 'investing');
  assert.equal((await books.reports(period)).balance_sheet.difference, 0);
});
test('offsetting external cash entries are flagged for review rather than silently treated as transfers', async () => {
  await journal('2026-07-01', [{ account_code:'1010',debit:10 },{account_code:'1000',credit:10},
    {account_code:'5000',debit:10},{account_code:'2500',credit:10}]);
  const r=await books.reports({from:'2026-07-01',to:'2026-07-01'});
  assert.equal(r.cash_flow.net_change,0);assert.equal(r.cash_flow.difference,0);
  assert.equal(r.cash_flow.classification_complete,false);
  assert.equal(r.cash_flow.activities.find(a=>a.activity==='unclassified').journal_count,1);
});
test('account reporting changes are audited, reject invalid values, and survive migration reruns', async () => {
  await assert.rejects(books.setAccountReporting('missing',{cash_flow_activity:'operating'},'test'),/not found/);
  await assert.rejects(books.setAccountReporting('1600',{cash_flow_activity:'bad'},'test'),/activity/);
  const before=await books.reports(period);
  await books.setAccountReporting('1600',{cash_flow_activity:'investing'},'accountant');
  const after=await books.reports(period);
  assert.equal(before.cash_flow.activities.find(a=>a.activity==='unclassified').journal_count,2);
  assert.equal(after.cash_flow.activities.find(a=>a.activity==='unclassified').journal_count,1);
  assert.equal(after.cash_flow.difference,0);assert.equal(after.assets,before.assets);assert.equal(after.profit,before.profit);
  const [audit]=await sql`SELECT * FROM books_activity WHERE action='reporting_updated' ORDER BY id DESC LIMIT 1`;
  assert.equal(audit.actor,'accountant');assert.deepEqual(audit.details,{code:'1600',before:null,after:'investing'});
  await books.setAccountReporting('4000',{cash_flow_activity:null},'test');
  await initializeCompanyBooks(sql,'public','Ignored');
  assert.equal((await books.accounts()).find(a=>a.code==='4000').cash_flow_activity,null);
  const rows=await books.accounts(period); assert.equal(rows.find(a=>a.code==='1010').opening_balance,100000);
  assert.equal(rows.find(a=>a.code==='1010').balance,117500);
});

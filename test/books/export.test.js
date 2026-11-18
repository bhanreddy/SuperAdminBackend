const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const postgres = require('postgres');
const XLSX = require('xlsx');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { initializeCompanyBooks } = require('../../src/services/books/companySetup');
const { createBooksService } = require('../../src/services/books/service');
const { createBooksRouter } = require('../../src/routes/superadmin/books');
const { encodeCsv, scaled, validateExport } = require('../../src/services/books/export');
let db, socket, sql, books, app, company, other, customer, invoice;
let user;
const read = text => {
  const book = XLSX.read(text.replace(/^\uFEFF/, ''), { type: 'string', raw: true });
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
};
const url = (module, extra = '') => `/books/export?module=${module}${extra}`;
async function download(module, extra = '', companyId = company) {
  return request(app).get(url(module, extra)).set('X-Books-Company-Id', companyId);
}
test.before(async () => {
  db = new PGlite(); socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 }); await socket.start();
  sql = postgres(`postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`, { max: 1, onnotice() {} });
  await initializeCompanyBooks(sql, 'public', 'Primary company');
  await initializeCompanyBooks(sql, 'books_export_other', 'Other company');
  await sql`CREATE TABLE public.books_companies(id uuid PRIMARY KEY,code text,name text,schema_name text,active boolean DEFAULT true)`;
  await sql`CREATE TABLE public.books_company_access(user_id text,company_id uuid,permissions text[])`;
  company = randomUUID(); other = randomUUID();
  await sql`INSERT INTO public.books_companies(id,code,name,schema_name) VALUES (${company},'primary','Primary company','public'),(${other},'other','Other company','books_export_other')`;
  user = { id: 'test', role: 'CA_LEAD' };
  books = createBooksService(sql);
  customer = await books.saveContact({ name: 'School, "A"\nతెలుగు', kind: 'customer' }, 'test');
  const vendor = await books.saveContact({ name: 'Vendor secret', kind: 'vendor' }, 'test');
  const input = { kind: 'invoice', contact_id: customer.id, date: '2026-04-01', lines: [{ description: 'Work', quantity: '1', rate: '123.45' }] };
  invoice = await books.createDocument(input, 'test'); await books.post(invoice.id, 'test');
  await books.recordPayment({ document_id: invoice.id, date: '2026-04-01', amount: '23.45', request_key: randomUUID() }, 'test');
  await books.createDocument({ ...input, kind: 'bill', contact_id: vendor.id }, 'test');
  await books.createRecurring({ template_id: invoice.id, interval_months: 1, next_date: '2026-05-01' });
  await sql`INSERT INTO books_documents(kind,number,contact_id,contact_snapshot,organization_snapshot,date,lines,subtotal,tax,total)
    SELECT 'invoice','BULK-'||n,${customer.id},${sql.json(invoice.contact_snapshot)},${sql.json(invoice.organization_snapshot)},'2026-04-02','[]',101,0,101 FROM generate_series(1,125) n`;
  await sql`INSERT INTO books_bank_transactions(account_code,date,description,amount,external_key)
    SELECT '1010','2026-04-02','statement '||n,-12345,'row-'||n FROM generate_series(1,1005) n`;
  await sql`INSERT INTO books_items(name,sale_rate,purchase_rate,tax_rate,stock_milli) VALUES ('Item',9007199254740993,12345,1800,1234)`;
  await sql`INSERT INTO books_export_other.books_contacts(kind,name) VALUES ('customer','Other private customer')`;
  app = express(); app.use(express.json());
  app.use('/books', createBooksRouter({ db: sql, authorize: (req, res, next) => { req.user = user; next(); } }));
});
test.after(async () => { if (sql) await sql.end(); if (socket) await socket.stop(); if (db) await db.close(); });

test('CSV codec preserves Unicode, quotes, multiline cells and exact signed decimals; blocks disguised formulas', () => {
  assert.equal(scaled('9007199254740993', 2), '90071992547409.93');
  assert.equal(scaled('-1', 2), '-0.01'); assert.equal(scaled(1234, 3), '1.234');
  assert.throws(() => scaled(Number.MAX_SAFE_INTEGER + 1, 2), /exact/);
  const values = ['School, "A"\nతెలుగు', '=1+1', '  =1+1', '\t+cmd', '-SUM(1,2)', '-123.45', ''];
  const csv = encodeCsv(values.map(value => ({ value })), ['value']);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.endsWith('\r\n'));
  const parsed = read(csv);
  assert.equal(parsed[0].value, values[0]);
  for (let i = 1; i <= 4; i++) assert.equal(parsed[i].value, "'" + values[i]);
  assert.equal(parsed[5].value, '-123.45');
});
test('document export includes every page with correct settlement and stable headers, filters and bytes', async () => {
  const r = await download('invoice'); assert.equal(r.status, 200, r.text);
  assert.match(r.headers['content-type'], /text\/csv/); assert.match(r.headers['content-disposition'], /books-primary-invoice.csv/);
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-export-row-count'], '126');
  const rows = read(r.text); assert.equal(rows.length, 126); assert.equal(new Set(rows.map(r => r.id)).size, 126);
  const posted = rows.find(r => r.id === invoice.id);
  assert.equal(posted.total_inr, '123.45'); assert.equal(posted.settled_inr, '23.45'); assert.equal(posted.balance_inr, '100.00');
  assert.equal(posted.contact_name, customer.name); assert.equal(posted.date, '2026-04-01');
  assert.equal((await download('invoice')).text, r.text);
  assert.equal(read((await download('invoice', '&status=posted')).text).length, 1);
  assert.equal(read((await download('invoice', '&search=BULK-125')).text).length, 1);
  const empty = await download('invoice', '&search=missing'); assert.equal(empty.status, 200); assert.match(empty.text, /balance_inr/); assert.deepEqual(read(empty.text), []);
});
test('directory, statement and item exports flatten fields, convert units and exceed old list limits', async () => {
  const r = await download('banking'); assert.equal(r.status, 200, r.text);
  const rows = read(r.text); assert.equal(rows.length, 1005); assert.equal(rows[0].amount_inr, '-123.45');
  const item = read((await download('items')).text)[0];
  assert.equal(item.sale_rate_inr, '90071992547409.93'); assert.equal(item.purchase_rate_inr, '123.45');
  assert.equal(item.tax_percent, '18.00'); assert.equal(item.stock_quantity, '1.234');
  assert.deepEqual(read((await download('customers')).text).map(r => r.name), [customer.name]);
  const search = await download('banking', '&search=' + encodeURIComponent("%' OR 1=1 --"));
  assert.equal(search.status, 200, search.text); assert.deepEqual(read(search.text), []);
  for (const module of ['vendors', 'payments', 'accounts', 'journals', 'projects', 'time', 'recurring', 'activity']) {
    const r = await download(module); assert.equal(r.status, 200, `${module}: ${r.text}`);
  }
  assert.equal(read((await download('payments', '&transaction_type=bill')).text).length, 0);
});
test('statement pagination reaches the oldest rows and shares filters with export', async () => {
  const scope = get => get.set('X-Books-Company-Id', company);
  const page = await scope(request(app).get('/books/bank-transactions').query({
    page: 21, account_code: '1010', from: '2026-04-02', to: '2026-04-02', status: 'unmatched', search: 'statement',
  }));
  assert.equal(page.status, 200, page.text);
  assert.equal(page.body.total, 1005);
  assert.equal(page.body.data.length, 5);
  const csv = await download('banking', '&account_code=1010&from=2026-04-02&to=2026-04-02&status=unmatched&search=statement');
  assert.equal(csv.status, 200, csv.text);
  assert.deepEqual(read(csv.text).slice(1000).map(row => row.id), page.body.data.map(row => row.id));
  const outOfRange = await scope(request(app).get('/books/bank-transactions?page=22'));
  assert.equal(outOfRange.body.total, 1005);
  assert.deepEqual(outOfRange.body.data, []);
  assert.equal((await scope(request(app).get('/books/bank-transactions?page=0'))).status, 400);
});

test('bank matching enforces company and source grants, exact signed paise, uniqueness and stale-write protection', async () => {
  const journal = await books.manualJournal({
    date: '2026-04-02', reference: 'Quarterly bank fee',
    lines: [{ account_code: '5000', debit: '46.78' }, { account_code: '1010', credit: '46.78' }],
  }, 'test');
  const [line] = await sql`SELECT id::text FROM books_journal_lines WHERE journal_id=${journal.id} AND account_code='1010'`;
  const rows = [
    { date: '2026-04-04', description: 'Bank fee', amount: '-46.78', external_key: 'fee' },
    { date: '2026-04-05', description: 'Same debit', amount: '-46.78', external_key: 'duplicate-debit' },
    { date: '2026-04-05', description: 'Other direction', amount: '46.78', external_key: 'deposit' },
    { date: '2026-04-05', description: 'One paisa off', amount: '-46.79', external_key: 'near-debit' },
    { date: '2026-04-05', description: 'Invoice payment', amount: '23.45', external_key: 'native-payment' },
  ];
  await books.importBank({ account_code: '1010', rows }, 'test');
  await books.importBank({ account_code: '1000', rows: [rows[0]] }, 'test');
  const statements = await books.bankTransactions({ from: '2026-04-04' });
  const bankRow = key => statements.find(row => row.account_code === '1010' && row.external_key === key);
  const [first, second, deposit, near, native] = ['fee', 'duplicate-debit', 'deposit', 'near-debit', 'native-payment'].map(bankRow);
  const cash = statements.find(row => row.account_code === '1000');
  const scope = (req, companyId = company) => req.set('X-Books-Company-Id', companyId);
  const candidates = (id, companyId) => scope(request(app).get(`/books/bank-transactions/${id}/candidates`), companyId);
  const match = (id, body) => scope(request(app).put(`/books/bank-transactions/${id}/match`).send(body));
  const link = { journal_line_id: line.id, match_revision: '0' };
  const member = { id: randomUUID(), role: 'CA' };
  const banking = ['books.banking.view', 'books.banking.manage'];
  try {
    assert.equal((await candidates(first.id, other)).status, 404);
    const balanceBefore = (await books.accounts()).find(account => account.code === '1010').balance;
    await sql`INSERT INTO public.books_company_access(user_id,company_id,permissions)
      VALUES(${member.id},${company},${[...banking, 'books.payments.view']})`;
    user = member;
    assert.deepEqual((await candidates(first.id)).body.data, []);
    assert.equal((await match(first.id, link)).status, 403);
    const nativeOptions = await candidates(native.id);
    assert.deepEqual(nativeOptions.body.data.map(candidate => candidate.source), ['payment']);
    const nativeMatch = await match(native.id, { journal_line_id: nativeOptions.body.data[0].id, match_revision: '0' });
    assert.equal(nativeMatch.status, 200, nativeMatch.text);
    assert.ok(nativeMatch.body.matched_payment_id);
    assert.equal((await match(native.id, { payment_id: null, match_revision: '1' })).status, 200);
    await sql`UPDATE public.books_company_access SET permissions=${[...banking, 'books.journals.view']} WHERE user_id=${member.id}`;
    assert.equal((await candidates(native.id)).body.data.length, 0);
    assert.equal((await match(native.id, { journal_line_id: nativeOptions.body.data[0].id })).status, 403);
    assert.deepEqual((await candidates(first.id)).body.data.map(candidate => [candidate.id, candidate.reference]), [[line.id, journal.reference]]);
    for (const wrong of [deposit, near, cash]) assert.equal((await match(wrong.id, link)).status, 400);
    assert.equal((await match(first.id, link)).status, 200);
    assert.equal((await match(first.id, link)).status, 200);
    await sql`UPDATE public.books_company_access SET permissions=${[...banking, 'books.journals.view', 'books.data.export']} WHERE user_id=${member.id}`;
    const matchedExport = await download('banking', '&status=matched');
    assert.equal(matchedExport.status, 200, matchedExport.text);
    assert.deepEqual(read(matchedExport.text).map(row => [row.id, row.matched_journal_line_id]), [[first.id, line.id]]);
    assert.deepEqual((await candidates(second.id)).body.data, []);
    assert.equal((await match(second.id, link)).status, 409);
    assert.equal((await match(first.id, { payment_id: null, match_revision: '0' })).status, 409);
    assert.equal((await match(first.id, { payment_id: null, match_revision: '1' })).status, 200);
    const audit = await sql`SELECT action,actor FROM books_activity WHERE entity='bank_transaction' AND entity_id=${first.id} ORDER BY id`;
    assert.deepEqual(audit.map(row => [row.action, row.actor]), [['matched', member.id], ['unmatched', member.id]]);
    assert.equal((await books.accounts()).find(account => account.code === '1010').balance, balanceBefore);
  } finally {
    user = { id: 'test', role: 'CA_LEAD' };
    await sql`DELETE FROM books_bank_transactions WHERE date >= '2026-04-04'`;
  }
});
test('ledger export includes reconciled opening and closing balances across more than 500 entries', async () => {
  await sql.begin(async tx => {
    const id = randomUUID();
    await tx`INSERT INTO books_journals(id,date,reference,source,source_id) VALUES (${id},'2026-04-03','Bulk','manual',${randomUUID()})`;
    await tx`INSERT INTO books_journal_lines(journal_id,account_code,debit,credit) SELECT ${id}::uuid,'1000',1,0 FROM generate_series(1,505)`;
    await tx`INSERT INTO books_journal_lines(journal_id,account_code,debit,credit) VALUES (${id},'3000',0,505)`;
  });
  const r = await download('ledger', '&account_code=1000&from=2026-04-01&to=2026-04-30'); assert.equal(r.status, 200, r.text);
  const rows = read(r.text); assert.equal(rows.length, 507);
  assert.equal(rows[0].reference, 'Opening balance'); assert.equal(rows[0].balance_inr, '0.00');
  assert.equal(rows.at(-1).balance_inr, '5.05'); assert.equal(rows.at(-2).balance_inr, '5.05'); assert.equal(rows.at(-1).debit_inr, '5.05');
});
test('exports require both grants, scope company data, and restrict recurring templates', async () => {
  user = { id: 'ca', role: 'CA', permissions: ['books.customers.view'] };
  await sql`INSERT INTO public.books_company_access VALUES ('ca',${company},ARRAY['books.customers.view'])`;
  assert.equal((await download('customers')).status, 403);
  await sql`UPDATE public.books_company_access SET permissions=ARRAY['books.data.export','books.customers.view','books.recurring.view']`;
  assert.equal((await download('invoice')).status, 403);
  assert.equal((await download('ledger', '&account_code=1000')).status, 403);
  assert.equal((await download('customers', '', other)).status, 403);
  assert.deepEqual(read((await download('recurring')).text), []);
  await sql`UPDATE public.books_company_access SET permissions=array_append(permissions,'books.invoice.view')`;
  assert.equal(read((await download('recurring')).text).length, 1);
  user = { id: 'test', role: 'CA_LEAD' };
  assert.deepEqual(read((await download('customers', '', other)).text).map(r => r.name), ['Other private customer']);
  assert.deepEqual(read((await download('customers')).text).map(r => r.name), [customer.name]);
});
test('invalid filters reject before export, and exceeding the record cap fails instead of truncating', async () => {
  for (const query of [{ module: 'document' }, { module: 'invoice', page: '2' }, { module: 'invoice', search: ['a'] }, { module: 'accounts', from: '2026-02-30' }, { module: 'items', status: 'posted' }]) assert.throws(() => validateExport(query));
  assert.equal((await download('ledger', '&account_code=missing')).status, 404);
  assert.equal((await download('invoice', '&module=bill')).status, 400);
  await sql`INSERT INTO books_bank_transactions(account_code,date,description,amount,external_key) SELECT '1010','2026-04-02','overflow',1,'overflow-'||n FROM generate_series(1,49000) n`;
  const r = await download('banking'); assert.equal(r.status, 413); assert.match(r.body.details, /50,000/);
  const filtered = await download('banking', '&search=statement'); assert.equal(filtered.status, 200); assert.equal(read(filtered.text).length, 1005);
});

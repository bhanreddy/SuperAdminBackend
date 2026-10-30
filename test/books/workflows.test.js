const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { createBooksService } = require('../../src/services/books/service');
const {
  calculateLines,
  balanced,
  nextMonth,
} = require('../../src/services/books/domain');
let db, server, sql, books, customer, vendor, item;
const when = new Date().toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata',
});
const input = (kind, contact, rate = '100', extra = {}) => ({
  kind,
  contact_id: contact.id,
  date: when,
  due_date: when,
  lines: [{ description: 'Service', quantity: 1, rate, tax_rate: 18 }],
  ...extra,
});
async function posted(kind, contact, rate = '100', extra = {}) {
  const d = await books.createDocument(
    input(kind, contact, rate, extra),
    'test',
  );
  await books.post(d.id, 'test');
  return books.getDocument(d.id);
}
test.before(async () => {
  db = new PGlite();
  server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 8,
  });
  await server.start();
  sql = postgres(
    `postgres://postgres:postgres@127.0.0.1:${server.server.address().port}/postgres`,
    { ssl: false, max: 3, onnotice: () => {} },
  );
  const connection = await sql.reserve();
  try {
    await connection.unsafe(
      fs.readFileSync(
        path.join(__dirname, '../../src/db/migrations/26_books.sql'),
        'utf8',
      ),
    );
  } finally {
    connection.release();
  }
  const upgrade = await sql.reserve();
  try {
    await upgrade.unsafe(
      fs.readFileSync(
        path.join(__dirname, '../../src/db/migrations/27_books_workflows.sql'),
        'utf8',
      ),
    );
  } finally {
    upgrade.release();
  }
  await sql.unsafe("CREATE TABLE internal_users(id uuid PRIMARY KEY,role text); CREATE TABLE internal_user_permission_overrides(user_id uuid,permission text,effect text);");
  const registryConnection=await sql.reserve();
  try { await registryConnection.unsafe(fs.readFileSync(path.join(__dirname,'../../src/db/migrations/29_books_companies.sql'),'utf8')); } finally {registryConnection.release();}
  const reportingConnection = await sql.reserve();
  try { await reportingConnection.unsafe(fs.readFileSync(path.join(__dirname,'../../src/db/migrations/32_books_statements.sql'),'utf8')); } finally { reportingConnection.release(); }
  books = createBooksService(sql);
  await books.saveSettings(
    { organization_name: 'NexSyrus', state_code: '36' },
    'test',
  );
  customer = await books.saveContact(
    { kind: 'customer', name: 'School A', state_code: '36' },
    'test',
  );
  vendor = await books.saveContact(
    { kind: 'vendor', name: 'Supplier A', state_code: '27' },
    'test',
  );
  item = await books.saveItem(
    {
      name: 'Device',
      sku: 'DEV-1',
      sale_rate: 200,
      purchase_rate: 100,
      tax_rate: 18,
      track_inventory: true,
    },
    'test',
  );
});
test.after(async () => {
  if (sql) await sql.end({ timeout: 3 });
  if (server) await server.stop();
  if (db) await db.close();
});
test('decimal arithmetic is exact and rejects lossy or malformed monetary inputs', () => {
  const r = calculateLines(
    [{ description: 'small', quantity: '3', rate: '0.10', tax_rate: 18 }],
    false,
  );
  assert.equal(r.total, 35);
  assert.equal(r.tax_breakup.cgst + r.tax_breakup.sgst, 5);
  assert.throws(
    () => calculateLines([{ description: 'bad', rate: '1.001' }], false),
    /decimal/,
  );
  assert.throws(() =>
    calculateLines([{ description: 'bad', rate: -1 }], false),
  );
  assert.throws(
    () => calculateLines([{ description: 'bad', rate: 1, discount: 2 }], false),
    /Discount/,
  );
  assert.throws(
    () =>
      balanced([
        { account_code: '1000', debit: 100 },
        { account_code: '3000', credit: 99 },
      ]),
    /balance/,
  );
  assert.equal(nextMonth('2028-01-31', 1), '2028-02-29');
});
test('drafts are excluded; posting, partial payments and payment retry produce one balanced ledger', async () => {
  const d = await books.createDocument(input('invoice', customer), 'test');
  let r = await books.reports();
  assert.equal(r.income, 0);
  await books.post(d.id, 'test');
  await books.post(d.id, 'test');
  r = await books.reports();
  assert.equal(r.income, 10000);
  assert.equal(r.receivables, 11800);
  const payment = {
    document_id: d.id,
    date: when,
    amount: 50,
    account_code: '1010',
    request_key: randomUUID(),
  };
  const p = await books.recordPayment(payment, 'test'),
    retry = await books.recordPayment(payment, 'test');
  assert.equal(p.id, retry.id);
  assert.equal((await books.getDocument(d.id)).balance, 6800);
  await assert.rejects(
    books.recordPayment(
      { ...payment, amount: 100, request_key: randomUUID() },
      'test',
    ),
    /exceeds/,
  );
  await assert.rejects(books.voidDocument(d.id, 'test'), /payments/);
  await assert.rejects(
    books.editDocument(d.id, input('invoice', customer), 'test'),
    /drafts/,
  );
  await books.voidPayment(p.id, 'test');
  await books.voidDocument(d.id, 'test');
  r = await books.reports();
  assert.equal(r.income, 0);
  assert.equal(r.cash, 0);
  assert.equal(
    r.trial.reduce((s, a) => s + Number(a.debit) - Number(a.credit), 0),
    0,
  );
});
test('concurrent payments cannot overpay a document', async () => {
  const d = await posted('invoice', customer);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      books.recordPayment(
        {
          document_id: d.id,
          date: when,
          amount: 80,
          request_key: randomUUID(),
        },
        'test',
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await books.getDocument(d.id)).balance, 3800);
  const p = results.find((r) => r.status === 'fulfilled').value;
  await books.voidPayment(p.id, 'test');
  await books.voidDocument(d.id, 'test');
});
test('purchase, sale, insufficient stock and reversals preserve inventory and tax facts', async () => {
  const lines = (q, r) => [
    {
      item_id: item.id,
      description: 'Device',
      quantity: q,
      rate: r,
      tax_rate: 18,
    },
  ];
  const bill = await posted('bill', vendor, 100, { lines: lines(3, 100) });
  assert.equal(bill.tax_breakup.igst, 5400);
  const inv = await posted('invoice', customer, 200, { lines: lines(2, 200) });
  assert.equal(inv.tax_breakup.cgst, 3600);
  assert.equal(
    Number((await books.items()).find((i) => i.id === item.id).stock_milli),
    1000,
  );
  const failure = await books.createDocument(
    input('invoice', customer, 200, { lines: lines(2, 200) }),
    'test',
  );
  await assert.rejects(books.post(failure.id, 'test'), /Insufficient/);
  assert.equal((await books.getDocument(failure.id)).status, 'draft');
  await assert.rejects(books.voidDocument(bill.id, 'test'), /Insufficient/);
  await books.voidDocument(inv.id, 'test');
  await books.voidDocument(bill.id, 'test');
  assert.equal(
    Number((await books.items()).find((i) => i.id === item.id).stock_milli),
    0,
  );
});
test('quotes convert once and keep a contact snapshot after master data changes', async () => {
  const q = await posted('quote', customer);
  const a = await books.convert(q.id, 'test'),
    b = await books.convert(q.id, 'test');
  assert.equal(a.id, b.id);
  assert.equal(a.status, 'draft');
  await books.saveContact(
    { ...customer, name: 'Renamed School' },
    'test',
    customer.id,
  );
  assert.equal(
    (await books.getDocument(q.id)).contact_snapshot.name,
    'School A',
  );
  await assert.rejects(books.voidDocument(q.id, 'test'), /converted/);
  await books.voidDocument(a.id, 'test');
  await books.voidDocument(q.id, 'test');
});
test('credit allocation cannot exceed available credit and restores due balance when removed', async () => {
  const d = await posted('invoice', customer),
    c = await posted('credit_note', customer, '40');
  const allocation = await books.applyCredit(
    { document_id: d.id, credit_id: c.id, amount: 47.2 },
    'test',
  );
  assert.equal((await books.getDocument(d.id)).balance, 7080);
  await assert.rejects(
    books.applyCredit(
      { document_id: d.id, credit_id: c.id, amount: 1 },
      'test',
    ),
    /exceeds/,
  );
  await assert.rejects(books.voidDocument(c.id, 'test'), /credits/);
  await books.removeCredit(allocation.id, 'test');
  await books.voidDocument(c.id, 'test');
  await books.voidDocument(d.id, 'test');
});
test('bank imports deduplicate and reconcile only matching account, direction and amount', async () => {
  const d = await posted('invoice', customer),
    p = await books.recordPayment(
      { document_id: d.id, date: when, amount: 118, request_key: randomUUID() },
      'test',
    );
  const statement = {
    account_code: '1010',
    rows: [
      {
        date: when,
        description: 'School payment',
        amount: 118,
        external_key: 'bank-1',
      },
    ],
  };
  assert.equal((await books.importBank(statement, 'test')).imported, 1);
  assert.equal((await books.importBank(statement, 'test')).duplicates, 1);
  const [b] = await books.bankTransactions();
  await books.matchBank(b.id, p.id);
  await assert.rejects(books.voidPayment(p.id, 'test'), /Unmatch/);
  await books.matchBank(b.id, null);
  await books.voidPayment(p.id, 'test');
  await books.voidDocument(d.id, 'test');
});
test('database rejects unbalanced inserts and mutations of posted journals/documents', async () => {
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`INSERT INTO books_journals(date,reference,source,source_id) VALUES(${when},'Bad','manual',${randomUUID()})`;
    }),
    /balanced/,
  );
  const d = await posted('invoice', customer);
  await assert.rejects(
    sql`UPDATE books_documents SET total=1 WHERE id=${d.id}`,
    /immutable/,
  );
  const [j] = await sql`SELECT * FROM books_journals WHERE source_id=${d.id}`;
  await assert.rejects(
    sql`UPDATE books_journals SET reference='changed' WHERE id=${j.id}`,
    /immutable/,
  );
  await books.voidDocument(d.id, 'test');
});
test('recurring generation is explicit, idempotent per due date, and creates drafts', async () => {
  const d = await posted('invoice', customer);
  await books.createRecurring({
    template_id: d.id,
    interval_months: 1,
    next_date: when,
  });
  const r = await books.runRecurring('test');
  assert.equal(r.count, 1);
  assert.equal(r.data[0].status, 'draft');
  assert.equal((await books.runRecurring('test')).count, 0);
  await books.voidDocument(d.id, 'test');
});
test('project time can be invoiced once and becomes unbilled when its draft invoice is voided', async () => {
  const project = await books.createProject({
    name: 'Implementation',
    contact_id: customer.id,
    budget: 5000,
    hourly_rate: 600,
  });
  await books.addTime({
    project_id: project.id,
    date: when,
    minutes: 90,
    description: 'Configuration',
  });
  const d = await books.invoiceProject(project.id, 'test');
  assert.equal(Number(d.total), 90000);
  await assert.rejects(books.invoiceProject(project.id, 'test'), /No unbilled/);
  await books.voidDocument(d.id, 'test');
  assert.equal((await books.timeEntries())[0].invoice_id, null);
});
test('API denies unauthenticated requests, surfaces persistence and escapes print HTML', async () => {
  const express = require('express'),
    request = require('supertest');
  const { createBooksRouter } = require('../../src/routes/superadmin/books');
  const app = express();
  app.use(express.json());
  app.use(
    '/books',
    createBooksRouter({
      db: sql,
      authorize: (req, res, next) => {
        if (req.headers.authorization !== 'Bearer test')
          return res.status(401).json({ error: 'Unauthorized' });
        req.user = { id: 'test',isFounder:true };
        next();
      },
    }),
  );
  assert.equal((await request(app).get('/books/bootstrap')).status, 401);
  assert.equal(
    (
      await request(app)
        .get('/books/bootstrap')
        .set('Authorization', 'Bearer test')
    ).status,
    200,
  );
  const d = await books.createDocument(
    input('invoice', customer, 100, { notes: '<script>alert(1)</script>' }),
    'test',
  );
  const print = await request(app)
    .get(`/books/documents/${d.id}/print`)
    .set('Authorization', 'Bearer test');
  assert.equal(print.status, 200);
  assert.ok(print.text.includes('&lt;script&gt;'));
  assert.ok(!print.text.includes('<script>'));
  const invalid = await request(app)
    .post('/books/documents')
    .set('Authorization', 'Bearer test')
    .send({ kind: 'invoice' });
  assert.equal(invalid.status, 400);
  const list = await books.listDocuments({ kind: 'invoice', status: 'draft' });
  assert.ok(list.total > 0);
  assert.ok(
    list.data.every((d) => d.kind === 'invoice' && d.status === 'draft'),
  );
});
test('supporting documents upload and download byte-exact content behind authentication', async () => {
  const express = require('express'),
    request = require('supertest'),
    { createBooksRouter } = require('../../src/routes/superadmin/books');
  const app = express();
  app.use(express.json());
  app.use(
    '/books',
    createBooksRouter({
      db: sql,
      authorize: (req, res, next) => {
        if (req.headers.authorization !== 'Bearer test')
          return res.sendStatus(401);
        req.user = { id: 'test',isFounder:true };
        next();
      },
    }),
  );
  const d = await books.createDocument(input('invoice', customer), 'test'),
    bytes = Buffer.from('%PDF-1.7\nreceipt content');
  const upload = await request(app)
    .post('/books/attachments')
    .set('Authorization', 'Bearer test')
    .field('document_id', d.id)
    .attach('file', bytes, {
      filename: 'receipt.pdf',
      contentType: 'application/pdf',
    });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.size, bytes.length);
  assert.equal(
    upload.body.sha256,
    require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
  );
  const download = await request(app)
    .get(`/books/attachments/${upload.body.id}/download`)
    .set('Authorization', 'Bearer test');
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, bytes);
  assert.match(download.headers['content-disposition'], /attachment/);
  assert.equal(
    (await request(app).get(`/books/attachments/${upload.body.id}/download`))
      .status,
    401,
  );
  assert.equal((await books.attachments(d.id)).length, 1);
});
test('ledger refuses late insertion into an existing journal and scopes credit lists by contact', async () => {
  const j = await books.manualJournal(
    {
      date: when,
      reference: 'Opening cash',
      lines: [
        { account_code: '1000', debit: 10 },
        { account_code: '3000', credit: 10 },
      ],
    },
    'test',
  );
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`INSERT INTO books_journal_lines(journal_id,account_code,debit,credit) VALUES(${j.id},'1000',100,0),(${j.id},'3000',0,100)`;
    }),
    /creating their journal/,
  );
  const other = await books.saveContact(
    { kind: 'customer', name: 'School B', state_code: '36' },
    'test',
  );
  await posted('credit_note', other);
  const list = await books.listDocuments({
    kind: 'credit_note',
    contact_id: customer.id,
    status: 'unpaid',
  });
  assert.ok(list.data.every((d) => d.contact_id === customer.id));
});
test('reapplying the migration preserves posted records and journal balances', async () => {
  const [before] = await sql`SELECT count(*) AS count FROM books_documents`;
  const connection = await sql.reserve();
  try {
    for (const file of ['26_books.sql', '27_books_workflows.sql'])
      await connection.unsafe(
        fs.readFileSync(
          path.join(__dirname, '../../src/db/migrations', file),
          'utf8',
        ),
      );
  } finally {
    connection.release();
  }
  const [after] = await sql`SELECT count(*) AS count FROM books_documents`;
  assert.equal(before.count, after.count);
  const rows =
    await sql`SELECT journal_id,sum(debit-credit) AS balance FROM books_journal_lines GROUP BY journal_id`;
  assert.ok(rows.every((r) => Number(r.balance) === 0));
});
test('standard-cost purchases preserve inventory valuation and post actual-price differences separately', async () => {
  const product = await books.saveItem(
    {
      name: 'Standard cost device',
      sale_rate: 200,
      purchase_rate: 100,
      tax_rate: 0,
      track_inventory: true,
    },
    'test',
  );
  const bill = await posted('bill', vendor, 80, {
    lines: [
      {
        item_id: product.id,
        description: 'Device',
        quantity: 2,
        rate: 80,
        tax_rate: 0,
      },
    ],
  });
  const journal =
    await sql`SELECT l.* FROM books_journal_lines l JOIN books_journals j ON j.id=l.journal_id WHERE j.source_id=${bill.id}`;
  assert.equal(
    Number(journal.find((l) => l.account_code === '1200').debit),
    20000,
  );
  assert.equal(
    Number(journal.find((l) => l.account_code === '5200').credit),
    4000,
  );
  await assert.rejects(
    books.saveItem(
      { ...product, sale_rate: 200, purchase_rate: 80, tax_rate: 0 },
      'test',
      product.id,
    ),
    /Standard cost cannot change/,
  );
  await books.voidDocument(bill.id, 'test');
  assert.equal(
    Number((await books.items()).find((i) => i.id === product.id).stock_milli),
    0,
  );
});
test('document discounts allocate exact paise before tax and signed adjustments balance the ledger', async () => {
  const rows = [
    { description: 'A', quantity: 1, rate: '0.03', tax_rate: 18 },
    { description: 'B', quantity: 1, rate: '0.04', tax_rate: 18 },
  ];
  const preview = calculateLines(rows, false, {
    discount_type: 'amount',
    discount_value: '0.03',
    adjustment: '-0.01',
  });
  assert.equal(
    preview.lines.reduce((s, l) => s + l.document_discount, 0),
    3,
  );
  assert.equal(preview.subtotal, 4);
  assert.equal(preview.total, 3);
  const percent = calculateLines(
    [{ description: 'Subscription', quantity: 1, rate: 100, tax_rate: 18 }],
    false,
    { discount_type: 'percent', discount_value: 10, adjustment: '-0.20' },
  );
  assert.equal(percent.discount_total, 1000);
  assert.equal(percent.tax, 1620);
  assert.equal(percent.total, 10600);
  const d = await posted('invoice', customer, 100, {
    subject: 'Implementation',
    salesperson: 'NexSyrus team',
    terms: 'Pay within 30 days',
    discount_type: 'percent',
    discount_value: 10,
    adjustment: '-0.20',
  });
  assert.equal(Number(d.total), 10600);
  assert.equal(d.subject, 'Implementation');
  assert.equal(Number(d.discount_value), 1000);
  const j =
    await sql`SELECT l.* FROM books_journal_lines l JOIN books_journals j ON j.id=l.journal_id WHERE j.source_id=${d.id}`;
  assert.equal(
    j.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0),
    0,
  );
  assert.equal(Number(j.find((l) => l.account_code === '4900').debit), 20);
  const html = require('../../src/services/books/print').printDocument(d);
  assert.match(html, /Pay within 30 days/);
  assert.match(html, /Implementation/);
  await books.voidDocument(d.id, 'test');
  await assert.rejects(
    books.createDocument(
      input('invoice', customer, 100, {
        discount_type: 'percent',
        discount_value: 101,
      }),
      'test',
    ),
    /100%/,
  );
});
test('delivery challans finalize without ledger or stock effects and convert exactly once into editable invoice drafts', async () => {
  const d = await books.createDocument(
    input('delivery_challan', customer, 0, {
      challan_type: 'job_work',
      subject: 'Materials for repair',
      terms: 'Return after repair',
    }),
    'test',
  );
  const before = await sql`SELECT count(*) AS n FROM books_journals`;
  await books.post(d.id, 'test');
  const after = await sql`SELECT count(*) AS n FROM books_journals`;
  assert.equal(before[0].n, after[0].n);
  const inv = await books.convert(d.id, 'test');
  assert.equal(inv.kind, 'invoice');
  assert.equal(inv.status, 'draft');
  assert.equal(inv.terms, 'Return after repair');
  assert.equal((await books.convert(d.id, 'test')).id, inv.id);
  await assert.rejects(books.post(inv.id, 'test'), /positive total/);
  await books.editDocument(
    inv.id,
    input('invoice', customer, 100, { subject: inv.subject, terms: inv.terms }),
    'test',
  );
  await books.post(inv.id, 'test');
  await books.voidDocument(inv.id, 'test');
  await books.voidDocument(d.id, 'test');
  await assert.rejects(
    books.createDocument(input('delivery_challan', customer, 0), 'test'),
    /challan type/,
  );
});
test('discounts and adjustments survive source conversion without being applied twice', async () => {
  const q = await posted('quote', customer, 100, {
    discount_type: 'amount',
    discount_value: 10,
    adjustment: 1,
    subject: 'Proposal',
    terms: 'Valid 30 days',
  });
  const inv = await books.convert(q.id, 'test');
  assert.equal(Number(inv.subtotal), 9000);
  assert.equal(Number(inv.tax), 1620);
  assert.equal(Number(inv.total), 10720);
  assert.equal(inv.subject, 'Proposal');
  assert.equal(inv.discount_type, 'amount');
  assert.equal(Number(inv.discount_value), 1000);
  await books.voidDocument(inv.id, 'test');
  await books.voidDocument(q.id, 'test');
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const postgres = require("postgres");
const { PGlite } = require("@electric-sql/pglite");
const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
const { createBooksService } = require("../../src/services/books/service");
const {
  createFinanceConnections,
} = require("../../src/services/books/financeConnections");
let db, server, sql, books;
const migration = (file) =>
  fs.readFileSync(
    path.join(__dirname, "../../src/db/migrations", file),
    "utf8"
  );
const balance = async (code) =>
  Number(
    (
      await sql`SELECT COALESCE(sum(debit-credit),0) AS n FROM books_journal_lines WHERE account_code=${code}`
    )[0].n
  );
const journalCount = async () =>
  Number((await sql`SELECT count(*) AS n FROM books_journals`)[0].n);
const apply = async (file) => {
  const c = await sql.reserve();
  try {
    await c.unsafe(migration(file));
  } finally {
    c.release();
  }
};
const invoice = async (type, total, taxable, extra = {}) =>
  sql.begin(async (tx) => {
    const [row] =
      await tx`INSERT INTO billing_documents(document_type,document_number,status,total_amount,taxable_value,client_legal_name,issued_at,settles_invoice_id,cgst_amount,sgst_amount,igst_amount)
    VALUES(${type},${"BILL-" + Math.random()},'issued',${total},${taxable},${
        extra.name || "School A"
      },now(),${extra.invoice || null},${extra.cgst || 0},${extra.sgst || 0},${
        extra.igst || 0
      }) RETURNING *`;
    return row;
  });
test.before(async () => {
  db = new PGlite();
  server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 8,
  });
  await server.start();
  sql = postgres(
    `postgres://postgres:postgres@127.0.0.1:${
      server.server.address().port
    }/postgres`,
    { ssl: false, prepare: false, max: 1, onnotice: () => {} }
  );
  await apply("26_books.sql");
  await apply("27_books_workflows.sql");

  await sql.unsafe(`CREATE TABLE expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text,description text,school_id int,amount numeric(12,2),category text,status text,receipt_url text,created_at timestamptz DEFAULT now());
    CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),amount numeric(12,2),status text,payment_mode text,month int,year int,notes text,created_at timestamptz DEFAULT now());
    CREATE TABLE billing_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_type text,document_number text,status text,total_amount numeric(12,2),taxable_value numeric(12,2),client_legal_name text,issued_at timestamptz,cgst_amount numeric,sgst_amount numeric,igst_amount numeric);
    CREATE TABLE payroll_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),employee_id uuid DEFAULT gen_random_uuid(),payroll_year int,payroll_month int,gross_pay numeric,net_pay numeric,pf_deduction numeric,esi_deduction numeric,other_deductions numeric,status text,paid_at timestamptz);`);
  await apply("30_books_finance_connections.sql");
  await apply("32_books_statements.sql");
  books = createBooksService(sql);
});
test.after(async () => {
  if (sql) await sql.end({ timeout: 3 });
  if (server) await server.stop();
  if (db) await db.close();
});
test("expense approval accrues, repeated approval and receipt edits do not duplicate, paid clears payable", async () => {
  const before = await journalCount(),
    cost = await balance("5000"),
    cash = await balance("1010"),
    payable = await balance("2050");
  const [e] =
    await sql`INSERT INTO expenses(title,amount,category,status) VALUES('Cloud hosting',120.55,'HOSTING','PENDING') RETURNING *`;
  assert.equal(await journalCount(), before);
  await sql`UPDATE expenses SET status='APPROVED' WHERE id=${e.id}`;
  assert.equal(await balance("5000"), cost + 12055);
  assert.equal(await balance("2050"), payable - 12055);
  assert.equal(await balance("1010"), cash);
  await sql`UPDATE expenses SET status='APPROVED',receipt_url='receipt.jpg' WHERE id=${e.id}`;
  assert.equal(await journalCount(), before + 1);
  await sql`UPDATE expenses SET paid_at=now(),paid_account='1010' WHERE id=${e.id}`;
  assert.equal(await balance("2050"), payable);
  assert.equal(await balance("1010"), cash - 12055);
  const after = await journalCount();
  await sql`UPDATE expenses SET title=title WHERE id=${e.id}`;
  assert.equal(await journalCount(), after);
  await assert.rejects(
    sql.begin((tx) => tx`DELETE FROM expenses WHERE id=${e.id}`),
    /reversed, not deleted/
  );
});
test("source corrections reverse immutable journals and school expenses never enter platform books", async () => {
  const before = await balance("5000");
  const [e] =
    await sql`INSERT INTO expenses(title,amount,category,status) VALUES('Travel',10,'TRAVEL','APPROVED') RETURNING *`;
  await sql`UPDATE expenses SET amount=12.34 WHERE id=${e.id}`;
  assert.equal(await balance("5000"), before + 1234);
  await sql`UPDATE expenses SET status='REJECTED' WHERE id=${e.id}`;
  assert.equal(await balance("5000"), before);
  await sql`UPDATE expenses SET status='APPROVED' WHERE id=${e.id}`;
  assert.equal(await balance("5000"), before + 1234);
  const count = await journalCount();
  await sql`INSERT INTO expenses(title,amount,category,status,school_id) VALUES('School spend',99,'MISC','APPROVED',1)`;
  assert.equal(await journalCount(), count);
});
test("collections post only on approval and rejection reverses both cash and revenue", async () => {
  const cash = await balance("1000"),
    income = await balance("4000");
  const [c] =
    await sql`INSERT INTO collections(amount,status,payment_mode,month,year) VALUES(42.35,'PENDING','CASH',10,2026) RETURNING *`;
  await sql`UPDATE collections SET status='APPROVED' WHERE id=${c.id}`;
  assert.equal(await balance("1000"), cash + 4235);
  assert.equal(await balance("4000"), income - 4235);
  await sql`UPDATE collections SET status='REJECTED' WHERE id=${c.id}`;
  assert.equal(await balance("1000"), cash);
  assert.equal(await balance("4000"), income);
});
test("tax invoice, partial receipt and cancellation reconcile receivables without duplicate revenue", async () => {
  const income = await balance("4000"),
    receivable = await balance("1100"),
    tax = await balance("2200"),
    cash = await balance("1010");
  const i = await invoice("tax_invoice", 118, 100, { cgst: 9, sgst: 9 });
  const r = await invoice("receipt", 50, 50, { invoice: i.id });
  assert.equal(await balance("4000"), income - 10000);
  assert.equal(await balance("2200"), tax - 1800);
  assert.equal(await balance("1100"), receivable + 6800);
  assert.equal(await balance("1010"), cash + 5000);
  await assert.rejects(
    invoice("receipt", 69, 69, { invoice: i.id }),
    /exceeds invoice balance/
  );
  await assert.rejects(
    invoice("receipt", 1, 1, { invoice: i.id, name: "Other school" }),
    /same customer/
  );
  await assert.rejects(
    sql.begin(
      (tx) =>
        tx`UPDATE billing_documents SET status='cancelled' WHERE id=${i.id}`
    ),
    /Cancel linked receipts/
  );
  const report = await books.reports();
  assert.ok(
    report.aging.some((a) => a.id === i.id && Number(a.balance) === 6800)
  );
  assert.ok(
    report.taxes.some(
      (a) => a.kind === "Client tax invoices" && Number(a.tax) >= 1800
    )
  );
  await sql`UPDATE billing_documents SET status='cancelled' WHERE id=${r.id}`;
  await sql`UPDATE billing_documents SET status='cancelled' WHERE id=${i.id}`;
  assert.equal(await balance("4000"), income);
  assert.equal(await balance("1100"), receivable);
  assert.equal(await balance("2200"), tax);
  assert.equal(await balance("1010"), cash);
});
test("standalone receipt records non-tax income and reverses on cancellation", async () => {
  const income = await balance("4000"),
    cash = await balance("1010");
  const r = await invoice("receipt", 100, 100);
  assert.equal(await balance("4000"), income - 10000);
  assert.equal(await balance("1010"), cash + 10000);
  await sql`UPDATE billing_documents SET status='cancelled' WHERE id=${r.id}`;
  assert.equal(await balance("4000"), income);
  assert.equal(await balance("1010"), cash);
});
test("payroll accrues gross cost, statutory deductions and net payable; paid only clears net", async () => {
  const wages = await balance("5300"),
    salary = await balance("2100"),
    pf = await balance("2110"),
    esi = await balance("2120"),
    other = await balance("2130"),
    cash = await balance("1010");
  const [p] =
    await sql`INSERT INTO payroll_runs(payroll_year,payroll_month,gross_pay,net_pay,pf_deduction,esi_deduction,other_deductions,status) VALUES(2026,10,1000,850,100,20,30,'PROCESSED') RETURNING *`;
  assert.equal(await balance("5300"), wages + 100000);
  assert.equal(await balance("2100"), salary - 85000);
  assert.equal(await balance("2110"), pf - 10000);
  assert.equal(await balance("2120"), esi - 2000);
  assert.equal(await balance("2130"), other - 3000);
  await sql`UPDATE payroll_runs SET status='PAID',paid_at=now() WHERE id=${p.id}`;
  assert.equal(await balance("5300"), wages + 100000);
  assert.equal(await balance("2100"), salary);
  assert.equal(await balance("1010"), cash - 85000);
  const count = await journalCount();
  await sql`UPDATE payroll_runs SET status='PAID' WHERE id=${p.id}`;
  assert.equal(await journalCount(), count);
});
test("bad accounting rolls the source write back instead of leaving a disconnected approval", async () => {
  const count = await journalCount();
  await assert.rejects(
    sql.begin(
      (tx) =>
        tx`INSERT INTO expenses(title,amount,category,status) VALUES('Negative',-1,'MISC','APPROVED')`
    ),
    /positive/
  );
  const [row] =
    await sql`SELECT count(*)::int AS n FROM expenses WHERE title='Negative'`;
  assert.equal(row.n, 0);
  assert.equal(await journalCount(), count);
});
test("migration is repeatable and historical import is explicit, bounded and idempotent", async () => {
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE expenses DISABLE TRIGGER books_connect_expenses`;
    await tx`INSERT INTO expenses(title,amount,category,status) VALUES('Historical',77,'TOOLS','APPROVED')`;
    await tx`ALTER TABLE expenses ENABLE TRIGGER books_connect_expenses`;
  });
  await apply("30_books_finance_connections.sql");
  await apply("32_books_statements.sql");
  const overview = await createFinanceConnections(sql).overview();
  assert.equal(
    overview.summary.find((x) => x.source_type === "expense").unlinked,
    1
  );
  const count = await journalCount();
  await sql.begin(async (tx) => {
    const scoped = (...args) => tx(...args);
    scoped.json = (...args) => tx.json(...args);
    scoped.unsafe = (...args) => tx.unsafe(...args);
    await createFinanceConnections(scoped).importExisting("test");
  });
  assert.equal(await journalCount(), count + 1);
  await sql.begin(async (tx) => {
    const scoped = (...args) => tx(...args);
    scoped.json = (...args) => tx.json(...args);
    scoped.unsafe = (...args) => tx.unsafe(...args);
    const result = await createFinanceConnections(scoped).importExisting(
      "test"
    );
    assert.equal(result.imported, 0);
  });
  assert.equal(await journalCount(), count + 1);
});
test("company isolation keeps central sources out of secondary company reports and imports", async () => {
  await sql`CREATE SCHEMA isolated_company`;
  await sql.begin(async (tx) => {
    await tx`SET LOCAL search_path TO isolated_company,pg_catalog`;
    const scoped = (...args) => tx(...args);
    await assert.rejects(
      createFinanceConnections(scoped).overview(),
      /Nexsyrus only/
    );
  });
});
test("Books connection endpoints enforce company memberships and separate viewing from historical import", async () => {
  const express = require("express"),
    request = require("supertest");
  await sql.unsafe(
    "CREATE TABLE internal_users(id uuid PRIMARY KEY,role text); CREATE TABLE internal_user_permission_overrides(user_id uuid,permission text,effect text);"
  );
  await apply("29_books_companies.sql");
  const [company] =
    await sql`SELECT id FROM books_companies WHERE code='nexsyrus'`;
  const [other] =
    await sql`SELECT id FROM books_companies WHERE code='nexmaxx'`;
  const [{ id }] = await sql`SELECT gen_random_uuid() AS id`;
  await sql`INSERT INTO internal_users(id,role) VALUES(${id},'CA')`;
  await sql`INSERT INTO books_company_access(user_id,company_id,permissions) VALUES(${id},${
    company.id
  },${sql.json(["books.connections.view"])})`;
  let user = {
    id,
    role: "CA",
    isFounder: false,
    permissions: ["books.connections.view"],
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/books",
    require("../../src/routes/superadmin/books").createBooksRouter({
      db: sql,
      authorize: (req, res, next) => {
        req.user = user;
        next();
      },
    })
  );
  const overview = await request(app)
    .get("/books/connections")
    .set("X-Books-Company-Id", company.id);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.summary.length, 4);
  assert.equal(
    (
      await request(app)
        .post("/books/connections/import")
        .set("X-Books-Company-Id", company.id)
    ).status,
    403
  );
  assert.equal(
    (
      await request(app)
        .get("/books/connections")
        .set("X-Books-Company-Id", other.id)
    ).status,
    403
  );
  user = { ...user, isFounder: true, role: "FOUNDER" };
  const imported = await request(app)
    .post("/books/connections/import")
    .set("X-Books-Company-Id", company.id);
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 0);
});
test("a first receipt atomically connects its historical invoice before settling receivables", async () => {
  const before = await balance("1100");
  let original;
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE billing_documents DISABLE TRIGGER books_connect_billing`;
    [original] =
      await tx`INSERT INTO billing_documents(document_type,document_number,status,total_amount,taxable_value,client_legal_name,issued_at) VALUES('tax_invoice','HISTORICAL-INVOICE','issued',118,100,'School A',now()) RETURNING *`;
    await tx`ALTER TABLE billing_documents ENABLE TRIGGER books_connect_billing`;
  });
  await invoice("receipt", 50, 50, { invoice: original.id });
  assert.equal(await balance("1100"), before + 6800);
  const [link] =
    await sql`SELECT * FROM books_finance_links WHERE source_type='billing' AND source_id=${original.id}`;
  assert.equal(link.state, "posted");
});
test("historical import stops at 200 source rows and resumes without repeating entries", async () => {
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE expenses DISABLE TRIGGER books_connect_expenses`;
    await tx`INSERT INTO expenses(id,title,amount,category,status,created_at) SELECT gen_random_uuid(),'History ' || n,1,'MISC','APPROVED',now() FROM generate_series(1,201) n`;
    await tx`ALTER TABLE expenses ENABLE TRIGGER books_connect_expenses`;
  });
  const imported = () =>
    sql.begin(async (tx) => {
      const scoped = (...args) => tx(...args);
      scoped.json = (...args) => tx.json(...args);
      scoped.unsafe = (...args) => tx.unsafe(...args);
      return createFinanceConnections(scoped).importExisting("test");
    });
  const first = await imported();
  assert.equal(first.imported, 200);
  assert.equal(
    first.summary.find((s) => s.source_type === "expense").unlinked,
    1
  );
  const second = await imported();
  assert.equal(second.imported, 1);
  assert.equal(
    second.summary.find((s) => s.source_type === "expense").unlinked,
    0
  );
  const third = await imported();
  assert.equal(third.imported, 0);
});
test("expense source APIs persist dates, reject invalid transitions and clear payables once; summary matches Books", async () => {
  await sql.unsafe(
    `ALTER TABLE expenses ADD COLUMN created_by_founder_id uuid, ADD COLUMN approved_by_founder_id uuid, ADD COLUMN rejection_reason text; ALTER TABLE collections ADD COLUMN business_unit_id uuid;`
  );
  const mock = (relative, exports) => {
    const file = require.resolve(relative);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  mock("../../src/config/db", sql);
  mock("../../src/config/crmDb", sql);
  mock("../../src/config/supabase", { schoolSupabaseAdmin: {} });
  mock("../../src/middleware/verifySuperAdmin", {
    verifySuperAdminMiddleware: (req, res, next) => {
      req.superAdmin = {
        id: "00000000-0000-4000-8000-000000000001",
        isSuperAdmin: true,
      };
      next();
    },
  });
  const express = require("express"),
    request = require("supertest"),
    app = express();
  app.use(express.json());
  app.use("/founder", require("../../src/routes/superadmin/founderCrm"));
  const created = await request(app)
    .post("/founder/expenses")
    .send({
      title: "API hosting",
      amount: "25.50",
      category: "HOSTING",
      expense_date: "2026-10-28",
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.expense_date.slice(0, 10), "2026-10-28");
  const id = created.body.id;
  assert.equal(
    (
      await request(app)
        .post(`/founder/expenses/${id}/paid`)
        .send({ account_code: "1010" })
    ).status,
    409
  );
  assert.equal(
    (await request(app).post(`/founder/expenses/${id}/approve`).send({}))
      .status,
    200
  );
  assert.equal(
    (
      await request(app)
        .post(`/founder/expenses/${id}/reject`)
        .send({ reason: "stale" })
    ).status,
    409
  );
  const cash = await balance("1010");
  assert.equal(
    (
      await request(app)
        .post(`/founder/expenses/${id}/paid`)
        .send({ account_code: "1010" })
    ).status,
    200
  );
  assert.equal(
    (
      await request(app)
        .post(`/founder/expenses/${id}/paid`)
        .send({ account_code: "1010" })
    ).status,
    200
  );
  assert.equal(await balance("1010"), cash - 2550);
  assert.equal(
    (
      await request(app)
        .post(`/founder/expenses/${id}/paid`)
        .send({ account_code: "1000" })
    ).status,
    409
  );
  const listed = await request(app).get("/founder/expenses");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.find((r) => r.id === id).books_payment_journal_id);
  const summary = await request(app).get(
    "/founder/financial-summary?period=ALL"
  );
  assert.equal(summary.status, 200);
  const report = await books.reports();
  assert.equal(summary.body.revenue, report.income / 100);
  assert.equal(summary.body.expenses, report.expenses / 100);
  assert.equal(summary.body.accounting_source, "books");
  const bad = await request(app)
    .post("/founder/expenses")
    .send({
      title: "Bad date",
      amount: "1",
      category: "TOOLS",
      expense_date: "2026-02-31",
    });
  assert.equal(bad.status, 400);
});

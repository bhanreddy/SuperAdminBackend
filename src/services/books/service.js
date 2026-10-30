const statements = require('./statements');
const D = require('./domain');
const {canBooks,BOOKS_MODULES,DOCUMENT_MODULES}=require('../../config/booksPermissions');
const {
  ensure,
  text,
  required,
  date,
  money,
  uuid,
  randomUUID,
  KINDS,
  POSTING,
  SALES,
  PREFIX,
  calculateLines,
  balanced,
  nextMonth,
  rounded,
} = D;
const dollars = (n) => (Number(n) / 100).toFixed(2);
const qty = (n) => (Number(n) / 1000).toFixed(3);
const calendar = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value;
const documentRow = (row) => ({
  ...row,
  date: calendar(row.date),
  due_date: calendar(row.due_date),
});
const today = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function createBooksService(db) {
  async function activity(tx, entity, id, action, actor, details = {}) {
    await tx`INSERT INTO books_activity(entity,entity_id,action,actor,details) VALUES(${entity},${id},${action},${actor || null},${tx.json(details)})`;
  }
  async function journal(tx, input, lines) {
    ensure(!input.cash_flow_activity || ['operating','investing','financing'].includes(input.cash_flow_activity), 'Invalid cash flow activity');
    balanced(lines);
    for (const code of [...new Set(lines.map((l) => l.account_code))]) {
      const [a] = await tx`SELECT code FROM books_accounts WHERE code=${code}`;
      ensure(a, `Unknown account ${code}`);
    }
    const [j] =
      await tx`INSERT INTO books_journals(date,reference,notes,source,source_id,reversal_of,created_by,cash_flow_activity)
      VALUES(${input.date},${input.reference},${input.notes || ''},${input.source},${input.source_id},${input.reversal_of || null},${input.actor || null},${input.cash_flow_activity || null}) RETURNING *`;
    for (const l of lines)
      await tx`INSERT INTO books_journal_lines(journal_id,account_code,debit,credit) VALUES(${j.id},${l.account_code},${l.debit || 0},${l.credit || 0})`;
    return j;
  }
  async function reverse(tx, source, id, actor) {
    const [j] =
      await tx`SELECT * FROM books_journals WHERE source=${source} AND source_id=${id}`;
    if (!j) return;
    const lines =
      await tx`SELECT * FROM books_journal_lines WHERE journal_id=${j.id}`;
    await journal(
      tx,
      {
        date: today(),
        reference: `Void ${j.reference}`,
        source: 'reversal',
        source_id: id,
        reversal_of: j.id,
        actor,
      },
      lines.map((l) => ({
        account_code: l.account_code,
        debit: Number(l.credit),
        credit: Number(l.debit),
      })),
    );
  }
  async function cashAccount(tx, code) {
    const [a] =
      await tx`SELECT * FROM books_accounts WHERE code=${code} AND is_cash=true`;
    ensure(a, 'Select a cash or bank account');
    return a;
  }
  async function number(tx, kind, value) {
    const year = Number(date(value).slice(0, 4));
    const [row] =
      await tx`INSERT INTO books_counters(kind,year,value) VALUES(${kind},${year},1)
      ON CONFLICT(kind,year) DO UPDATE SET value=books_counters.value+1 RETURNING value`;
    return `${PREFIX[kind]}/${year}/${String(row.value).padStart(5, '0')}`;
  }
  async function prepare(tx, input) {
    ensure(KINDS.includes(input.kind), 'Unsupported document type');
    const [settings] = await tx`SELECT * FROM books_settings WHERE id=1`;
    let contact = null;
    if (input.contact_id) {
      [contact] =
        await tx`SELECT * FROM books_contacts WHERE id=${uuid(input.contact_id)} AND active=true`;
      ensure(contact, 'Contact not found');
      const wanted = SALES.includes(input.kind) ? 'customer' : 'vendor';
      ensure(
        contact.kind === wanted || contact.kind === 'both',
        `Select a ${wanted}`,
      );
    } else ensure(input.kind === 'expense', 'Select a contact');
    const lines = input.lines;
    if (Array.isArray(lines))
      for (const l of lines)
        if (l.item_id) {
          const [item] =
            await tx`SELECT * FROM books_items WHERE id=${uuid(l.item_id)} AND active=true`;
          ensure(item, 'An item is missing or inactive');
        }
    const taxable =
      Array.isArray(lines) && lines.some((l) => Number(l.tax_rate) > 0);
    if (taxable)
      ensure(
        /^\d{2}$/.test(settings.state_code) &&
          /^\d{2}$/.test(contact?.state_code || input.state_code),
        'Set organization and contact state codes before using tax',
      );
    if (input.kind === 'delivery_challan')
      ensure(
        [
          'supply_of_liquid_gas',
          'job_work',
          'supply_on_approval',
          'others',
        ].includes(input.challan_type),
        'Select a challan type',
      );
    const calc = calculateLines(
      lines,
      (contact?.state_code || input.state_code) !== settings.state_code,
      {
        discount_type: input.discount_type,
        discount_value: input.discount_value,
        adjustment: input.adjustment,
        allow_zero: true,
      },
    );
    const when = date(input.date),
      due =
        input.kind !== 'delivery_challan' && input.due_date
          ? date(input.due_date, 'Due date')
          : null;
    if (due) ensure(due >= when, 'Due date cannot precede the document date');
    const paidAccount =
      input.kind === 'expense' ? input.paid_account || '1000' : null;
    if (paidAccount) await cashAccount(tx, paidAccount);
    return {
      ...calc,
      contact,
      settings,
      date: when,
      due_date: due,
      paid_account: paidAccount,
    };
  }
  async function createDocumentTx(tx, input, actor, sourceId = null) {
    const p = await prepare(tx, input),
      num = await number(tx, input.kind, p.date);
    const [doc] =
      await tx`INSERT INTO books_documents(kind,number,contact_id,contact_snapshot,organization_snapshot,date,due_date,reference,notes,lines,subtotal,tax,total,tax_breakup,paid_account,source_id,created_by,subject,salesperson,terms,discount_type,discount_value,discount_total,adjustment,adjustment_description,challan_type)
      VALUES(${input.kind},${num},${p.contact?.id || null},${tx.json(p.contact || { name: 'Expense' })},${tx.json(p.settings)},${p.date},${p.due_date},${text(input.reference)},${text(input.notes, 4000)},${tx.json(p.lines)},${p.subtotal},${p.tax},${p.total},${tx.json(p.tax_breakup)},${p.paid_account},${sourceId},${actor || null},${text(input.subject, 500)},${text(input.salesperson, 150)},${text(input.terms, 8000)},${p.discount_type},${p.discount_value},${p.discount_total},${p.adjustment},${text(input.adjustment_description, 100) || 'Adjustment'},${input.kind === 'delivery_challan' ? input.challan_type : ''}) RETURNING *`;
    await activity(tx, 'document', doc.id, 'created', actor);
    return documentRow(doc);
  }
  async function getDocumentTx(tx, id, lock = false) {
    const [doc] = lock
      ? await tx`SELECT * FROM books_documents WHERE id=${uuid(id)} FOR UPDATE`
      : await tx`SELECT * FROM books_documents WHERE id=${uuid(id)}`;
    ensure(doc, 'Document not found', 404);
    return documentRow(doc);
  }
  async function settled(tx, id) {
    const [p] =
      await tx`SELECT COALESCE(sum(amount),0) AS total FROM books_payments WHERE document_id=${id} AND status='posted'`;
    const [c] =
      await tx`SELECT COALESCE(sum(amount),0) AS total FROM books_credit_applications WHERE document_id=${id} OR credit_id=${id}`;
    return Number(p.total) + Number(c.total);
  }
  async function stockAndCost(tx, doc, reversal = false) {
    const movements = new Map();
    let inventoryAmount = 0,
      cost = 0;
    // Lock a stable item order; repeated lines share the same locked item and aggregate delta.
    for (const id of [
      ...new Set(doc.lines.map((l) => l.item_id).filter(Boolean)),
    ].sort()) {
      const [item] =
        await tx`SELECT * FROM books_items WHERE id=${id} FOR UPDATE`;
      ensure(item, 'Item not found');
      if (!item.track_inventory) continue;
      const ls = doc.lines.filter((l) => l.item_id === id);
      const units = ls.reduce((s, l) => s + Number(l.quantity_milli), 0);
      const amount = ls.reduce((s, l) => s + Number(l.amount), 0);
      ensure(doc.kind !== 'expense', 'Use a bill to receive inventory items');
      let sign = ['bill', 'credit_note'].includes(doc.kind) ? 1 : -1;
      if (reversal) sign *= -1;
      ensure(
        Number(item.stock_milli) + units * sign >= 0,
        'Insufficient stock. Record a purchase or opening stock before selling/returning these items',
        409,
      );
      movements.set(id, units * sign);
      inventoryAmount += amount;
      // Standard cost is frozen on the posted invoice via its journal. Voids reverse that journal.
      cost += rounded(BigInt(units) * BigInt(item.purchase_rate), 1000n);
    }
    for (const [id, delta] of movements) {
      await tx`UPDATE books_items SET stock_milli=stock_milli+${delta} WHERE id=${id}`;
      await tx`INSERT INTO books_stock_movements(item_id,document_id,quantity_milli,reason) VALUES(${id},${doc.id},${delta},${reversal ? 'void' : doc.kind})`;
    }
    return { inventoryAmount, cost };
  }
  async function post(id, actor) {
    return db.begin(async (tx) => {
      const d = await getDocumentTx(tx, id, true);
      if (d.status === 'posted') return d;
      ensure(d.status === 'draft', 'Only drafts can be posted', 409);
      if (POSTING.includes(d.kind)) {
        ensure(
          Number(d.total) > 0,
          'Add a positive total before posting this financial document',
        );
        const { inventoryAmount, cost } = await stockAndCost(tx, d);
        const lines = [],
          add = (account_code, debit, credit) => {
            const net = debit - credit;
            if (net)
              lines.push({
                account_code,
                debit: net > 0 ? net : 0,
                credit: net < 0 ? -net : 0,
              });
          };
        const total = Number(d.total),
          subtotal = Number(d.subtotal),
          tax = Number(d.tax);
        if (d.kind === 'invoice' || d.kind === 'credit_note') {
          add('1100', total, 0);
          add('4000', 0, subtotal);
          add('2200', 0, tax);
          add('4900', 0, Number(d.adjustment));
          add('5100', cost, 0);
          add('1200', 0, cost);
        } else {
          add('1200', cost, 0);
          add('5000', subtotal - inventoryAmount, 0);
          add('5200', inventoryAmount - cost, 0);
          add('1300', tax, 0);
          add('5900', Number(d.adjustment), 0);
          add(d.kind === 'expense' ? d.paid_account : '2000', 0, total);
        }
        const reverseDirection = ['credit_note', 'vendor_credit'].includes(
          d.kind,
        );
        await journal(
          tx,
          {
            date: d.date,
            reference: d.number,
            source: 'document',
            source_id: d.id,
            actor,
          },
          reverseDirection
            ? lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }))
            : lines,
        );
      }
      const [updated] =
        await tx`UPDATE books_documents SET status='posted',posted_at=now() WHERE id=${id} RETURNING *`;
      await activity(tx, 'document', id, 'posted', actor);
      return documentRow(updated);
    });
  }
  async function voidDocument(id, actor) {
    return db.begin(async (tx) => {
      const d = await getDocumentTx(tx, id, true);
      if (d.status === 'void') return d;
      ensure(
        (await settled(tx, id)) === 0,
        'Void payments and remove applied credits before voiding this document',
        409,
      );
      if (d.status === 'posted' && POSTING.includes(d.kind)) {
        await stockAndCost(tx, d, true);
        await reverse(tx, 'document', id, actor);
      }
      const [converted] =
        await tx`SELECT id FROM books_documents WHERE source_id=${id} AND status<>'void'`;
      ensure(!converted, 'Void the converted document first', 409);
      const [time] =
        await tx`SELECT id FROM books_time_entries WHERE invoice_id=${id} LIMIT 1`;
      if (time)
        await tx`UPDATE books_time_entries SET invoice_id=NULL WHERE invoice_id=${id}`;
      const [updated] =
        await tx`UPDATE books_documents SET status='void' WHERE id=${id} RETURNING *`;
      await tx`UPDATE books_recurring SET active=false WHERE template_id=${id}`;
      await activity(tx, 'document', id, 'voided', actor);
      return documentRow(updated);
    });
  }
  function copyInput(d, when, kind = d.kind) {
    return {
      kind,
      contact_id: d.contact_id,
      date: when,
      due_date: null,
      reference: d.number,
      notes: d.notes,
      subject: d.subject,
      salesperson: d.salesperson,
      terms: d.terms,
      discount_type: d.discount_type,
      discount_value: dollars(d.discount_value),
      adjustment: dollars(d.adjustment),
      adjustment_description: d.adjustment_description,
      challan_type: d.challan_type,
      paid_account: d.paid_account,
      lines: d.lines.map((l) => ({
        item_id: l.item_id,
        description: l.description,
        hsn_sac: l.hsn_sac,
        quantity: qty(l.quantity_milli),
        rate: dollars(l.rate),
        discount: dollars(l.discount),
        tax_rate: dollars(l.tax_rate),
      })),
    };
  }
  async function listDocuments(filter = {}) {
    if (filter.kind)
      ensure(KINDS.includes(filter.kind), 'Invalid document type');
    const page = Math.max(1, Math.min(100000, Number(filter.page) || 1));
    const search = text(filter.search, 100),
      kind = filter.kind || '',
      status = filter.status || '',
      contact = filter.contact_id ? uuid(filter.contact_id) : '';
    ensure(
      !status ||
        ['draft', 'posted', 'void', 'overdue', 'unpaid', 'paid'].includes(
          status,
        ),
      'Invalid status',
    );
    const rows =
      await db`SELECT d.*, COALESCE(p.paid,0)+COALESCE(c.applied,0) AS settled,
      GREATEST(d.total-COALESCE(p.paid,0)-COALESCE(c.applied,0),0) AS balance,
      count(*) OVER() AS row_count FROM books_documents d
      LEFT JOIN (SELECT document_id,sum(amount) paid FROM books_payments WHERE status='posted' GROUP BY document_id) p ON p.document_id=d.id
      LEFT JOIN (SELECT id,sum(amount) applied FROM (SELECT document_id id,amount FROM books_credit_applications UNION ALL SELECT credit_id id,amount FROM books_credit_applications) a GROUP BY id) c ON c.id=d.id
      WHERE (${kind}='' OR d.kind=${kind}) AND (${contact}='' OR d.contact_id::text=${contact}) AND (${search}='' OR d.number ILIKE ${'%' + search + '%'} OR d.contact_snapshot->>'name' ILIKE ${'%' + search + '%'})
      AND (${status}='' OR d.status=${status} OR (${status}='overdue' AND d.status='posted' AND d.due_date<${today()} AND d.total>COALESCE(p.paid,0)+COALESCE(c.applied,0))
      OR (${status}='unpaid' AND d.status='posted' AND d.total>COALESCE(p.paid,0)+COALESCE(c.applied,0))
      OR (${status}='paid' AND d.status='posted' AND d.total=COALESCE(p.paid,0)+COALESCE(c.applied,0)))
      ORDER BY d.date DESC,d.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
    return {
      data: rows.map(documentRow),
      total: Number(rows[0]?.row_count || 0),
      page,
      page_size: 50,
    };
  }
  async function recordPayment(input, actor) {
    return db.begin(async (tx) => {
      const key = uuid(input.request_key),
        d = await getDocumentTx(tx, input.document_id, true);
      const amount = money(input.amount, 'Payment amount', { positive: true }),
        account = input.account_code || '1010';
      const [existing] =
        await tx`SELECT * FROM books_payments WHERE request_key=${key}`;
      if (existing) {
        ensure(
          existing.document_id === d.id &&
            Number(existing.amount) === amount &&
            existing.account_code === account,
          'This request key belongs to a different payment',
          409,
        );
        return existing;
      }
      ensure(
        d.status === 'posted' && ['invoice', 'bill'].includes(d.kind),
        'Payments require a posted invoice or bill',
        409,
      );
      const when = date(input.date);
      ensure(when >= d.date, 'Payment date cannot precede the document date');
      ensure(
        amount <= Number(d.total) - (await settled(tx, d.id)),
        'Payment exceeds outstanding balance',
        409,
      );
      await cashAccount(tx, account);
      const [p] =
        await tx`INSERT INTO books_payments(document_id,date,amount,account_code,method,reference,request_key)
        VALUES(${d.id},${when},${amount},${account},${text(input.method, 50) || 'bank_transfer'},${text(input.reference)},${key}) RETURNING *`;
      const incoming = d.kind === 'invoice';
      await journal(
        tx,
        {
          date: when,
          reference: `Payment ${d.number}`,
          source: 'payment',
          source_id: p.id,
          actor,
        },
        [
          {
            account_code: account,
            debit: incoming ? amount : 0,
            credit: incoming ? 0 : amount,
          },
          {
            account_code: incoming ? '1100' : '2000',
            debit: incoming ? 0 : amount,
            credit: incoming ? amount : 0,
          },
        ],
      );
      await activity(tx, 'payment', p.id, 'recorded', actor);
      return p;
    });
  }
  async function voidPayment(id, actor) {
    return db.begin(async (tx) => {
      const [p] =
        await tx`SELECT * FROM books_payments WHERE id=${uuid(id)} FOR UPDATE`;
      ensure(p, 'Payment not found', 404);
      await getDocumentTx(tx, p.document_id, true);
      if (p.status === 'void') return p;
      const [match] =
        await tx`SELECT id FROM books_bank_transactions WHERE matched_payment_id=${id}`;
      ensure(
        !match,
        'Unmatch the bank transaction before voiding this payment',
        409,
      );
      await reverse(tx, 'payment', id, actor);
      const [r] =
        await tx`UPDATE books_payments SET status='void' WHERE id=${id} RETURNING *`;
      await activity(tx, 'payment', id, 'voided', actor);
      return r;
    });
  }
  async function reports(filter = {}) {
    const { from, to } = statements.range(filter);
    return db.begin('isolation level repeatable read', async (tx) => {
      const [reportSettings] = await tx`SELECT organization_name,currency FROM books_settings WHERE id=1`;
      const financials = await statements.statements(tx, from, to);
      // Aging is explicitly current, while trial balance and P&L obey the requested dates.
      const aging =
        await tx`SELECT d.id,d.number,d.kind,d.date,d.due_date,d.contact_snapshot->>'name' AS contact_name,
        d.total-COALESCE(p.paid,0)-COALESCE(c.applied,0) AS balance,
        CASE WHEN d.due_date IS NULL OR d.due_date>=${today()} THEN 'current'
         WHEN ${today()}::date-d.due_date<=30 THEN '1–30 days' WHEN ${today()}::date-d.due_date<=60 THEN '31–60 days' ELSE '61+ days' END AS bucket
        FROM books_documents d
        LEFT JOIN(SELECT document_id,sum(amount) paid FROM books_payments WHERE status='posted' GROUP BY document_id)p ON p.document_id=d.id
        LEFT JOIN(SELECT document_id,sum(amount) applied FROM books_credit_applications GROUP BY document_id)c ON c.document_id=d.id
        WHERE d.status='posted' AND d.kind IN ('invoice','bill') AND d.total>COALESCE(p.paid,0)+COALESCE(c.applied,0) ORDER BY d.due_date NULLS LAST,d.number`;
      const taxes =
        await tx`SELECT kind, sum(subtotal) AS taxable,sum(tax) AS tax,
        sum((tax_breakup->>'cgst')::bigint) AS cgst,sum((tax_breakup->>'sgst')::bigint) AS sgst,sum((tax_breakup->>'igst')::bigint) AS igst
        FROM books_documents WHERE status='posted' AND kind IN ('invoice','credit_note','bill','expense','vendor_credit') AND date BETWEEN ${from} AND ${to} GROUP BY kind`;
      // Only the central Nexsyrus schema owns platform source connections.
      const [connected] = await tx`SELECT to_regclass('books_finance_links') AS table_name`;
      if (connected.table_name) {
        const external = await tx`
          SELECT b.id,b.document_number AS number,'invoice' AS kind,
            (b.issued_at AT TIME ZONE 'Asia/Kolkata')::date AS date,NULL::date AS due_date,
            b.client_legal_name AS contact_name,
            round((b.total_amount-COALESCE(p.paid,0))*100)::bigint AS balance,'current' AS bucket,'billing' AS source
          FROM billing_documents b
          JOIN books_finance_links l ON l.source_type='billing' AND l.source_id=b.id AND l.component='accrual' AND l.state='posted'
          LEFT JOIN(SELECT settles_invoice_id,sum(total_amount) paid FROM billing_documents WHERE status='issued' GROUP BY settles_invoice_id)p ON p.settles_invoice_id=b.id
          WHERE b.status='issued' AND b.document_type='tax_invoice' AND b.total_amount>COALESCE(p.paid,0)
          UNION ALL
          SELECT e.id,'Expense · ' || e.title,'bill',COALESCE(e.expense_date,(e.created_at AT TIME ZONE 'Asia/Kolkata')::date),NULL::date,
            e.title,round(e.amount*100)::bigint,'current','expense'
          FROM expenses e JOIN books_finance_links l ON l.source_type='expense' AND l.source_id=e.id AND l.component='accrual' AND l.state='posted'
          WHERE e.status='APPROVED' AND e.paid_at IS NULL AND e.school_id IS NULL
          UNION ALL
          SELECT p.id,'Payroll · ' || p.payroll_month || '/' || p.payroll_year,'bill',
            (make_date(p.payroll_year,p.payroll_month,1)+interval '1 month - 1 day')::date,NULL::date,
            'Employee payroll',round(p.net_pay*100)::bigint,'current','payroll'
          FROM payroll_runs p JOIN books_finance_links l ON l.source_type='payroll' AND l.source_id=p.id AND l.component='accrual' AND l.state='posted'
          WHERE p.status='PROCESSED' AND p.net_pay>0`;
        aging.push(...external);
        const sourceTaxes = await tx`SELECT 'Client tax invoices' AS kind,
          sum(round(b.taxable_value*100)) AS taxable,
          sum(round((b.total_amount-b.taxable_value)*100)) AS tax,
          sum(round(COALESCE(b.cgst_amount,0)*100)) AS cgst,
          sum(round(COALESCE(b.sgst_amount,0)*100)) AS sgst,
          sum(round(COALESCE(b.igst_amount,0)*100)) AS igst
          FROM billing_documents b JOIN books_finance_links l ON l.source_type='billing' AND l.source_id=b.id AND l.component='accrual' AND l.state='posted'
          WHERE b.status='issued' AND b.document_type='tax_invoice' AND (b.issued_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from} AND ${to}
          HAVING count(*)>0`;
        taxes.push(...sourceTaxes);
      }
      return {
        from,
        to,
        organization_name: reportSettings.organization_name,
        currency: reportSettings.currency,
        ...financials,
        aging,
        taxes,
        receivables: aging
          .filter((x) => x.kind === 'invoice')
          .reduce((s, x) => s + Number(x.balance), 0),
        payables: aging
          .filter((x) => x.kind === 'bill')
          .reduce((s, x) => s + Number(x.balance), 0),
        aging_as_of: today(),
      };
    });
  }
  return {
    async bootstrap(user=null) {
      const can=(key,action='view')=>user===null||canBooks(user,key,action);
      const [settings]=await db`SELECT * FROM books_settings WHERE id=1`;
      const modules=BOOKS_MODULES.filter(m=>m.key!=='data'&&can(m.key));
      const kinds=Object.keys(DOCUMENT_MODULES).filter(key=>can(key));
      const contacts=can('customers')||can('vendors')?(await db`SELECT count(*) AS n FROM books_contacts WHERE kind='both' OR (kind='customer' AND ${can('customers')}) OR (kind='vendor' AND ${can('vendors')})`)[0].n:0;
      const items=can('items')?(await db`SELECT count(*) AS n FROM books_items`)[0].n:0;
      const documents=kinds.length?(await db`SELECT count(*) AS n FROM books_documents WHERE kind IN ${db(kinds)}`)[0].n:0;
      return {settings:can('settings')?settings:{organization_name:settings.organization_name,currency:settings.currency,fiscal_year_month:settings.fiscal_year_month},stats:{contacts,items,documents},modules};
    },
    async lookups(user) {
      const can=(key,action='view')=>canBooks(user,key,action);
      const contacts=can('customers')||can('vendors')?await this.contacts(user):[];
      const items=can('items')?await this.items():[];
      let accounts=[];
      if(can('accounts'))accounts=await this.accounts();
      else if(can('banking'))accounts=(await this.accounts()).filter(a=>a.is_cash);
      else if(can('payments','record')||can('expense','manage'))accounts=await db`SELECT code,name,type,is_cash FROM books_accounts WHERE is_cash=true ORDER BY code`;
      const projects=can('projects')?await this.projects():[];
      const payments=can('payments')?await this.payments():[];
      return {contacts,items,accounts,projects,payments};
    },
    async saveSettings(input, actor) {
      const state = text(input.state_code, 2),
        gstin = text(input.gstin, 15).toUpperCase();
      ensure(
        !state || /^(0[1-9]|[12]\d|3[0-8]|97)$/.test(state),
        'Invalid state code',
      );
      ensure(
        !gstin ||
          /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin),
        'Invalid GSTIN format',
      );
      if (gstin)
        ensure(
          gstin.slice(0, 2) === state,
          'GSTIN and organization state code must match',
        );
      const month = Number(input.fiscal_year_month ?? 4);
      ensure(
        Number.isInteger(month) && month >= 1 && month <= 12,
        'Invalid fiscal year month',
      );
      const [row] =
        await db`UPDATE books_settings SET organization_name=${required(input.organization_name, 'Organization name')},address=${text(input.address, 2000)},gstin=${gstin},state_code=${state},fiscal_year_month=${month},updated_at=now() WHERE id=1 RETURNING *`;
      return row;
    },
    async contacts(user=null) {
      const customers=user===null||canBooks(user,'customers'),vendors=user===null||canBooks(user,'vendors');
      return db`SELECT * FROM books_contacts WHERE (kind='customer' AND ${customers}) OR (kind='vendor' AND ${vendors}) OR (kind='both' AND ${customers||vendors}) ORDER BY name`;
    },
    async saveContact(input, actor, id) {
      ensure(
        ['customer', 'vendor', 'both'].includes(input.kind),
        'Invalid contact type',
      );
      const terms = Number(input.payment_terms ?? 30);
      ensure(
        Number.isInteger(terms) && terms >= 0 && terms <= 365,
        'Payment terms must be 0–365 days',
      );
      const gstin = text(input.gstin, 15).toUpperCase(),
        state = text(input.state_code, 2);
      ensure(
        !state || /^(0[1-9]|[12]\d|3[0-8]|97)$/.test(state),
        'Invalid state code',
      );
      ensure(
        !gstin ||
          /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin),
        'Invalid GSTIN format',
      );
      if (gstin)
        ensure(
          gstin.slice(0, 2) === state,
          'GSTIN and contact state code must match',
        );
      const email = text(input.email, 254);
      ensure(
        !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        'Invalid email address',
      );
      return db.begin(async (tx) => {
        const rows = id
          ? await tx`UPDATE books_contacts SET kind=${input.kind},name=${required(input.name, 'Name')},email=${email},phone=${text(input.phone, 50)},gstin=${gstin},state_code=${state},address=${text(input.address, 2000)},payment_terms=${terms},active=${input.active !== false},updated_at=now() WHERE id=${uuid(id)} RETURNING *`
          : await tx`INSERT INTO books_contacts(kind,name,email,phone,gstin,state_code,address,payment_terms) VALUES(${input.kind},${required(input.name, 'Name')},${email},${text(input.phone, 50)},${gstin},${state},${text(input.address, 2000)},${terms}) RETURNING *`;
        ensure(rows[0], 'Contact not found', 404);
        await activity(
          tx,
          'contact',
          rows[0].id,
          id ? 'updated' : 'created',
          actor,
        );
        return rows[0];
      });
    },
    async items() {
      return db`SELECT * FROM books_items ORDER BY name`;
    },
    async saveItem(input, actor, id) {
      const rate = money(input.sale_rate, 'Selling price'),
        cost = money(input.purchase_rate, 'Purchase price'),
        tax = money(input.tax_rate, 'Tax rate');
      ensure(tax <= 10000, 'Tax rate cannot exceed 100%');
      return db.begin(async (tx) => {
        if (id) {
          const [existing] =
            await tx`SELECT * FROM books_items WHERE id=${uuid(id)} FOR UPDATE`;
          ensure(existing, 'Item not found', 404);
          if (
            existing.track_inventory &&
            Number(existing.purchase_rate) !== cost
          ) {
            const [movement] =
              await tx`SELECT id FROM books_stock_movements WHERE item_id=${id} LIMIT 1`;
            ensure(
              !movement,
              'Standard cost cannot change after inventory movements. Create a new item for a different standard cost.',
              409,
            );
          }
        }
        const rows = id
          ? await tx`UPDATE books_items SET name=${required(input.name, 'Name')},sku=${text(input.sku, 100) || null},unit=${text(input.unit, 20) || 'unit'},hsn_sac=${text(input.hsn_sac, 30)},sale_rate=${rate},purchase_rate=${cost},tax_rate=${tax},active=${input.active !== false} WHERE id=${uuid(id)} RETURNING *`
          : await tx`INSERT INTO books_items(name,sku,unit,hsn_sac,sale_rate,purchase_rate,tax_rate,track_inventory) VALUES(${required(input.name, 'Name')},${text(input.sku, 100) || null},${text(input.unit, 20) || 'unit'},${text(input.hsn_sac, 30)},${rate},${cost},${tax},${input.track_inventory === true}) RETURNING *`;
        ensure(rows[0], 'Item not found', 404);
        await activity(
          tx,
          'item',
          rows[0].id,
          id ? 'updated' : 'created',
          actor,
        );
        return rows[0];
      });
    },
    async adjustStock(id, input, actor) {
      const str = String(input.quantity);
      ensure(
        /^-?\d+(\.\d{1,3})?$/.test(str),
        'Quantity must have at most 3 decimal places',
      );
      const q =
        D.quantity(str.replace('-', '')) * (str.startsWith('-') ? -1 : 1);
      return db.begin(async (tx) => {
        const [item] =
          await tx`SELECT * FROM books_items WHERE id=${uuid(id)} FOR UPDATE`;
        ensure(item?.track_inventory, 'Select an inventory item');
        ensure(
          Number(item.stock_milli) + q >= 0,
          'Stock cannot become negative',
        );
        const value = rounded(
          BigInt(Math.abs(q)) * BigInt(item.purchase_rate),
          1000n,
        );
        await tx`UPDATE books_items SET stock_milli=stock_milli+${q} WHERE id=${id}`;
        const [m] =
          await tx`INSERT INTO books_stock_movements(item_id,quantity_milli,reason) VALUES(${id},${q},${required(input.reason, 'Reason')}) RETURNING *`;
        if (value)
          await journal(
            tx,
            {
              date: date(input.date),
              reference: 'Inventory adjustment',
              source: 'stock',
              source_id: m.id,
              actor,
            },
            [
              {
                account_code: '1200',
                debit: q > 0 ? value : 0,
                credit: q > 0 ? 0 : value,
              },
              {
                account_code: '3000',
                debit: q > 0 ? 0 : value,
                credit: q > 0 ? value : 0,
              },
            ],
          );
        await activity(tx, 'item', id, 'stock_adjusted', actor, {
          quantity_milli: q,
        });
        return m;
      });
    },
    preview: (input) =>
      db.begin((tx) =>
        prepare(tx, input).then((p) => ({
          lines: p.lines,
          subtotal: p.subtotal,
          tax: p.tax,
          total: p.total,
          tax_breakup: p.tax_breakup,
          discount_total: p.discount_total,
          discount_value: p.discount_value,
          discount_type: p.discount_type,
          adjustment: p.adjustment,
          subtotal_before_discount: p.subtotal_before_discount,
        })),
      ),
    createDocument: (input, actor) =>
      db.begin((tx) => createDocumentTx(tx, input, actor)),
    async editDocument(id, input, actor) {
      return db.begin(async (tx) => {
        const d = await getDocumentTx(tx, id, true);
        ensure(d.status === 'draft', 'Only drafts can be edited', 409);
        ensure(input.kind === d.kind, 'Document type cannot change');
        const p = await prepare(tx, input);
        const [r] =
          await tx`UPDATE books_documents SET contact_id=${p.contact?.id || null},contact_snapshot=${tx.json(p.contact || { name: 'Expense' })},organization_snapshot=${tx.json(p.settings)},date=${p.date},due_date=${p.due_date},reference=${text(input.reference)},notes=${text(input.notes, 4000)},lines=${tx.json(p.lines)},subtotal=${p.subtotal},tax=${p.tax},total=${p.total},tax_breakup=${tx.json(p.tax_breakup)},paid_account=${p.paid_account},subject=${text(input.subject, 500)},salesperson=${text(input.salesperson, 150)},terms=${text(input.terms, 8000)},discount_type=${p.discount_type},discount_value=${p.discount_value},discount_total=${p.discount_total},adjustment=${p.adjustment},adjustment_description=${text(input.adjustment_description, 100) || 'Adjustment'},challan_type=${input.kind === 'delivery_challan' ? input.challan_type : ''} WHERE id=${id} RETURNING *`;
        await activity(tx, 'document', id, 'updated', actor);
        return documentRow(r);
      });
    },
    listDocuments,
    async getDocument(id) {
      const d = await getDocumentTx(db, id);
      const paid = await settled(db, id);
      return {
        ...d,
        settled: paid,
        balance: Number(d.total) - paid,
        payments:
          await db`SELECT * FROM books_payments WHERE document_id=${id} ORDER BY date DESC`,
        credits:
          await db`SELECT * FROM books_credit_applications WHERE document_id=${id} OR credit_id=${id}`,
      };
    },
    post,
    voidDocument,
    async convert(id, actor) {
      return db.begin(async (tx) => {
        const d = await getDocumentTx(tx, id, true);
        ensure(
          d.status === 'posted',
          'Post the source document before converting',
          409,
        );
        const kind = {
          quote: 'invoice',
          sales_order: 'invoice',
          delivery_challan: 'invoice',
          purchase_order: 'bill',
        }[d.kind];
        ensure(kind, 'This document cannot be converted');
        const [existing] =
          await tx`SELECT * FROM books_documents WHERE source_id=${id}`;
        if (existing) return existing;
        const r = await createDocumentTx(
          tx,
          copyInput(d, today(), kind),
          actor,
          id,
        );
        await activity(tx, 'document', id, 'converted', actor, {
          target_id: r.id,
        });
        return r;
      });
    },
    recordPayment,
    voidPayment,
    async payments() {
      return db`SELECT p.*,d.number,d.kind,d.contact_snapshot->>'name' AS contact_name FROM books_payments p JOIN books_documents d ON d.id=p.document_id ORDER BY p.date DESC,p.created_at DESC LIMIT 500`;
    },
    async applyCredit(input, actor) {
      return db.begin(async (tx) => {
        const ids = [uuid(input.document_id), uuid(input.credit_id)].sort();
        ensure(ids[0] !== ids[1], 'Credit and invoice must be different');
        const locked =
          await tx`SELECT * FROM books_documents WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
        const d = locked.find((x) => x.id === input.document_id),
          c = locked.find((x) => x.id === input.credit_id);
        ensure(d && c, 'Document or credit not found', 404);
        ensure(
          d.status === 'posted' &&
            c.status === 'posted' &&
            d.contact_id === c.contact_id &&
            { invoice: 'credit_note', bill: 'vendor_credit' }[d.kind] ===
              c.kind,
          'Credit must belong to the same contact and transaction type',
        );
        const amount = money(input.amount, 'Credit amount', { positive: true });
        ensure(
          amount <= Number(d.total) - (await settled(tx, d.id)) &&
            amount <= Number(c.total) - (await settled(tx, c.id)),
          'Credit exceeds available balance',
          409,
        );
        const [r] =
          await tx`INSERT INTO books_credit_applications(document_id,credit_id,amount) VALUES(${d.id},${c.id},${amount}) RETURNING *`;
        await activity(tx, 'document', d.id, 'credit_applied', actor, {
          credit_id: c.id,
          amount,
        });
        return r;
      });
    },
    async removeCredit(id, actor) {
      return db.begin(async (tx) => {
        const [r] =
          await tx`SELECT * FROM books_credit_applications WHERE id=${uuid(id)}`;
        ensure(r, 'Credit allocation not found', 404);
        await tx`SELECT id FROM books_documents WHERE id IN ${tx([r.document_id, r.credit_id])} ORDER BY id FOR UPDATE`;
        await tx`DELETE FROM books_credit_applications WHERE id=${id}`;
        await activity(
          tx,
          'document',
          r.document_id,
          'credit_unapplied',
          actor,
        );
        return { ok: true };
      });
    },
    reports,
    ledger: (code, filter) => statements.ledger(db, code, filter),
    async getJournal(id) {
      const [j] = await db`SELECT * FROM books_journals WHERE id=${uuid(id)}`;
      ensure(j, 'Journal not found', 404);
      const lines =
        await db`SELECT l.*,a.name FROM books_journal_lines l JOIN books_accounts a ON a.code=l.account_code WHERE l.journal_id=${id} ORDER BY l.id`;
      return { ...j, date: calendar(j.date), lines };
    },
    async journals() {
      return db`SELECT j.*, (SELECT sum(debit) FROM books_journal_lines l WHERE l.journal_id=j.id) AS amount FROM books_journals j ORDER BY date DESC,created_at DESC LIMIT 500`;
    },
    async manualJournal(input, actor) {
      return db.begin(async (tx) => {
        const lines = (input.lines || []).map((l) => ({
          account_code: required(l.account_code, 'Account'),
          debit: money(l.debit || 0, 'Debit'),
          credit: money(l.credit || 0, 'Credit'),
        }));
        const id = randomUUID(),
          j = await journal(
            tx,
            {
              date: date(input.date),
              reference: required(input.reference, 'Reference'),
              cash_flow_activity: input.cash_flow_activity,
              notes: text(input.notes, 4000),
              source: 'manual',
              source_id: id,
              actor,
            },
            lines,
          );
        await activity(tx, 'journal', j.id, 'created', actor);
        return j;
      });
    },
    async setAccountReporting(code, input, actor) {
      const activity = input.cash_flow_activity || null;
      ensure(!activity || ['operating','investing','financing'].includes(activity), 'Invalid cash flow activity');
      return db.begin(async tx => {
        const [before] = await tx`SELECT * FROM books_accounts WHERE code=${code} FOR UPDATE`;
        ensure(before, 'Account not found', 404);
        const [account] = await tx`UPDATE books_accounts SET cash_flow_activity=${activity} WHERE code=${code} RETURNING *`;
        await tx`INSERT INTO books_activity(entity,entity_id,action,actor,details)
          VALUES('account',${randomUUID()},'reporting_updated',${actor || null},${tx.json({ code, before: before.cash_flow_activity, after: activity })})`;
        return account;
      });
    },
    async accounts(filter = {}) {
      if (filter.from || filter.to) {
        const { from, to } = statements.range(filter);
        return db.begin('isolation level repeatable read', tx => statements.accountBalances(tx, from, to));
      }
      return db`SELECT a.*,COALESCE(sum(l.debit-l.credit),0) AS balance FROM books_accounts a LEFT JOIN books_journal_lines l ON l.account_code=a.code GROUP BY a.code ORDER BY a.code`;
    },
    async addAccount(input) {
      const code = required(input.code, 'Code');
      ensure(/^[0-9]{4,8}$/.test(code), 'Account code must have 4–8 digits');
      ensure(
        ['asset', 'liability', 'equity', 'income', 'expense'].includes(
          input.type,
        ),
        'Invalid account type',
      );
      ensure(
        !input.is_cash || input.type === 'asset',
        'Bank accounts must be assets',
      );
      const activity = input.cash_flow_activity === undefined ? (input.type === 'equity' ? 'financing' : null) : input.cash_flow_activity || null;
      ensure(!activity || ['operating','investing','financing'].includes(activity), 'Invalid cash flow activity');
      const [r] = await db`INSERT INTO books_accounts(code,name,type,is_cash,cash_flow_activity)
        VALUES(${code},${required(input.name, 'Name')},${input.type},${input.is_cash === true},${activity}) RETURNING *`;
      return r;
    },
    async bankTransactions() {
      return db`SELECT b.*,a.name AS account_name FROM books_bank_transactions b JOIN books_accounts a ON a.code=b.account_code ORDER BY date DESC,created_at DESC LIMIT 1000`;
    },
    async importBank(input, actor) {
      ensure(
        Array.isArray(input.rows) &&
          input.rows.length > 0 &&
          input.rows.length <= 1000,
        'Import 1–1000 statement rows',
      );
      return db.begin(async (tx) => {
        await cashAccount(tx, input.account_code);
        let count = 0;
        for (const row of input.rows) {
          const amount = money(row.amount, 'Amount', { signed: true });
          ensure(amount !== 0, 'Statement amount cannot be zero');
          const inserted =
            await tx`INSERT INTO books_bank_transactions(account_code,date,description,amount,reference,external_key) VALUES(${input.account_code},${date(row.date)},${required(row.description, 'Description')},${amount},${text(row.reference)},${required(row.external_key, 'Unique transaction ID')}) ON CONFLICT(account_code,external_key) DO NOTHING RETURNING id`;
          if (!inserted.length) {
            const [existing] =
              await tx`SELECT * FROM books_bank_transactions WHERE account_code=${input.account_code} AND external_key=${required(row.external_key, 'Unique transaction ID')}`;
            ensure(
              Number(existing.amount) === amount &&
                calendar(existing.date) === row.date &&
                existing.description === text(row.description) &&
                existing.reference === text(row.reference),
              'A bank transaction ID already exists with different details',
              409,
            );
          }
          count += inserted.length;
        }
        return { imported: count, duplicates: input.rows.length - count };
      });
    },
    async matchBank(id, paymentId) {
      return db.begin(async (tx) => {
        const [b] =
          await tx`SELECT * FROM books_bank_transactions WHERE id=${uuid(id)} FOR UPDATE`;
        ensure(b, 'Statement row not found', 404);
        if (!paymentId) {
          await tx`UPDATE books_bank_transactions SET matched_payment_id=NULL WHERE id=${id}`;
          return { ok: true };
        }
        const [p] =
          await tx`SELECT p.*,d.kind FROM books_payments p JOIN books_documents d ON d.id=p.document_id WHERE p.id=${uuid(paymentId)} FOR UPDATE OF p`;
        ensure(
          p?.status === 'posted' &&
            p.account_code === b.account_code &&
            Number(b.amount) ===
              (p.kind === 'invoice' ? 1 : -1) * Number(p.amount),
          'Payment direction, account and amount must match the statement',
        );
        const [r] =
          await tx`UPDATE books_bank_transactions SET matched_payment_id=${paymentId} WHERE id=${id} RETURNING *`;
        return r;
      });
    },
    async projects() {
      return db`SELECT p.*,c.name AS contact_name,(SELECT COALESCE(sum(minutes),0) FROM books_time_entries t WHERE t.project_id=p.id) AS minutes FROM books_projects p LEFT JOIN books_contacts c ON c.id=p.contact_id ORDER BY p.created_at DESC`;
    },
    async createProject(input) {
      const contact = uuid(input.contact_id);
      const [c] =
        await db`SELECT * FROM books_contacts WHERE id=${contact} AND active=true AND kind IN ('customer','both')`;
      ensure(c, 'Select an active customer');
      const [r] =
        await db`INSERT INTO books_projects(name,contact_id,budget,hourly_rate) VALUES(${required(input.name, 'Project name')},${contact},${money(input.budget, 'Budget')},${money(input.hourly_rate, 'Hourly rate')}) RETURNING *`;
      return r;
    },
    async timeEntries() {
      return db`SELECT t.*,p.name AS project_name FROM books_time_entries t JOIN books_projects p ON p.id=t.project_id ORDER BY t.date DESC,t.created_at DESC LIMIT 1000`;
    },
    async addTime(input) {
      const minutes = Number(input.minutes);
      ensure(
        Number.isInteger(minutes) && minutes > 0 && minutes <= 1440,
        'Minutes must be 1–1440',
      );
      const [p] =
        await db`SELECT * FROM books_projects WHERE id=${uuid(input.project_id)} AND status='active'`;
      ensure(p, 'Select an active project');
      const [r] =
        await db`INSERT INTO books_time_entries(project_id,date,minutes,description,billable) VALUES(${p.id},${date(input.date)},${minutes},${required(input.description, 'Description')},${input.billable !== false}) RETURNING *`;
      return r;
    },
    async invoiceProject(id, actor) {
      return db.begin(async (tx) => {
        const [p] =
          await tx`SELECT * FROM books_projects WHERE id=${uuid(id)} FOR UPDATE`;
        ensure(p, 'Project not found', 404);
        const entries =
          await tx`SELECT * FROM books_time_entries WHERE project_id=${id} AND billable=true AND invoice_id IS NULL ORDER BY date,id FOR UPDATE`;
        ensure(entries.length > 0, 'No unbilled time entries');
        ensure(
          entries.length <= 100,
          'Invoice at most 100 time entries at a time',
        );
        const lines = entries.map((t) => ({
          description: `${calendar(t.date)}: ${t.description} (${t.minutes} min)`,
          quantity: 1,
          rate: dollars(
            rounded(BigInt(t.minutes) * BigInt(p.hourly_rate), 60n),
          ),
          tax_rate: 0,
        }));
        const d = await createDocumentTx(
          tx,
          {
            kind: 'invoice',
            date: today(),
            contact_id: p.contact_id,
            reference: p.name,
            lines,
          },
          actor,
        );
        await tx`UPDATE books_time_entries SET invoice_id=${d.id} WHERE id IN ${tx(entries.map((e) => e.id))}`;
        return d;
      });
    },
    async recurring(kinds=null) {
      if(kinds&&kinds.length===0)return [];
      return db`SELECT r.*,d.number,d.kind,d.contact_snapshot->>'name' AS contact_name FROM books_recurring r JOIN books_documents d ON d.id=r.template_id WHERE ${kinds?db`d.kind IN ${db(kinds)}`:db`true`} ORDER BY next_date`;
    },
    async createRecurring(input) {
      const d = await getDocumentTx(db, input.template_id);
      ensure(
        ['invoice', 'bill', 'expense'].includes(d.kind) &&
          d.status === 'posted',
        'Select a posted invoice, bill or expense',
      );
      const months = Number(input.interval_months);
      ensure([1, 3, 6, 12].includes(months), 'Invalid recurrence interval');
      const [r] =
        await db`INSERT INTO books_recurring(template_id,interval_months,next_date) VALUES(${d.id},${months},${date(input.next_date)}) RETURNING *`;
      return r;
    },
    async setRecurring(id, active) {
      const [r] =
        await db`UPDATE books_recurring SET active=${active === true} WHERE id=${uuid(id)} RETURNING *`;
      ensure(r, 'Recurring profile not found', 404);
      return r;
    },
    async runRecurring(actor,kinds=null) {
      return db.begin(async (tx) => {
        const profiles =
          await tx`SELECT * FROM books_recurring WHERE active=true AND next_date<=${today()} AND ${kinds?tx`template_id IN (SELECT id FROM books_documents WHERE kind IN ${tx(kinds)})`:tx`true`} ORDER BY next_date FOR UPDATE`;
        const created = [];
        for (const p of profiles) {
          let next = calendar(p.next_date);
          const template = await getDocumentTx(tx, p.template_id);
          if (template.status !== 'posted') continue;
          while (next <= today() && created.length < 100) {
            const d = await createDocumentTx(
              tx,
              copyInput(template, next),
              actor,
            );
            created.push(d);
            next = nextMonth(next, p.interval_months);
          }
          await tx`UPDATE books_recurring SET next_date=${next} WHERE id=${p.id}`;
        }
        return { data: created, count: created.length };
      });
    },
    async attachments(documentId,user=null) {
      if (documentId) uuid(documentId);
      const kinds=Object.keys(DOCUMENT_MODULES).filter(k=>user===null||canBooks(user,k));
      return db`SELECT a.id,a.document_id,a.filename,a.content_type,a.size,a.sha256,a.created_at,d.number
        FROM books_attachments a LEFT JOIN books_documents d ON d.id=a.document_id
        WHERE (${documentId || ''}='' OR a.document_id::text=${documentId || ''}) AND (a.document_id IS NULL OR ${kinds.length?db`d.kind IN ${db(kinds)}`:db`false`}) ORDER BY a.created_at DESC LIMIT 500`;
    },
    async addAttachment(file, documentId, actor) {
      ensure(
        file &&
          file.buffer &&
          file.buffer.length > 0 &&
          file.buffer.length <= 5242880,
        'Select a file up to 5 MiB',
      );
      if (documentId) uuid(documentId);
      const filename = required(file.originalname, 'File name').replace(
        /[\\/\r\n]/g,
        '_',
      );
      const digest = require('node:crypto')
        .createHash('sha256')
        .update(file.buffer)
        .digest('hex');
      return db.begin(async (tx) => {
        if (documentId) await getDocumentTx(tx, documentId);
        const [r] =
          await tx`INSERT INTO books_attachments(document_id,filename,content_type,size,content,sha256,created_by)
          VALUES(${documentId || null},${filename},${text(file.mimetype, 100) || 'application/octet-stream'},${file.buffer.length},${file.buffer},${digest},${actor || null}) RETURNING id,document_id,filename,size,sha256`;
        await activity(tx, 'attachment', r.id, 'uploaded', actor);
        return r;
      });
    },
    async attachment(id) {
      const [r] =
        await db`SELECT * FROM books_attachments WHERE id=${uuid(id)}`;
      ensure(r, 'Attachment not found', 404);
      return r;
    },
    async activity() {
      return db`SELECT * FROM books_activity ORDER BY id DESC LIMIT 200`;
    },
  };
}
module.exports = { createBooksService };

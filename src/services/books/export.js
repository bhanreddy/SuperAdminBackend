const { ensure, KINDS } = require('./domain');
const { range, ledger } = require('./statements');
const { canBooks } = require('../../config/booksPermissions');
const { statementFilters, statementSource, statementRows } = require('./banking');

const MAX_ROWS = 50000;
const MAX_BYTES = 32 * 1024 * 1024;
const SEARCH_FIELDS = ['name', 'number', 'reference', 'description', 'contact_name', 'project_name', 'code', 'sku', 'action', 'entity'];
// Column order and units are explicit. Database internals and nested JSON never
// become accidental spreadsheet columns when the schema changes.
const schemas = {
  document: 'id number kind date:date due_date:date status contact_name reference subject salesperson subtotal:money discount_total:money tax:money adjustment:money total:money settled:money balance:money notes terms',
  customers: 'id kind name email phone address gstin state_code payment_terms active',
  vendors: 'id kind name email phone address gstin state_code payment_terms active',
  items: 'id name sku unit hsn_sac sale_rate:money purchase_rate:money tax_rate:percent track_inventory stock_milli:quantity active',
  payments: 'id document_id number kind contact_name date:date amount:money account_code method reference status',
  banking: 'id date:date description amount:money account_code account_name reference external_key matched_payment_id matched_journal_line_id status',
  accounts: 'code name type is_cash cash_flow_activity opening_balance:money period_debit:money period_credit:money balance:money',
  journals: 'id date:date reference source source_id notes reversal_of amount:money',
  projects: 'id name contact_name status budget:money hourly_rate:money minutes',
  time: 'id date:date project_name minutes description billable invoice_id',
  recurring: 'id number kind contact_name interval_months next_date:date active template_id',
  activity: 'id created_at:timestamp entity entity_id action actor',
};

function scaled(value, places) {
  const source = String(value ?? 0);
  ensure(/^-?\d+$/.test(source), 'Export amount must be an integer');
  ensure(typeof value !== 'number' || Number.isSafeInteger(value), 'Export amount exceeds exact numeric range');
  const n = BigInt(source), digits = (n < 0n ? -n : n).toString().padStart(places + 1, '0');
  return `${n < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
function quote(value) {
  let s = String(value ?? '');
  // Whitespace and control characters must not hide a formula prefix.
  // eslint-disable-next-line no-control-regex
  if ((/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
}
function encodeCsv(rows, columns) {
  let bytes = 5; // UTF-8 BOM plus the final CRLF.
  const lines = [columns.map(quote).join(',')];
  bytes += Buffer.byteLength(lines[0]);
  for (const row of rows) {
    const line = columns.map(key => quote(row[key])).join(',');
    bytes += Buffer.byteLength(line) + 2;
    ensure(bytes <= MAX_BYTES, 'Export exceeds 32 MiB. Narrow the search or date range.', 413);
    lines.push(line);
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
function validateExport(query) {
  ensure(query && typeof query === 'object', 'Choose an export module');
  for (const key of Object.keys(query)) {
    ensure(['module', 'search', 'status', 'transaction_type', 'from', 'to', 'account_code'].includes(key), `Unknown export filter: ${key}`);
    ensure(typeof query[key] === 'string', `Invalid ${key} filter`);
  }
  const module = query.module;
  ensure(module === 'ledger' || KINDS.includes(module) || (module !== 'document' && Object.hasOwn(schemas, module)), 'Choose a supported export module');
  ensure((query.search || '').length <= 100, 'Search must be at most 100 characters');
  const status = query.status || '', type = query.transaction_type || 'all';
  if (module === 'banking') {
    ensure(type === 'all', 'Invalid transaction type');
    return { module, ...statementFilters(query) };
  }
  ensure(!status || (KINDS.includes(module) && ['draft', 'posted', 'void', 'overdue', 'unpaid', 'paid'].includes(status)), 'Invalid export status');
  ensure(type === 'all' || (['payments', 'recurring'].includes(module) && ['invoice', 'bill', 'expense'].includes(type)), 'Invalid transaction type');
  ensure(['accounts', 'ledger'].includes(module) || (!query.from && !query.to), 'Date range is only supported for account exports');
  if (['accounts', 'ledger'].includes(module)) range(query);
  ensure(module === 'ledger' ? Boolean(query.account_code && query.account_code.length <= 50 && !query.search) : !query.account_code, 'Choose a valid ledger account');
  return { ...query, module, search: query.search || '', status, transaction_type: type };
}

async function exportBooks(db, service, query, user) {
  const module = query.module, isDocument = KINDS.includes(module);
  if (module === 'ledger') {
    const r = await ledger(db, query.account_code, { ...query, page_size: MAX_ROWS + 1 }, { maxPageSize: MAX_ROWS + 1 });
    ensure(r.total <= MAX_ROWS, 'Export exceeds 50,000 records. Narrow the date range.', 413);
    const context = { organization: r.organization_name, currency: r.currency, account: r.account.code, name: r.account.name, from: r.from, to: r.to };
    const columns = [...Object.keys(context), 'date', 'reference', 'source', 'journal_id', 'notes', 'debit_inr', 'credit_inr', 'balance_inr'];
    const rows = [
      { ...context, reference: 'Opening balance', balance_inr: scaled(r.opening_balance, 2) },
      ...r.data.map(l => ({ ...context, date: l.date, reference: l.reference, source: l.source, journal_id: l.journal_id, notes: l.notes, debit_inr: scaled(l.debit, 2), credit_inr: scaled(l.credit, 2), balance_inr: scaled(l.running_balance, 2) })),
      { ...context, reference: 'Closing balance', debit_inr: scaled(r.period_debit, 2), credit_inr: scaled(r.period_credit, 2), balance_inr: scaled(r.closing_balance, 2) },
    ];
    return { csv: encodeCsv(rows, columns), count: r.total };
  }
  let rows;
  if (isDocument) {
    const result = await service.listDocuments({ kind: module, search: query.search, status: query.status }, { limit: MAX_ROWS + 1, summaryOnly: true });
    ensure(result.total <= MAX_ROWS, 'Export exceeds 50,000 records. Narrow the search.', 413);
    rows = result.data;
  } else if (module === 'accounts') {
    rows = await service.accounts(query);
    rows = rows.filter(r => !query.search || SEARCH_FIELDS.map(k => r[k] || '').join(' ').toLowerCase().includes(query.search.toLowerCase()));
  } else if (module === 'banking') {
    rows = await statementRows(db, statementSource(db, query), MAX_ROWS + 1);
  } else {
    const sources = {
      customers: () => db`SELECT id,kind,name,email,phone,address,gstin,state_code,payment_terms,active FROM books_contacts WHERE kind IN ('customer','both')`,
      vendors: () => db`SELECT id,kind,name,email,phone,address,gstin,state_code,payment_terms,active FROM books_contacts WHERE kind IN ('vendor','both')`,
      items: () => db`SELECT id,name,sku,unit,hsn_sac,sale_rate,purchase_rate,tax_rate,track_inventory,stock_milli,active FROM books_items`,
      payments: () => db`SELECT p.id,p.document_id,p.date,p.amount,p.account_code,p.method,p.reference,p.status,d.number,d.kind,d.contact_snapshot->>'name' AS contact_name FROM books_payments p JOIN books_documents d ON d.id=p.document_id`,
      journals: () => db`SELECT j.id,j.date,j.reference,j.source,j.source_id,j.notes,j.reversal_of,(SELECT sum(debit) FROM books_journal_lines l WHERE l.journal_id=j.id) AS amount FROM books_journals j`,
      projects: () => db`SELECT p.id,p.name,p.status,p.budget,p.hourly_rate,c.name AS contact_name,(SELECT COALESCE(sum(minutes),0) FROM books_time_entries t WHERE t.project_id=p.id) AS minutes FROM books_projects p LEFT JOIN books_contacts c ON c.id=p.contact_id`,
      time: () => db`SELECT t.id,t.date,t.minutes,t.description,t.billable,t.invoice_id,p.name AS project_name FROM books_time_entries t JOIN books_projects p ON p.id=t.project_id`,
      recurring: () => {
        const kinds = ['invoice', 'bill', 'expense'].filter(k => canBooks(user, k));
        return db`SELECT r.id,r.interval_months,r.next_date,r.active,r.template_id,d.number,d.kind,d.contact_snapshot->>'name' AS contact_name FROM books_recurring r JOIN books_documents d ON d.id=r.template_id WHERE ${kinds.length ? db`d.kind IN ${db(kinds)}` : db`false`}`;
      },
      activity: () => db`SELECT id,created_at,entity,entity_id,action,actor FROM books_activity`,
    };
    const source = sources[module]();
    const searchable = SEARCH_FIELDS.map(key => db`COALESCE(to_jsonb(r)->>${key},'')`);
    // Literal substring matching mirrors the screen; '%' and '_' are not wildcards.
    const searchText = db`concat_ws(' ',${searchable.reduce((a, b) => db`${a},${b}`)})`;
    rows = await db`SELECT r.* FROM (${source}) r WHERE
      (${query.search}='' OR strpos(lower(${searchText}),lower(${query.search}))>0)
      AND (${query.transaction_type}='all' OR to_jsonb(r)->>'kind'=${query.transaction_type})
      ORDER BY r.id LIMIT ${MAX_ROWS + 1}`;
  }
  ensure(rows.length <= MAX_ROWS, 'Export exceeds 50,000 records. Narrow the search.', 413);
  const [settings] = await db`SELECT organization_name,currency FROM books_settings WHERE id=1`;
  const context = { organization: settings.organization_name, currency: settings.currency };
  if (module === 'accounts') Object.assign(context, range(query));
  const fields = schemas[isDocument ? 'document' : module].split(' ').map(s => s.split(':'));
  const columns = [...Object.keys(context), ...fields.map(([key, type]) => type === 'money' ? `${key}_inr` : type === 'quantity' ? 'stock_quantity' : type === 'percent' ? 'tax_percent' : key)];
  const data = rows.map(row => Object.fromEntries([
    ...Object.entries(context),
    ...fields.map(([key, type], index) => {
      let value = row[key];
      if (['money', 'quantity', 'percent'].includes(type)) value = scaled(value, type === 'quantity' ? 3 : 2);
      else if (value && ['date', 'timestamp'].includes(type)) value = (value instanceof Date ? value.toISOString() : String(value)).slice(0, type === 'date' ? 10 : undefined);
      return [columns[Object.keys(context).length + index], value ?? ''];
    }),
  ]));
  // Empty results still yield a valid file with the same headers.
  return { csv: encodeCsv(data, columns), count: rows.length };
}
module.exports = { exportBooks, validateExport, scaled, encodeCsv, MAX_ROWS };

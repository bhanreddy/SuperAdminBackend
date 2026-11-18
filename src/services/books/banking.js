const { date, ensure, uuid } = require('./domain');

const STATEMENT_PAGE_SIZE = 50;
const CANDIDATE_PAGE_SIZE = 25;
const matched = row => row.matched_payment_id !== null || row.matched_journal_line_id !== null;

function pageNumber(value) {
  ensure(typeof value === 'string' || typeof value === 'number', 'Invalid page');
  const page = Number(value);
  ensure(/^\d+$/.test(String(value)) && Number.isSafeInteger(page) && page >= 1 && page <= 1000000, 'Invalid page');
  return page;
}

function statementFilters(query) {
  const { search = '', status = '', account_code = '', from = '', to = '' } = query;
  ensure(typeof search === 'string' && search.length <= 100, 'Search must be at most 100 characters');
  ensure(['', 'matched', 'unmatched'].includes(status), 'Invalid statement status');
  ensure(typeof account_code === 'string' && (!account_code || /^\d{4,8}$/.test(account_code)), 'Select a valid statement account');
  ensure(typeof from === 'string' && typeof to === 'string', 'Invalid statement dates');
  if (from !== '') date(from, 'From date');
  if (to !== '') date(to, 'To date');
  ensure(!from || !to || from <= to, 'From date must be on or before the to date');
  return { search, status, account_code, from, to };
}

function statementSource(db, query) {
  const { search, status, account_code, from, to } = statementFilters(query);
  const isMatched = db`(b.matched_journal_line_id IS NOT NULL OR b.matched_payment_id IS NOT NULL)`;
  const conditions = db`WHERE
    (${account_code} = '' OR b.account_code = ${account_code})
    AND (${from || null}::date IS NULL OR b.date >= ${from || null}::date)
    AND (${to || null}::date IS NULL OR b.date <= ${to || null}::date)
    AND (${status} = '' OR ${isMatched} = (${status} = 'matched'))
    AND (${search} = '' OR strpos(lower(concat_ws(' ', b.reference, b.description, b.external_key, a.name)), lower(${search})) > 0)`;
  return { conditions, isMatched };
}

function statementRows(db, source, limit, offset = 0) {
  return db`SELECT b.id, b.account_code, b.date::text, b.description, b.amount, b.reference,
    b.external_key, b.matched_payment_id, b.matched_journal_line_id::text, b.created_at,
    b.match_revision::text, a.name AS account_name, CASE WHEN ${source.isMatched} THEN 'matched' ELSE 'unmatched' END AS status
    FROM books_bank_transactions b JOIN books_accounts a ON a.code = b.account_code ${source.conditions}
    ORDER BY b.date DESC, b.created_at DESC, b.id DESC LIMIT ${limit} OFFSET ${offset}`;
}

async function listStatements(db, query) {
  ensure(Object.keys(query).every(key => ['page', 'search', 'status', 'account_code', 'from', 'to'].includes(key)),
    'Invalid statement filter');
  if (query.page === undefined) return statementRows(db, statementSource(db, query), 1000);
  const page = pageNumber(query.page);
  return db.begin('isolation level repeatable read', async tx => {
    const source = statementSource(tx, query);
    const [summary] = await tx`SELECT count(*) AS total FROM books_bank_transactions b
      JOIN books_accounts a ON a.code = b.account_code ${source.conditions}`;
    const data = await statementRows(tx, source, STATEMENT_PAGE_SIZE, (page - 1) * STATEMENT_PAGE_SIZE);
    return { data, page, page_size: STATEMENT_PAGE_SIZE, total: Number(summary.total) };
  });
}

function bigintId(value, label = 'Ledger entry') {
  ensure(typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n, `Invalid ${label.toLowerCase()}`);
  return value;
}

function matchInput(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Choose a match or unmatch action');
  const keys = Object.keys(input);
  ensure(keys.every(key => ['payment_id', 'journal_line_id', 'match_revision'].includes(key)) &&
    (Object.hasOwn(input, 'payment_id') !== Object.hasOwn(input, 'journal_line_id')), 'Choose one match identifier');
  ensure(!Object.hasOwn(input, 'payment_id') || input.payment_id === null || typeof input.payment_id === 'string',
    'Invalid payment identifier');
  const paymentId = input.payment_id === null || input.payment_id === undefined ? null : uuid(input.payment_id);
  const lineId = input.journal_line_id === undefined ? null : bigintId(input.journal_line_id);
  const revision = input.match_revision === undefined ? null : bigintId(input.match_revision, 'Match revision');
  return { paymentId, lineId, revision };
}

async function matchCandidates(db, id, query, access) {
  const page = pageNumber(query.page ?? 1);
  ensure(Object.keys(query).every(key => key === 'page'), 'Invalid match filter');
  const [bank] = await db`SELECT account_code, date::text, amount, matched_payment_id, matched_journal_line_id
    FROM books_bank_transactions WHERE id = ${uuid(id)}`;
  ensure(bank, 'Statement row not found', 404);
  ensure(!matched(bank), 'This statement row is already matched. Refresh the statement.', 409);
  const rows = await db`SELECT l.id::text AS id, j.date::text, j.reference, j.source,
      COALESCE(p.reference, '') AS payment_reference
    FROM books_journal_lines l JOIN books_journals j ON j.id = l.journal_id
    LEFT JOIN books_payments p ON j.source = 'payment' AND p.id = j.source_id
    WHERE l.account_code = ${bank.account_code} AND l.debit - l.credit = ${bank.amount}::bigint
      AND ((j.source = 'payment' AND ${access.payments} AND p.status = 'posted')
        OR (j.source <> 'payment' AND ${access.journals}))
      AND NOT EXISTS (SELECT 1 FROM books_bank_transactions b
        WHERE b.matched_journal_line_id = l.id OR b.matched_payment_id = p.id)
    ORDER BY abs(j.date - ${bank.date}::date), j.date DESC, l.id DESC
    LIMIT ${CANDIDATE_PAGE_SIZE + 1} OFFSET ${(page - 1) * CANDIDATE_PAGE_SIZE}`;
  return { data: rows.slice(0, CANDIDATE_PAGE_SIZE), page, has_more: rows.length > CANDIDATE_PAGE_SIZE };
}

async function changeMatch(db, id, input, access, actor) {
  const { paymentId, lineId, revision } = matchInput(input);
  if (paymentId) ensure(access.payments, 'Access to payments has not been granted', 403);
  return db.begin(async tx => {
    const [bank] = await tx`SELECT * FROM books_bank_transactions WHERE id = ${uuid(id)} FOR UPDATE`;
    ensure(bank, 'Statement row not found', 404);
    let line = null;
    let payment = null;
    if (lineId || paymentId) {
      [line] = await tx`SELECT l.id::text, j.source, j.source_id, l.account_code, (l.debit - l.credit)::text AS amount
        FROM books_journal_lines l JOIN books_journals j ON j.id = l.journal_id
        WHERE ${lineId ? tx`l.id = ${lineId}::bigint` : tx`j.source = 'payment' AND j.source_id = ${paymentId}
          AND l.account_code = ${bank.account_code} AND l.debit - l.credit = ${bank.amount}::bigint`}`;
      ensure(line, 'No matching ledger entry for this account, direction and amount');
      const isPayment = line.source === 'payment';
      ensure(isPayment ? access.payments : access.journals, 'Access to the matching entry has not been granted', 403);
      ensure(line.account_code === bank.account_code && line.amount === String(bank.amount),
        'Ledger entry direction, account and amount must match the statement');
      if (isPayment) {
        // Use the same payment lock as voidPayment so a void and match cannot both win.
        [payment] = await tx`SELECT id, status FROM books_payments WHERE id = ${line.source_id} FOR UPDATE`;
        ensure(payment?.status === 'posted', 'The payment is no longer posted', 409);
      }
    }
    const same = String(bank.matched_journal_line_id ?? '') === (line?.id || '') &&
      bank.matched_payment_id === (payment?.id || null);
    if (same) return line ? bank : { ok: true };
    ensure(revision === null || revision === String(bank.match_revision), 'This match changed. Refresh the statement before retrying.', 409);
    ensure(!line || !matched(bank), 'Unmatch the current entry before choosing another', 409);
    let updated;
    try {
      [updated] = await tx`UPDATE books_bank_transactions SET matched_journal_line_id = ${line?.id || null},
        matched_payment_id = ${payment?.id || null}, match_revision = match_revision + 1 WHERE id = ${id} RETURNING *`;
    } catch (error) {
      if (error.code === '23505') ensure(false, 'This ledger entry is already matched to another statement row', 409);
      throw error;
    }
    await tx`INSERT INTO books_activity(entity, entity_id, action, actor, details)
      VALUES ('bank_transaction', ${id}, ${line ? 'matched' : 'unmatched'}, ${actor || null}, ${tx.json({
        journal_line_id: line?.id || bank.matched_journal_line_id || null,
        payment_id: payment?.id || bank.matched_payment_id || null,
      })})`;
    return line ? updated : { ok: true };
  });
}

module.exports = { statementFilters, statementSource, statementRows, listStatements, matchCandidates, changeMatch };

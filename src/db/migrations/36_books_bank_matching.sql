BEGIN;

ALTER TABLE books_bank_transactions
  ADD COLUMN IF NOT EXISTS matched_journal_line_id bigint REFERENCES books_journal_lines(id),
  ADD COLUMN IF NOT EXISTS match_revision bigint NOT NULL DEFAULT 0;

-- Preserve native payment links and give each of them the same ledger identity
-- used by new matches. The original payment column remains for existing callers.
UPDATE books_bank_transactions b
SET matched_journal_line_id = l.id
FROM books_journals j
JOIN books_journal_lines l ON l.journal_id = j.id
WHERE j.source = 'payment' AND j.source_id = b.matched_payment_id
  AND l.account_code = b.account_code AND l.debit - l.credit = b.amount
  AND b.matched_journal_line_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS books_bank_matched_line_unique
  ON books_bank_transactions(matched_journal_line_id) WHERE matched_journal_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_bank_statement_order
  ON books_bank_transactions(date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS books_bank_account_statement_order
  ON books_bank_transactions(account_code, date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS books_ledger_account_signed_amount
  ON books_journal_lines(account_code, (debit - credit), journal_id);

COMMIT;

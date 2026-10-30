# Books financial statements

Books → Reports contains Profit & loss, Balance sheet, Ledger accounts, and Cash flow. Chart of accounts also opens the same ledger. The reporting dates apply to both locations. The statements use posted, immutable double-entry journals in the selected company schema, including dated reversing entries. Drafts and future journals are excluded. Receivables/payables aging retains its separately labelled current-date behavior.

## Release

Deploy the backend and frontend together after running `npm run migrate:books` in `SuperAdminBackend` against the central admin database. Migration `32_books_statements.sql` is required. The installer applies it to public and every active company schema, and new companies get it through `initializeCompanyBooks`. The migration is repeatable, preserves posted facts and existing classifications, and adds a reporting-date index. Do not run only the public-schema migration for a multi-company installation.

No production credentials or production database changes are needed for the tests. Run:

```
npm --prefix SuperAdminBackend run test:books
npm --prefix SuperAdminFrontend test
npm --prefix SuperAdminFrontend run typecheck
npm --prefix SuperAdminFrontend run build:web
```

## Statement behavior

- Profit & loss uses income credits minus debits and expense debits minus credits within the inclusive reporting period, with account detail, subtotals, and signed net profit/loss.
- Balance sheet uses all entries through the end date. Equity includes posted owner equity, earnings before the period, and period earnings. Changing only the start date cannot change total assets, liabilities, or accumulated earnings. Assets minus liabilities and total equity is exposed as a reconciliation difference.
- Ledgers include balances before the start date, period debits and credits, closing balances, and a deterministic running balance ordered by accounting date then immutable journal-line ID. Balances use debit minus credit; credit balances are negative. Pagination defaults to 100 lines and accepts 1–500 per page. There is no silent 2,000-row truncation. Out-of-range pages retain totals.
- Cash flow uses a direct-method view of external cash movement per journal, grouped as operating, investing, financing, or unclassified. Transfers exclusively between cash/bank accounts are excluded. Non-cash journals do not contribute cash flows. Opening cash plus net change must equal closing cash, which agrees with the balance sheet cash accounts.

The cash-flow structure follows the operating/investing/financing and cash reconciliation concepts in [IAS 7](https://www.ifrs.org/issued-standards/list-of-standards/ias-7-statement-of-cash-flows/). This is an INR ledger report; it does not certify a statutory filing or add foreign-currency translation.

## Cash classification policy

The migration classifies seeded operating accounts and payroll/reimbursement payables as operating, and equity as financing. Other existing asset/liability accounts remain unclassified for review. New accounts accept an explicit classification. Account managers can change a non-cash account's activity from its ledger. These changes apply to all periods and record an audit event containing account code, old/new values, and actor.

Manual journals can override classification at posting. Otherwise, classification is inferred only if every non-cash counterpart has the same known activity. Reversals inherit the original journal override. Mixed activities and unknown counterparts remain unclassified; the report exposes their count and marks classification incomplete even when offsetting unclassified amounts net to zero.

Record separate journals for separate external receipts and payments, especially across activity categories. A journal's net cash movement cannot establish an arbitrary gross allocation between cash and non-cash legs. Offset external cash legs with non-cash counterparts are flagged for review even when net cash is zero. Correct combined posted journals by reversing and posting separate entries; immutable ledger facts are never edited.

## API and consistency

`GET /reports` retains the existing dashboard-compatible totals and adds `profit_loss`, `balance_sheet`, `cash_flow`, and opening/period/closing fields in `trial`.

`GET /accounts?from=YYYY-MM-DD&to=YYYY-MM-DD` returns period account balances. Unfiltered lookups retain their existing shape.

`GET /accounts/:code/ledger` now returns an object rather than the former truncated array: `account`, `from`, `to`, `opening_balance`, `period_debit`, `period_credit`, `closing_balance`, `total`, `page`, `page_size`, and `data` with `running_balance` for each line. The bundled frontend consumes this contract. Update any other callers with the release.

`PUT /accounts/:code/reporting` accepts `{ "cash_flow_activity": "operating" }` (also `investing`, `financing`, or null), requires account view/manage grants, and writes an audit event.

Report and ledger queries run in repeatable-read transactions, with the transaction-local company search path installed before reading financial records. Monetary arithmetic uses exact integer paise and rejects response amounts outside JavaScript's safe integer range rather than silently rounding. Company membership, report viewing, account viewing, account management, and export UI grants remain distinct.

Exports contain the selected statement, date range, INR amounts, subtotals, and reconciliation. Full-ledger export fetches every page and aborts if totals change between pages. CSV quoting and spreadsheet formula escaping reuse the existing Books CSV implementation.

## Validation at implementation

The Books backend suite passes 51 tests, including real PostgreSQL-compatible database integration, repeatable migrations, company isolation, permissions, reversals, exact paise, period boundaries, and ledgers beyond 2,000 lines. The full frontend suite passes 61 tests; TypeScript and the Expo web build also pass. Monetary display and CSV decimal conversion preserve every paisa even at JavaScript's safe-integer limit. Negative decimal CSV values remain numeric while formula expressions are escaped.

The broader CRM backend suite has 12 failures outside this feature. All 12 also reproduce on a clean checkout of the unchanged backend HEAD; the baseline additionally exposed a flaky concurrent-stage test. These are separate from the passing Books checks.

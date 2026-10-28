# SuperAdmin Books

Open **Books & Accounting** from the founder sidebar or the founder dashboard.
The shared web route is `/books`; `/console/books` redirects there. Founder and
Super Admin accounts have full access. CA accounts use `/ca-login` and receive
only explicitly assigned Books permissions, enforced by the API on every request.

Books owns INR accounting records in the **central admin database**. Nexsyrus
Books now connects central operating expenses, business collections, client billing
and payroll to the same ledger as Books invoices, bills and payments. Database
triggers post changes atomically with their source records, including writes from
scheduled payroll and existing APIs. Nexmaxx remains isolated. This does not
synchronize with Zoho or tenant payment gateways.

Historical records are imported explicitly from **Books → Finance connections →
Review existing records**, in batches of up to 200. Check opening balances and
manual entries before importing records they already cover. Installation alone
does not silently backfill accounting transactions.

## Enable the module

Deploy the backend and frontend changes together. Before using Books, run from
`SuperAdminBackend` with the intended central database environment:

```sh
npm run migrate:books
```

The additive migrations are `src/db/migrations/26_books.sql` and
`src/db/migrations/27_books_workflows.sql`, plus
`src/db/migrations/28_books_ca_access.sql`, `29_books_companies.sql`, and
`30_books_finance_connections.sql`. The command applies all five, including
upgrades to existing Books installations. They are repeatable and
transactional. The installer reserves one database connection for the complete
migration. It enables RLS without public client policies on the Books tables;
browser clients access data through the authenticated backend only. Use the same
privileged server-side database connection as the existing central admin routes.
The migration is not run automatically during server startup.

Tests use disposable local PostgreSQL-compatible databases. On 26 October 2026,
the Books schema and CA access migration were applied to the configured central
admin database. The backend was deployed to the existing NexsyrusSuperAdmin
Catalyst Development service, and the frontend to the `superadminfrontend` Worker
serving `https://founderconsole.nexsyrus.com`. Live checks verified CA login,
profile, the required password-change restriction, logout, the `/ca-login` page,
and the deployed JS asset against the local build. No accounting transactions or
sample records were seeded there.

## First-use workflow

1. In Settings, enter the organization name, address, state code, GSTIN where
   applicable, and financial-year start month.
2. Add customers and vendors, including state codes and payment terms.
3. Add products/services, prices, optional tax rates, and HSN/SAC. Products with
   inventory tracking start at zero stock. Record purchases or opening stock
   adjustments before selling inventory.
4. Create quotes, sales orders, delivery challans, purchase orders, invoices,
   bills, expenses, or credit notes. Review server-calculated totals; save and edit drafts freely.
5. Post a document to finalize it. Financial documents produce balanced journals;
   quotes/orders finalize without ledger entries and can convert to a draft
   invoice or bill. Each source document converts once.
6. Open a posted invoice/bill to record partial or full payments, or allocate a
   posted credit for the same contact. Recording a payment records a ledger fact;
   it does not initiate a bank transfer or gateway charge.
7. Import statement CSV in Banking and match existing recorded payments.
8. Review reports, print documents (browser Print / Save as PDF), and export lists
   to CSV. Attach supporting files to a document or the document library.

## Accounting behavior

- API monetary inputs are decimal INR strings with at most two decimal places.
  Persisted monetary values and all monetary response fields are integer paise.
  Quantities are thousandths of a unit; percentage rates are hundredths of a
  percent. Rounding occurs at each line, half up, using integer arithmetic.
- Line discounts reduce the taxable line amount. A separate document discount
  supports an amount or percentage and is allocated proportionally across lines
  in exact paise before tax. Signed adjustments apply after tax and post to
  separate sales/purchase adjustment accounts. Prices are tax exclusive.
  Tax rates are explicitly chosen per line; there is no hard-coded tax schedule.
  Different organization/contact state codes select IGST; matching codes split
  tax between CGST and SGST. Odd paise allocate the remainder to SGST.
- Taxed documents require organization and counterparty state codes. GSTIN input
  checks format and state-code consistency; it does not validate GST registration
  with a government service. The module does not certify legal tax eligibility.
- Posting an invoice debits receivables and credits revenue/output tax. Bills
  debit inventory or expense and input tax, and credit payables. Cash expenses
  credit the selected cash/bank account. Credits reverse the corresponding
  original accounting direction. Credit allocations settle balances; the credit
  document already posted its ledger adjustment, so allocations add no duplicate
  journal.
- Inventory issues use the item's current **standard purchase cost** when posted.
  Purchases receive stock at standard cost and post the difference from actual
  line cost to Purchase price variance. Standard cost cannot change after an
  item's first stock movement; use a new item for a different standard cost.
  FIFO, moving-average costing, landed costs, serial numbers, batches,
  warehouses, and historical cost revaluation are not implemented. Standard costs
  must be managed consistently before treating inventory valuation as final.
- Stock changes, payments, conversions, credit allocations, recurrence generation,
  and project invoicing use transactions and row locks. Payments require a stable
  client request key; exact retries return the original record.
- Posted journals cannot be changed, deleted, or appended to later. Database
  constraints verify that journal debits equal credits at transaction end. Posted
  document financial facts and snapshots cannot be edited. Voiding appends a
  reversal dated on the current India calendar date and reverses stock. Payments
  and applied credits must be removed first; a matched payment must be unmatched
  before voiding. Voiding a recurrence template pauses its profiles.
- Reports use accrual entries. Profit and loss is filtered by the requested
  period; balance sheet/trial balance include all entries through the end date.
  Accumulated earnings reconcile the balance sheet. Aging is **current**, labeled
  with its own as-of date, and covers outstanding document balances. Unapplied
  credits and manual journals to control accounts can therefore make aging differ
  from the receivables/payables general-ledger balance.
- Manual journals can record opening balances and corrections. They do not create
  contact allocations or inventory quantities. Use document and stock workflows
  to preserve those subledgers.

## Other supported workflows

- Delivery challans support the observed types Supply of Liquid Gas, Job Work,
  Supply on Approval, and Others. In this implementation, finalizing a challan
  freezes its document without posting ledger entries or moving stock. Convert
  it once to an editable invoice draft; posting that invoice updates accounting
  and inventory. This is an explicit local workflow choice, not a claim that
  Zoho's untested shipment/stock behavior is identical. Zero-value drafts are
  allowed, while posting a financial document requires a positive total.
- Documents now preserve subject, salesperson, separate notes and terms, and
  adjustments through editing, posting, conversion, recurrence, and printing.
- Payments can be recorded from the Payments screen, selecting a posted invoice
  or bill, or from its document detail. The global picker lists the first 50
  outstanding documents. Payments received/made and recurring invoices/bills/
  expenses have transaction-type filters.
- Projects support a budget, customer, and hourly rate. Time entries track minutes
  and billability. Invoicing unbilled time creates a draft once; voiding that draft
  releases its time entries. Project/time rate snapshots, staff timesheets,
  approvals, project expenses, and full project profitability are not implemented.
- Recurrence intervals are monthly, quarterly, six-monthly, or annual. **Generate
  due drafts** is explicit/manual; no scheduler or automatic posting is installed.
  A run generates up to 100 drafts, preserves remaining due dates, and subsequent
  runs catch up without recreating completed periods. Month-end dates clamp to
  valid calendar dates. Due dates are not copied to recurring drafts.
- CSV imports require `date,description,amount,external_key`; `reference` is
  optional. Dates are `YYYY-MM-DD`, deposits positive, withdrawals negative.
  Up to 1,000 rows per import; exact repeated bank transaction IDs are skipped,
  conflicting values are rejected. Imports do not affect the ledger. Matching
  requires a posted payment with the same account, direction and amount. Only one
  statement row can match a payment. Bank fees, transfers, partial matches, and
  automatic categorization are not implemented.
- Attachments are stored in the central database, up to 5 MiB each. Authenticated
  downloads force attachment disposition and disable content sniffing. Retention,
  malware scanning, OCR, storage quotas, and document deletion are not implemented.
- Financial document lists support search, status filters and 50-row pagination.
  CSV exports contain the displayed document page; report CSV exports the trial
  balance. Payments/journals show the latest 500, statement/time rows the latest
  1,000, activity the latest 200, ledger entries the first 2,000 in the selected
  period, and attachments the latest 500. The UI labels these limits.

## Verification

```sh
# Backend: real SQL transactions, Express endpoints, binary upload/download.
npm run test:books
# Frontend (run in SuperAdminFrontend)
node --test tests/books.test.cjs
npm run typecheck
npm run build:web
```

Tests cover exact decimals, drafts vs posting, repeated posting, concurrent
payments, overpayment rejection, credit balances, inventory insufficiency and
reversal, preserved snapshots, quote conversion, immutable/balanced journals,
statement deduplication/matching, recurring generation, time invoicing,
authenticated routing, escaped print HTML, byte-exact attachments, CSV handling,
and form failure/retry behavior.

## Zoho reference and remaining parity

Feature organization was informed by Zoho's public product and help documentation:

- https://www.zoho.com/in/books/support/
- https://www.zoho.com/us/books/help/accountant/manual-journal.html

REA 6.8.0 is connected. The MCP adapter health check passed, including discovery
of 229 tools and 6 prompts. Browser access became available during the follow-up
session. The signed-in organization was inspected read-only: Getting Started,
sales/purchase navigation, the empty invoice list, invoice creation and its
preferences dialog, and the delivery-challan form/types. No Zoho records or
preferences were saved, sent, posted, or changed. The original Getting Started
page was restored afterward.

The in-app browser does not expose a literal loopback CDP endpoint for direct REA
browser inspection. Four public script URLs observed in the browser's page-asset
inventory were downloaded without cookies into the local evidence directory.
REA statically analyzed one selected webpack chunk after a broader attempt hit a
per-source timeout. The completed parent Evidence is
`ev_ac27c14bac4df1fc5c6f3175d48300059468d74bf2e84563d3c1dfae90941e58`.
Its graph is partial: three inventoried files were outside the final analysis
scope, semantic retention limits were reached, and no route candidates were
recovered from that selected chunk. Do not infer missing routes or full feature
coverage from this result. Source scripts were never executed or copied into the
application. The native feature changes are independently implemented from the
observed UI, backed by local accounting tests.

The source manifest and exported REA Evidence bundle are under
`/Users/bhanureddy/.codex/rea-evidence/zoho-books-2026-10-26/`.

This is a native core accounting implementation, not complete Zoho Books parity.
Remaining areas include statutory GST/TDS/e-invoice/e-way-bill integrations,
live bank feeds and reconciliation periods, payment gateways, email/reminders,
customer/vendor portals, retainer invoices, sales receipts, refund processing,
multi-currency/FX, multi-organization/branches, approvals and delegated finance
roles, price lists, workflow automation/webhooks, advanced inventory and costing,
custom fields/templates, comprehensive import/migration, tax-return exports,
full project lifecycle, fixed assets, and comprehensive API pagination.
Do not present stub controls for these functions as implemented services.

### Verification results for this implementation

- Books backend: 18 tests passed, including repeatable migrations and standard-cost
  purchase variances.
- Frontend: all 23 tests passed, including 8 Books workflow/UI tests.
- TypeScript and the Expo web production export passed.
- The existing CRM backend suite had 12 failures (40 passed). All 12 failing test
  names also failed on a clean archive of the original HEAD; no new failing test
  names were introduced. The baseline had one additional failure. Existing issues
  include authorization fixtures, a missing audit table fixture, and references
  to a missing sibling SchoolIMS `trackingIngress.ts` file.
- A browser preview rendered the actual Books components against the actual Books
  Express API and disposable PGlite database. A sample invoice with a 10% discount
  and -0.20 INR adjustment totaled 1,061.80 INR. Recording a 100 INR sample payment
  through the browser reduced the outstanding balance to 961.80 INR and increased
  cash/bank by 100 INR. A zero-value Job Work challan was created and finalized
  in the browser, then converted into an editable invoice draft with its subject
  and terms retained. The preview uses a separate local authorization token and
  no production environment. Infrastructure, routing, file pickers and theme
  provider are fixture adapters; this does not verify the full authenticated
  Expo application or production deployment. Screenshots were captured locally.
- The live migration, deployment, email sending, money transfers, and Zoho record
  changes were not performed.

## CA access

The Founder / Super Admin opens **Books → CA access**; the lead CA opens **CA team** (`/books/access`) to create
accountants, grant module viewing and actions, suspend accounts, or reset their
passwords. Every new account defaults to no grants. The separate `/ca-login`
endpoint accepts CA accounts only; existing staff use their regular login.

CA is a dedicated role with no inherited permissions, no school scope, and no
access to other SuperAdmin APIs, even if an invalid non-Books override exists.
It uses the existing internal session infrastructure with a local salted scrypt
password hash; it never falls back to Supabase credentials. New/reset passwords
must be changed before Books access. Changing/resetting a password and suspending
an account invalidate sessions. A reset returns a temporary password once. No
email is sent automatically.

Permissions are `books.<module>.<action>`; the founder catalog lists the supported
modules and actions. Actions require the same module's `view` grant. Create/edit,
post/finalize, void/reverse, payment recording, stock adjustments, recurring
generation, file uploads, and print/export are distinct. Financial Dashboard
and Reports grants each expose financial totals; supporting files remain scoped
to the linked document types. The browser requests only server-scoped lookups
and refreshes the CA profile every 30 seconds. Revocation is enforced on the very
next API request, independent of that UI refresh.

Some workflows need additional grants: journal posting needs Accounts viewing;
project creation needs Customers viewing; time entry creation needs Projects
viewing; project invoicing needs Time viewing and Invoice create/edit; recurring
generation needs create/edit for the relevant document type; recording a payment
requires viewing its invoice/bill. Creation forms use only the directories and
items that the user can view. `books.data.export` permits official CSV/print/file
download actions on already visible data; it cannot prevent copying visible text.

CA management endpoints are `/api/super-admin/books/access/catalog`, `/access/users`,
`/access/users/:id`, and `/access/users/:id/reset-password`. These require Founder / Super Admin or lead CA authority; lead CAs can manage only ordinary CA accounts reporting to them.
Account/grant/reset events are stored in RLS-protected `books_access_events` with
no plaintext passwords. Books responses disable caching.

For one-time terminal provisioning, run:

```sh
node scripts/create-books-ca.js ca@example.com 'CA Name'
```

This creates no grants, requires a password change, refuses existing identities,
and stores the generated password in a local owner-readable file under
`~/.codex/credentials/`. It prints the file path, never the password.

CA verification includes real JWT login/session/refresh infrastructure against a
disposable database, immediate revocation, no-grant and view-only boundaries,
file authorization, suspension/reset, dedicated login rejection for founders,
and resistance to non-Books overrides and legacy tokens. Frontend tests cover
restricted menus and requests, view-only actions, grant selection, temporary
password display, and direct route restrictions.

## Lead CA and company books (27 October 2026)

`CA_LEAD` has full accounting permissions for Nexsyrus and Nexmaxx and can create,
assign permissions to, suspend, and reset passwords for ordinary CA accounts
reporting to that lead. The owner alone can appoint/demote a lead or reassign a
CA to another lead. A lead cannot change their own authority, manage a peer lead,
create platform administrators, or use platform/school APIs. The dedicated CA
login and first-password-change policy apply to both accounting roles.

`/books/organizations` lists only assigned companies and their effective grants.
`X-Books-Company-Id` selects the company for every business request. Membership
and permissions are rechecked server-side each time. The browser company switch
remounts the workspace, discards the old company's UI state, and supplies the
selected company on API requests, including attachments. CA team assignments
store a separate permission list per company; no company grant means no records.

Migration 29 adds the company registry and memberships. Existing Nexsyrus records
stay in `public`; Nexmaxx uses `books_nexmaxx`, with independent settings, contact
and item masters, document counters, journals, payments, files, reports and stock.
The API reserves one database transaction per business request and selects its
company with transaction-local `search_path`. Financial service transactions
reuse this outer transaction, preserving the journal-header/line transaction-ID
invariant. Deferred trigger functions have an explicit owning-schema search
path; the secondary company cannot fall back to public financial tables.
Migration backfill runs once per CA, so rerunning the installer cannot recreate
revoked memberships. `initializeCompanyBooks` applies the repeatable accounting
schema to each company without copying accounting transactions.

`node scripts/appoint-lead-ca.js ca.murali@nexsyrus.com` promotes the existing
account, preserves its password and first-login flag, and assigns existing
ordinary CA accounts to Murali. Role/reporting changes revoke sessions.
`books_access_events` records the appointment and company/permission changes.

Validation: 29 backend and 31 frontend tests cover company separation, posting and
deferred journal constraints in the secondary schema, document-ID isolation,
team delegation, privilege escalation attempts, per-company grants and
revocation, rerunnable migrations, restricted routes and company switching.
A read-only check with 24 concurrent requests on the configured PostgreSQL
database confirmed independent organization settings and restored pool state.


## Connected platform finance (28 October 2026)

Deploy the backend and frontend together after running `npm run migrate:books`
against the intended central database. Migration 30 requires the existing central
`expenses` and `collections` tables, billing migration 05, and payroll migration 12.
No live migration, deployment or historical import was performed for this change.

- Expense approval debits operating expenses (or wages for the Salary category)
  and credits employee reimbursements payable. Approval does not imply cash was
  paid. **Record payment** clears the payable against Bank or Cash. Existing
  approved expenses import as unpaid because no historical payment fact existed.
  The expense date is explicit; legacy rows use their India creation date.
- Approved collections debit Cash for CASH, otherwise Bank, and credit Sales.
  Rejecting a connected collection appends a reversal. A collection represents
  standalone income; use an invoice-linked receipt for an invoiced payment.
- Issued client tax invoices debit receivables and credit Sales and Output tax,
  using their stored amounts. Receipts debit Bank. **Receipt applies to** can
  select an outstanding issued client invoice for the same customer: its receipt
  credits receivables without recognizing income again. Partial receipts are
  allowed; overpayments are rejected under an invoice row lock. A historical
  invoice is connected when its first linked receipt is issued. Standalone
  non-GST receipts credit Sales. Cancel linked receipts before their invoice.
- Payroll processing debits gross wages and credits net salaries and PF, ESI,
  and other deduction liabilities. Marking paid debits net salary payable and
  credits Bank. Reprocessing skips paid runs, preserving their financial facts.
  Payroll and manual Salary expenses must not describe the same underlying cost.
- Source snapshots and row/advisory locks make unchanged retries no-ops. Corrections
  append reversals dated today in India and replacement journals dated to the
  source; journal history is immutable. Connected source rows cannot be deleted.
  Receipt attachments do not change the ledger. School expenses are excluded.
- The financial summary in the founder dashboard now uses Books revenue,
  expenses and profit, excluding GST from revenue and including payroll and native
  Books transactions. Client billing collected counts recorded receipt cash,
  including cancellation reversals. A selected business unit affects the separate
  collection breakdown; financial totals remain platform-wide. Operational
  collection/category analytics elsewhere retain their existing source scope.
- Books reports include connected client receivables, unpaid expense and net
  salary payables, and client invoice tax totals. Source invoices have no due-date
  field, so their aging bucket is current. Statutory deduction liabilities remain
  in the trial balance rather than vendor aging.
- **Finance connections** shows source counts, amounts awaiting historical import,
  and the latest 200 connection components. Journal viewers can open the balanced
  entry. Expenses show individual posting and payment states, search, category,
  date-period and Books-status filters, receipts, and separate payment recording.
  The Books Expenses list continues to list native Books expense documents;
  platform entries appear in Finance connections and the ledger/reports.
- Access uses separate `books.connections.view` and `books.connections.sync`
  grants. Historical import is not authorized by viewing. Founder and lead CA
  retain their existing full accounting authority. Other company requests cannot
  read or import Nexsyrus sources.

Connected payments currently post directly as journals. Bank statement matching
continues to support native Books payment records; matching source-payment
journals and changing paid facts from the UI are not implemented. Expense
reimbursements are full payments, without partial allocations. Receipt images
remain in the expense receipt store, opened through the expense workspace.

Verification: 42 backend Books tests and 42 frontend tests pass, including source
posting, reversal, idempotency, payroll deductions, partial receipts, overpayment
rejection, rollback, migration repeatability, historical import, company/permission
boundaries, expense filtering, approval/payment forms and receipt-upload retry.
TypeScript and the Expo web production export pass. Desktop light and narrow
mobile dark layouts were visually inspected using the real expense components
with local fixture adapters; this is not a live authenticated production test.

# Subscription billing architecture

## Runtime ownership

SchoolIMS Backend owns the school admin's complete runtime billing flow. It reads
the subscription, payment ledger, and receipt snapshots from that school's
cluster database and communicates directly with PhonePe. It never calls the
SuperAdmin API, so payments and downloads continue to work while SuperAdmin is
running only on a local machine or is offline.

SuperAdmin remains the authoring tool. When the founder saves a school's plan or
issues/cancels a receipt, its backend uses the existing cluster service-role
connection to mirror that record directly into the selected school database.
The SuperAdmin client list also reads the cluster subscription row, making a
PhonePe balance update visible the next time the local console loads.

## Data flow

1. SuperAdmin saves plan, due amount, dates, status, and optional reminder into
   central `billing_clients`, then upserts the same values into the cluster's
   `saas_subscriptions` row.
2. The authenticated school admin opens **Subscription & Billing**. SchoolIMS
   derives `school_id` only from the verified JWT and reads the three local SaaS
   billing tables.
3. SchoolIMS creates a local payment ledger entry before opening PhonePe Standard
   Checkout. Amounts are sent to PhonePe in paise.
4. A payment completes only after a validated PhonePe callback or an authenticated
   order-status check. The browser redirect does not complete a payment.
5. SuperAdmin's immutable receipt flow mirrors the issued receipt snapshot into
   `saas_subscription_receipts`. SchoolIMS renders and downloads that snapshot
   without contacting SuperAdmin.

## Setup

1. Apply `src/db/migrations/11_subscription_portal.sql` to the SuperAdmin
   database.
2. Apply `migrations/20260817_saas_subscription_billing.sql` to every SchoolIMS
   cluster database.
3. Copy the `PHONEPE_*` placeholders from SchoolIMS Backend `.env.example` into
   each SchoolIMS Backend deployment and replace them after merchant onboarding.
4. Configure this callback URL in the PhonePe merchant dashboard:

   `https://YOUR_SCHOOL_API/api/v1/admin/subscription/phonepe/callback`

5. Set the redirect URL to:

   `https://YOUR_SCHOOL_API/api/v1/admin/subscription/phonepe/return`

6. Keep `PHONEPE_ENVIRONMENT=SANDBOX` for UAT. Use `PRODUCTION` only with
   production credentials and public HTTPS callback/redirect URLs.

## Operational rules

- Treat callbacks as at-least-once delivery. The locked, idempotent completion
  transition reduces the balance once.
- Never issue a receipt based only on a redirect or client-side success screen.
- Keep PhonePe secrets only in SchoolIMS Backend; they are never shipped in the
  Expo app or stored in SuperAdmin.
- SuperAdmin reports a visible sync warning if an already-issued receipt could
  not be copied into a cluster. Do not issue a duplicate receipt; fix the cluster
  migration/connection first.
- Reconcile pending payments through **Check status**. Add a scheduled worker if
  payment volume later makes manual reconciliation insufficient.

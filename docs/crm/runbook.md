# CRM migration and rollout

## Environment

Required for SuperAdmin: `SCHOOL_SUPABASE_URL`, `SCHOOL_SUPABASE_ANON_KEY`, `SCHOOL_SUPABASE_SERVICE_ROLE_KEY`, `SCHOOL_DATABASE_URL`. CRM requires `CRM_DATABASE_URL`. If it is missing, CRM calls fail and do not use the School database. Do not put secrets in this document or in client bundles.

The frontend CRM client reads `EXPO_PUBLIC_SUPERADMIN_API_URL` and ignores cluster base-url switching.

## Order

Apply only to `CRM_DATABASE_URL`, in dependency order, not lexical filename order:

1. `09_dedicated_crm_baseline.sql`
2. `08_website_chat.sql`
3. `07_top_level_crm.sql`
4. `15_sales_crm_foundation.sql`
5. `16_school_prospect_import.sql`

`npm run migrate:crm` takes an advisory lock, stores a checksum, and applies each pending file in a transaction. A checksum mismatch stops the run. Do not edit an already-applied file.

School prospect flags, all read at process start:

- `CRM_FEATURE_PROSPECT_READS` default true
- `CRM_FEATURE_IMPORT_PREVIEW` default true
- `CRM_FEATURE_IMPORT_EXECUTE` default false
- `CRM_IMPORT_WORKER_ENABLED` default false

Enable execution only after migration 16 and a directory refresh. Run a single worker with `npm run crm:import-worker` or one instance of `CRM_IMPORT_WORKER_ENABLED=true`. Refresh customers with `node scripts/crmDirectoryRefresh.js`. A failed cluster must not be treated as an empty market.

Sales Command flags, also read at process start:

- `CRM_FEATURE_SALES_COMMAND_READ` default false
- `CRM_FEATURE_PILOT_WRITE` default false

Apply migration `17_founder_sales_command.sql` on the CRM database only, after 16. Do not run it against a school cluster. Leave reads and pilot writes off, deploy the writers, then enable read for internal SuperAdmins before founders. Enable pilot writes only after the lifecycle tests pass and clients can display `PILOT`.

Rollback of the feature: set both flags false and restart. Keep the tables, pilots, and history. Do not remap `PILOT` to another stage. Do not rerun migration 15 to repair new facts. Schema rollback is additive retention. A failed new index should be dropped by name and rebuilt outside the migration transaction if it was created concurrently. The indexes in migration 17 are ordinary transactional indexes for the bootstrap database.

The marketing SchoolIMS contact route still inserts with the publishable key. Confirm it targets this CRM before changing it. Until that topology is proven, do not claim website intake is covered.

Rollback: set `CRM_FEATURE_IMPORT_EXECUTE=false`, stop the worker, and keep the additive tables. `POST /imports/:batchId/compensate` with `{ "apply": false }` is the dry run. `{ "apply": true }` archives only an unused imported account that still matches the batch and has no tenant link. Do not undo school provisioning from this tool.

File bodies live in `crm_import_files` until `retention_expires_at` (default 30 days). Purge blobs with the recovery helper. Do not drop populated import or audit tables as an emergency rollback.


`15` is idempotent. It nullable-relaxes enquiry email, adds stage and outcome columns, catalogs, demos, proposals, onboarding operations, and the ingestion function. Historical `CLOSED` and `REJECTED` become `LEGACY_UNKNOWN` and stay out of win/loss. Follow-ups with an active owner become tasks. Ambiguous follow-ups and tenant links go to `crm_review_queue`.

SchoolIMS upgrade, on each cluster database: `node scripts/migrate_release.js --upgrade`. That applies `20260925_crm_handoff_correlation.sql`, which adds unique `schools.crm_correlation_key`. Run it before CRM onboarding creates schools. The column is also in `schema.sql` for new databases.

## Recovery

- Same onboarding idempotency key and payload resumes the operation.
- A crash after school insert is recovered by `crm_correlation_key` in that cluster. Retry must not create a second school.
- Defaults or first-admin failure leaves the school in place and marks the operation `FAILED`. Resume from the school add screen. Resend the admin password.
- Capacity is reserved with `school_count < max_schools`. A failed insert releases the reservation. Reconcile `clusters.school_count` against actual school rows if a process dies between reserve and release.
- Automation retries use `available_at` and dedupe on `rule_id` plus event key. A new real event needs a new `occurrence_id`.

## Logs

Onboarding logs `component: crm_onboarding` with `operation_id`, `cluster_id`, and `school_id`. They do not include email, phone, message, or admin password. Command failures return `code` to the client and keep the correlation id on the operation row.

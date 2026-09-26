# Validation results

Recorded after the sales CRM foundation changes. This is not a production deployment certificate.

## SuperAdmin backend

Command:

`node --test --test-concurrency=1 test/crm/salesFoundation.test.js`

Result: 8 passed, 0 failed, duration about 2.3s. Persistence is embedded PGlite, not a hosted Supabase project.

Covered:

- Activation stays `ONBOARDING` for `pending_build`, becomes `ACTIVE` only when `live` plus defaults and first admin, and does not turn suspension into churn.
- Ambiguous school ids return 409.
- Migration 15 backfill keeps historical `CLOSED` and `REJECTED` as `LEGACY_UNKNOWN`.
- Public phone-only and email intake succeed. An `anon` insert into `enquiries` is denied.
- Founder A receives 404 or 403 for Founder B on modern and legacy routes. A user with no founder scope receives 403. Stats are scoped.
- Example A: assign, call, qualify, demo, proposal v1, revise v2, accept, win, one school, link, stay `ONBOARDING` while `pending_build`, become `ACTIVE` after live readiness, replay the same onboarding key.
- Example B: loss, reopen, prior closure kept, crash after school create recovered by correlation key, same school on retry, other cluster school id 1 untouched, changed payload 409, full cluster 503, cross-owner document download 404.
- Automation failure retries once into one task, and a second occurrence creates a second task.
- Concurrent stage updates return 200 and 409.

`node --check` passed for the school routes, CRM router, provisioning helper, and SchoolIMS `scripts/migrate_release.js`.

## SuperAdmin frontend

`npx tsc --noEmit` exited 0.

`npx expo export --platform web` bundled `expo-router/entry.js` and wrote the web export. That checks compilation. It does not sign in or click through the CRM.

## Not verified

- No signed-in browser walkthrough of the lead desk, handoff, or retry screens.
- No iOS or Android device run.
- SchoolIMS `--upgrade` was not executed against a cluster database. The correlation migration is syntax-checked and registered. Apply it on each school cluster before CRM onboarding inserts `crm_correlation_key`.
- The SchoolIMS automated suite was not run. The profile route still takes `req.schoolId` from the server. Unrelated curriculum and release migrations were preserved.
- Production first-admin linkage was not executed against a live school database. The CRM provisioner now uses the same person, staff, user, and role steps as school creation, and a failed admin step leaves the school in place.

## School prospect import — 25 Sep 2026

Commands, from `NexsyrusSuperAdmin/SuperAdminBackend`, Node v24.18.0:

- `node --test --test-force-exit --test-concurrency=1 test/crm/prospectRules.test.js` — 12 passed.
- `node --test --test-force-exit --test-concurrency=1 --test-timeout 60000 test/crm/prospectFlow.test.js` — 1 passed, about 1.8s. It applied migration 16 on PGlite, rejected an Approver upload, imported two UDISE-grouped contact rows as one prospect plus a contactless school, created one enquiry, created no `schools` row, and read audit rows from the CRM database.
- `node --test --test-force-exit --test-concurrency=1 --test-timeout 180000 test/crm/salesFoundation.test.js` — 8 passed after migration 16, including public intake, founder isolation, won-sale onboarding, and activation.

Re-run on 25 Sep 2026, same machine, Node v24.18.0: all three files together passed 21 tests in about 3.9s. A 5,000-row in-process `normalizeSchool` loop took 46 ms and increased heap by about 547 KiB (RSS about 57 MiB). That is not an API latency test. No production p95 was measured. No signed-in browser or device pass was run for the new screens.

## Sales Command — 26 Sep 2026

Local PGlite only. No hosted database, production row, browser session, or device was used for this pass.

- `node --test --test-concurrency=1 test/crm/salesCommandRules.test.js` — rule boundaries, Kolkata today/week, owner 403.
- `node --test --test-concurrency=1 test/crm/salesFoundation.test.js` — 8 passed, process exit 0, about 2.2s, without `--test-force-exit`.
- `node --test --test-concurrency=1 test/crm/salesCommandMetrics.test.js` — school fixture: new leads, open pipeline, overdue once with two tasks, severe subset, demo completed in the month, intake backlog, spam excluded from cohort conversion, founder isolation, pilot start and same-key replay, different payload 409, zero school rows. Passed with the rule tests, 7 tests, process exit 0, about 2.2s.
- `node --test --test-concurrency=1 test/crm/prospectFlow.test.js` — 1 passed, process exit 0, about 2.0s, without `--test-force-exit`.
- `node test/sales-command.contract.test.cjs` from SuperAdminFrontend — 1 passed.
- `npx tsc --noEmit` from SuperAdminFrontend — the Sales Command files typecheck. One pre-existing CRM audit cast in `AuditLogsScreen.tsx` was narrowed with `unknown` so the new `typecheck` script can finish.

Not measured: 100,000-enquiry p95, physical Android frame time, signed-in browser drill-down, live migration ledger, and website-to-CRM topology. Do not call this production ready. Foundation migrations 15 and 16 must be in the release artifact before this dashboard is deployed. SchoolIMS unmerged files were not touched.


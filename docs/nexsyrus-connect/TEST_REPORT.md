# Test report — 30 October 2026

Results below distinguish focused Connect validation, broader regression results and unavailable external acceptance tests. All test data was synthetic/local. No production database, live employee notifications or private Slack messages were used.

## Final focused results

- **Connect backend: 27 passed, 0 failed, 0 skipped.** Command from SuperAdminBackend: `node --test test/connect/connect.test.js`. Actual postgres.js queries execute against PGlite PostgreSQL through its socket adapter; tests switch to the restricted roles and exercise RLS, constraints, transactions and real Express authentication. Evidence: `evidence/backend-connect-tests.log`.
- **Full frontend suite: 72 passed, 0 failed, 0 skipped.** Command from SuperAdminFrontend: `node --test tests/*.test.cjs`. Includes 11 Connect tests plus existing Books, sales, checklist, content, expenses, QR and fingerprint tests. Evidence: `evidence/frontend-tests.log`.
- **TypeScript: passed, no errors.** `node node_modules/typescript/bin/tsc --noEmit --pretty false`. The saved output is empty because checking completed without diagnostics: `evidence/typescript-check.log`.
- **Expo web export: passed.** `CI=1 node node_modules/expo/bin/cli export --platform web --output-dir /tmp/nexsyrus-connect-web-export-final`. Evidence: `evidence/web-export.log`. This is a build artifact, not a deployment.
- **Narrow integration diff/whitespace review: passed.** Existing changes attributable to Connect are the backend mount, frontend route policy and sidebar insertion; all implementation files are new. Initial fingerprint-related files retain their saved hashes. Three saved Books hashes changed during concurrent work (export.ts, api/books.ts, ReportsView.tsx); no Books file was edited by Connect work.

The host's Node executable was used directly because npm was not consistently available on shell PATH from the frontend directory. No package install, Node upgrade, lockfile rewrite or global configuration change was needed.

## Backend coverage

1. Real internal employee JWTs; missing/forged/expired credentials; revoked sessions; suspended employees; legacy school/Supabase tokens with matching employee email; CA exclusion and company membership.
2. Founder/admin creation, public join, private metadata/history, unique membership, manager checks, last-manager preservation, archive and announcement posting restrictions.
3. Concurrent calls from multiple employees, lost-acknowledgement retry keys, identical text with distinct message IDs, ordered history, older-message pagination, and SQL recovery across 215 messages in ascending 100-row pages.
4. Own-author editing/deletion, immutable message/conversation identity, content-free tombstones and metadata-only transactional audit.
5. Direct SQL reads/inserts/updates under collaboration_api, plus denied anon/authenticated access; these do not rely only on HTTP checks.
6. Same-conversation top-level thread parents, reply counts, nested/cross-channel rejection, and editing/deleting existing replies after parent deletion.
7. Reaction uniqueness/removal/allowlist and private-message protection.
8. Validated employee mentions; duplicate targets; atomic rollback after an unauthorized target; notification uniqueness across retries/edits/DM overlap; muted preferences.
9. Canonical A→B/B→A DM creation, self/foreign-employee rejection, and no founder access to other participants' content.
10. Search channel/author/mention/date inputs with RLS, removed-member history/search/notifications/mention exclusion and company isolation even for a shared employee identity.
11. Monotonic/clamped read positions, unread excluding own/deleted messages, and private read-state rejection.
12. Realtime role can read only authorized identifier events; wrong purpose/revoked sessions yield no events; unrelated employee data access is denied.
13. HTTP identifier/author/role validation and database-backed send rate limits.
14. Actual private file HTTP responses with attachment/nosniff headers; authorization on every download; author-only uploads; hash retry deduplication; deleted-source access denial. Storage is an injected local object store, not live Supabase Storage.
15. Spoofed/oversized/active PDF inputs, malformed ZIPs, bounded DOCX container structure, macro members and expansion bombs. Image tests use the actual sharp decoder/re-encoder and reject oversized dimensions. No claim is made that every PDF/Office malware technique is detected.
16. Personal saves, manager-only pins, expiring availability and denied cross-user status writes.
17. Existing school checklist conversion, current role/school/assignee/member checks, idempotent task linking and no automatic copy of confidential source text.
18. Explicit migration runner applies/journals both files and skips a second run. Managed Supabase Storage/publication branches require staging because PGlite has no managed Supabase services.

## Frontend coverage

Eleven Connect tests exercise multi-page reconnect reconciliation, old edits/deletes, stale revision rejection, duplicate event merges, nonadvancing-cursor failure, authentication before subscription, disconnect/rejoin signaling, disposal during delayed token acquisition, mobile channel→thread→conversation navigation, desktop channel/conversation layout, same-UUID failed-send retry, account-cache isolation, internal-only route policy and incoming links while already mounted. Company-access revocation clears the workspace and its cached results on a denied bootstrap. File-bearing failed sends survive channel navigation, and retry preserves a new composer draft rather than clearing it.

These use React test renderer and explicit API/native mocks. They verify application behavior, not physical-device rendering speed or native file-sharing integration.

## Browser/render evidence

The repeatable local fixture is `SuperAdminFrontend/tests/connect-preview.cjs`; run it from the frontend with `node tests/connect-preview.cjs`. It renders the actual Connect screen/theme/API client against synthetic local responses. It has no production credentials, persistence or live realtime connection.

- Desktop 1280×720: REA opened a thread and waited for its panel; all declared actions completed; owned browser cleanup completed. Evidence `ev_96547aab66da1dda7df01436907b6034e568c18d52a5621391753325d8f1b1e4`, `evidence/desktop-ui.json`, screenshot `evidence/connect-desktop.png`.
- Mobile web 390×844: REA opened the channel, opened its dedicated thread and waited for visibility; all declared actions completed; owned browser cleanup completed. Evidence `ev_2bf5124ba841e691405507d70272dbc001ef7c416df7cced47680d35f288d95f`, `evidence/mobile-ui.json`, screenshot `evidence/connect-mobile.png`.
- Desktop rendering and opening the thread were also inspected through the browser UI. Renderer tests cover the mobile back-navigation sequence. Screenshot evidence is web viewport emulation, not a physical Android test. Capture timezone was UTC; fixture content is synthetic.

## Broader backend regression run — failures retained

Command from SuperAdminBackend:

```sh
node --test --test-concurrency=1 test/connect/*.test.js test/crm/*.test.js test/books/*.test.js test/learningContent/*.test.js test/schoolPackage/*.test.js tests/sprint-definition.test.cjs test/schoolIntakeIntelligence.test.js
```

That earlier broad run (before four additional focused Connect cases were added) reported **159 tests: 146 passed, 13 failed, 0 skipped**. Evidence: `evidence/backend-regression-tests.log`. Focused tests were rerun after final changes; the entire broad suite was not repeatedly rerun after unrelated baseline failures were established.

All 13 failing test names were reproduced using original backend HEAD `7c87271e82b8fb1d6d9614ecc1b01cffbd89af0e` extracted into a separate temporary archive with the existing dependency directory. The archive excluded .env; the school-package comparison used dummy local configuration. Missing sibling-project paths differ in the temporary archive, but the absent external artifacts are the same. Baseline runs also had additional failures; those are retained in the evidence rather than hidden.

Existing failing areas:

- fieldFeedback: one existing permission expectation (403 versus 200).
- platformBoundary: four administrative, notification, email-binding and audit-fixture expectations. One requires an audit_logs relation absent from that fixture; the email-binding case is a genuine unresolved broader authorization concern, not a Connect pass.
- prospectFlow: one existing founder/import authorization expectation.
- salesCommandMetrics: one existing account-authorization expectation.
- salesFoundation: three existing founder-scope/owner-lifecycle expectations.
- trackableLinks: two tests require missing sibling `NexsyrusWebsite/apps/SchoolIMS/src/lib/trackingIngress.ts`.
- schoolPackage/render: one test requires missing sibling `SchoolIMS/SchoolIMS-Frontend/schoolims.template.json`.

Evidence: `evidence/baseline-comparison.json`, `evidence/baseline-crm-comparison.log`, `evidence/baseline-schoolpackage-comparison.log`. No new failing name in that broad run was absent from the baseline comparisons. This does not certify unrelated modules as regression-free, and those failures were not modified to make the suite green.

## Acceptance tests not performed

- Authorized logged-in Slack desktop/mobile runtime behavior (no REA-accessible authenticated target).
- Live Supabase publication/WAL delivery, managed-role compatibility, signing-key rotation and Storage policies.
- Actual employee FCM registration, push delivery and multi-mechanism device deduplication (sending infrastructure absent in this checkout; push enablement explicitly fails closed).
- Physical low-end Android/iOS scrolling, keyboard, file sharing, foreground/background transitions and device push.
- Full multi-backend PostgreSQL/MVCC scheduling and production-scale fanout/load.
- Antivirus/CDR, company-approved retention/legal hold, purge/backup recovery and production rollout.

Connect's local focused tests pass. Full production acceptance is pending these environmental and operational gates and review of the existing broader backend failures.

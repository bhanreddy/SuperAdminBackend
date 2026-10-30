# NexSyrus Connect — codebase audit

Audit date: 30 October 2026 (Asia/Kolkata). Source inspection, not a production database audit.

## Repository and preservation

The workspace itself has no Git repository. `SuperAdminBackend` and `SuperAdminFrontend` are separate repositories, both on `main` tracking `origin/main`.
Backend starting HEAD: `7c87271e82b8fb1d6d9614ecc1b01cffbd89af0e`; working tree clean.
Frontend starting HEAD: `3443bbe66457df633bd352f46ff5da3438cce783`.
Existing modified frontend files: AndroidManifest.xml, app.json, app/_layout.tsx, package.json, package-lock.json, TopBar.tsx, BooksAccountScreen.tsx, FounderSettingsScreen.tsx, authService.ts.
Existing untracked frontend files: docs/fingerprint-unlock.md, FingerprintSecurity.tsx, FingerprintContext.tsx, fingerprintService.ts, tests/fingerprint.test.cjs.
These files belong to pre-existing work and must be preserved. No AGENTS.md was found in the workspace or its containing project tree. No commit, push, deployment or live migration is authorized.

## Applications and boundaries

- Frontend: Expo 50 / React 18 / React Native 0.73, Expo Router, TypeScript, React Native Web. `app/(app)` contains school operations, CRM, finance, support and team routes. DashboardLayout/Sidebar/TopBar and ThemeContext are the native shell and design system.
- Backend: Express 4 / CommonJS, `src/app.js`, `src/routes/index.js`, existing `/api/super-admin` prefix. Catalyst AppSail CORS handling is already present. Do not introduce a second backend.
- Database: postgres.js raw SQL. `config/db.js` uses SCHOOL_DATABASE_URL for the shared control-plane database, including internal_users, sessions, school tasks and audit logs. `config/crmDb.js` intentionally uses a separate CRM database with no school-DB fallback. Medical has another Supabase client. Cross-database joins are not possible.
- Auth: `middleware/rbac.js` validates custom internal JWTs (issuer/audience, session, token_version) and legacy Supabase sessions; reloads roles/status/permissions. `verifySuperAdmin` restricts legacy routes to founders. New Connect routes must use authenticateUser and additionally require a canonical active internal_users row. The legacy founder fallback is insufficient for a foreign key to internal_users.
- Identity: `internal_users` is the employee directory, distinct from tenant `users` / `persons`. CA/CA_LEAD accounts are Books-only and excluded from Connect. Founders sync into internal_users through existing authentication. No duplicate employee directory is needed.
- Organization: no general internal organization registry exists. Books has `books_companies`, but those are accounting entities (including separate schemas), not employee communication tenancy. Introduce a small explicit internal organization and membership registry referencing internal_users; never use a school identifier as company scope.

## Existing capabilities

- RBAC: central `config/rbac.js`, user overrides, manager hierarchy, assignedSchoolIds; users routes handle invitations, deactivation, sessions and team scope.
- Tasks: school_onboarding_checklists has title, status, assignee, supervising manager, priority, due_date, instructions and evidence. `checklist.js` and workspace summaries reuse it. Sprint tasks belong to a fixed seeded sprint with constrained day/role and are unsuitable as a general company task store. Message conversion should extend school checklist tasks with an explicit authorized school, not fabricate a generic task platform.
- Messaging: `routes/superadmin/messenger.js` handles shared school support conversations and CRM website_chat conversations. These contain external participants and cannot become internal channels/DMs. Existing contracts remain unchanged. Frontend messengerService uses these REST endpoints.
- Notifications: an existing console notifications screen and school Firebase configuration/provisioning references exist. No firebase-admin dependency, FCM sending service, employee push token registry or push worker was found in this checkout. This is a verified integration gap, not an existing reusable delivery service.
- Realtime: Supabase JS is installed, but no reusable authorized internal employee realtime subscription was found. Custom application JWTs cannot simply be passed to Supabase Realtime. Use a separate least-privilege short-lived realtime token and a role with access only to authorized invalidation events; do not issue a generic authenticated token that could read unrelated school tables.
- Storage: backend Supabase service clients are used for receipts, posters and school configuration assets. Public poster URLs are inappropriate for confidential documents. Use a dedicated private bucket accessed only after conversation authorization. R2 is not established as an existing general attachment integration by inspected code.
- Audit: `services/auditLogger.js` writes audit_logs but catches failures. Confidential administrative changes need a transactional audit insert so an audit failure rolls back the change.
- API client: superAdminClient handles bearer tokens, refresh deduplication, auth invalidation and cluster base URL changes. Connect must use it for REST, clean up subscriptions on account/cluster change and never persist its realtime JWT.

## Migrations, contracts and tests

`src/db/migrations` contains additive SQL through 30_books_finance_connections.sql. Multiple numeric prefixes exist; lexical bulk application is unsafe. The RBAC runner only applies 001 and 23; CRM has an explicit dependency manifest and dedicated database target. Connect needs its own explicit runner targeting SCHOOL_DATABASE_URL and checking prerequisites, with no automatic application at server startup.

Existing backend tests use node:test, Supertest and actual PGlite PostgreSQL with postgres.js socket connections. Reuse this pattern to exercise constraints, RLS and transaction behavior. Frontend tests use node:test, TypeScript transpilation and React test renderer. Compilation alone is not acceptance.

## Risk findings

1. Existing backend SQL connections are privileged; enabling RLS alone would not protect queries made as the owner. Connect queries must run under an explicit NOBYPASSRLS role in transaction-local context.
2. School auth and internal auth share infrastructure. Connect policies must require explicit internal membership and active directory status, with no broad founder read bypass for DMs.
3. FCM and an authorized Slack runtime are not supplied. Record these gaps; do not claim live push, Slack interaction observation, native-device performance or production realtime validation without evidence.
4. Retention needs an explicit policy. Start with tombstones, metadata-only change audit and no automatic purge; do not silently erase history or send message bodies to push services.

Phase 0 completed before implementation. Further discoveries and actual validation outcomes are recorded in the remaining documents.

## Working-tree changes observed during implementation

Unrelated Books work appeared concurrently in both repositories after the initial clean backend snapshot, including its own `32_books_statements.sql`, services, screens and tests. Connect uses an explicit migration filename manifest, so the shared numerical prefix does not affect ordering. No Books file was edited by this work. Saved initial/concurrent frontend hashes changed only in three Books paths; fingerprint-related saved hashes remained unchanged. See CHANGELOG.md and evidence/preexisting-frontend-sha256.json for preservation context.

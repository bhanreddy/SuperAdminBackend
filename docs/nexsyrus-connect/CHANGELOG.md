# NexSyrus Connect change log

30 October 2026 — local implementation, not deployed.

## Added

- Audit, existing-feature comparison, evidence-qualified REA/Slack research, architecture, database, security, implementation and test documentation.
- Eighteen normalized collaboration domain tables, a migration journal, two dedicated roles, RLS policies, validation/invalidation/notification functions and explicit additive migration runner.
- Existing Express app mount `/api/super-admin/connect`; separate service/router/storage-extension modules. Existing support messenger contracts remain intact.
- Expo `/connect` route, employee-only route policy and sidebar entry; responsive native-theme workspace, virtualized messages, thread panel/mobile navigation, composer/retry, mentions, DM search, notification centre/preferences, filters, membership/company-access management, archives, pins/saves, file actions and existing-checklist conversion.
- Least-privilege Supabase event client with in-memory lease, cleanup, rejoin/foreground recovery, ascending cursor pagination and revision-aware merge.
- PostgreSQL/RLS/HTTP tests, frontend interaction/recovery tests and a repeatable local browser fixture using synthetic data.
- REA evidence for public Slack thread help and desktop/mobile local UI captures. No authenticated Slack app runtime was available.

## Reused

Existing internal_users/sessions/auth refresh, roles and permission overrides, school scope/delegation conventions, audit_logs, school_onboarding_checklists, postgres.js, Express, Supabase server client/storage SDK, Expo Router, theme, app shell, Axios client, document picker/file sharing, node:test, PGlite and React test renderer. No new package dependency was installed.

## Preserved

Initial fingerprint-auth changes and subsequent concurrent Books changes were not edited by this work. Only existing backend routes/index.js and frontend Sidebar/AppRouteGuard receive narrow Connect integration changes. The workspace root is not a Git repository; required documentation is stored at its requested docs/nexsyrus-connect path, outside the two component repositories. Include that directory deliberately when packaging/reviewing this work.

## Not yet accepted for production

Actual employee FCM push, authorized Slack desktop/mobile runtime investigation, live Supabase WAL/Storage/key compatibility, real-device performance/sharing, malware scanning/retention decisions and unrelated existing CRM/auth regression failures. No commit, push, production migration, production environment change, global agent setup or deployment was performed.

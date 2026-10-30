# Implementation and rollout status

Deployment update: the user subsequently authorized push/deployment. See [DEPLOYMENT_REPORT.md](DEPLOYMENT_REPORT.md) for the live targets, source revisions, applied migrations and remaining configuration gaps. The milestones below retain their implementation-phase context.

Read CODEBASE_AUDIT.md, REA_RESEARCH_REPORT.md, ARCHITECTURE_PROPOSAL.md, DATABASE_DESIGN.md, SECURITY_REVIEW.md and TEST_REPORT.md together. Source changes are local and uncommitted. No production deployment or database migration has run.

## Milestone 1 — implemented locally

Company scope, internal-session-only access, NOBYPASSRLS database transactions, channel creation/join/membership/purpose/description/category/archive, manager roles, announcement posting permissions, durable ordered history and send/edit/tombstone operations. Per-author client UUID makes retry idempotent. Schema and source review found that row SELECT FOR UPDATE applies UPDATE RLS too; read-only announcement/archive handling uses an advisory lock for ordering without widening read permissions. Tests exercise direct SQL attempts in addition to REST/service authorization.

Realtime uses Supabase Postgres Changes on identifier-only collaboration_events with its own read-only role and live authorization. This is row-authorized database change delivery, not an unrestricted Broadcast/Presence channel. REST provides authoritative content. Reconnect/foreground reconciliation, missed-page recovery, message revisions, scope cleanup and visible disconnected states are implemented. Live Supabase delivery still needs staging verification.

## Milestone 2 — implemented locally

One-level threads with parent/count/navigation, reaction allowlist, permission-aware mention autocomplete/highlighting, parent-author/participant thread notifications, unique recipient/message notifications, preferences, notification centre and navigation. Notification precedence prevents a DM that also mentions someone from creating separate duplicated notification rows. Failed sends retain the same retry UUID. No organization-wide mentions.

## Milestone 3 — implemented locally

Canonical secure one-to-one DMs; global message/channel/employee/mention search with conversation/author/date filters; explicit monotonic last-read positions and counts excluding own/deleted messages. Founders cannot retrieve nonparticipant DMs. The UI adapts between a desktop thread side panel and mobile conversation/thread navigation. A received message link is handled even when Connect is already mounted.

P0 local backend/frontend tests passed before secondary-feature implementation. This is a local implementation gate, not proof of production readiness. Employee FCM remains unavailable, so full P0 acceptance has not been claimed.

## Milestone 4 — implemented locally with stated limits

Private validated attachments with upload retry and authenticated downloads; manager pins, personal saves, five-minute explicit availability; original message links; and conversion into existing authorized school checklist tasks with title, reviewed instructions, employee, priority, deadline, status and an internal source reference. General company tasks are not fabricated because the audited general task store does not exist. Announcements use existing channel manager permissions.

File tests use an injected local object store; actual Supabase Storage configuration and native sharing require environment/device verification. Presence is explicit and expires, rather than claiming accurate continuously observed device presence. FCM, rich link previews and typed NEX MAXX/medical/project/CRM record integrations were not silently substituted with mock success.

## Reviewable rollout procedure

1. Select an authorized non-production control-plane database and corresponding Supabase project. Review the two new migration files and required employee/checklist schema. Preserve unrelated Books and fingerprint changes currently in the two repositories.
2. Verify the backend database role can create the two non-login NOBYPASSRLS roles and SET ROLE collaboration_api. Confirm PostgREST authenticator can assume only the read-only realtime role for its scoped JWT. Review restrictive storage policy compatibility with existing policies.
3. Explicitly run `node src/db/run-connect-migration.js --apply` from SuperAdminBackend against that staging SCHOOL_DATABASE_URL. The runner does not modify environment files. Check the journal and rollback behavior; no destructive down migration is supplied.
4. Confirm collaboration_events belongs to the existing supabase_realtime publication, the existing Supabase signing key matches Realtime, and two distinct internal employee accounts can join/reconnect without receiving inaccessible events. Test membership/session revocation during active subscriptions and more than 100 missed messages.
5. Verify the private storage bucket, revoked-member downloads, valid PNG/JPEG/PDF/DOCX/XLSX/PPTX samples, upload interruption, malicious inputs and operational cleanup. Decide scanning/quarantine and retention/legal-hold policies.
6. Create the appropriate company channels through the UI; suggestions are not hardcoded. Provision new employees through Company access after they exist in the current employee directory. Use channel membership management for department/project/founder privacy.
7. Provide the real employee FCM registration/sending integration before enabling push; implement/test durable-notification-ID deduplication on actual devices. No new provider credentials or paid service was configured by this work.
8. Resolve/review the existing broader backend regressions documented in TEST_REPORT.md. Complete real-device Android/iOS and representative load testing. Obtain explicit deployment/migration authorization before any production action.

## Infrastructure implications

No extra backend, database, task platform, login system, Slack subscription or per-user licence. Additional load uses existing PostgreSQL rows/indexes, short-lived realtime WebSocket connections, storage and egress quotas. Event fanout/notification creation grows with actual conversation membership; invalidations contain identifiers only and message reads hydrate batches. Explicit status invalidations fan out within the company. Files have an 8 MB limit and five-per-message ceiling. Exact costs depend on current Supabase plan/traffic; no fixed price or zero-cost production guarantee is asserted. Monitor event/rate metadata growth, connection count, outbox/storage failures and native memory before scaling.

## API inventory

All new routes share `/api/super-admin/connect`, the internal-session guard and no-store responses. Successful JSON operations return their resource/result directly (HTTP 200); validation/auth/membership errors use 400/401/403/404/409/429/503 as appropriate. Existing school/support/Books/CRM API contracts are unchanged.

- `GET /bootstrap`: current company/self, discoverable channels, joined DMs, unread counts and preferences.
- `GET /employees?q=&conversation_id=`: minimal permission-aware employee lookup. `POST /employees/:id` and `DELETE /employees/:id`: founder/admin company provisioning/revocation.
- `POST /channels`, `PATCH /channels/:id`, `GET /channels/:id/members`, `PUT /channels/:id/members/:userId`, `DELETE /channels/:id/members/:userId`: channel lifecycle and membership.
- `POST /direct-messages`: canonical internal pair, body employee_id.
- `GET /conversations/:id/messages`: before/after sequence, parent and bounded limit; `POST` same path accepts client_id, body, optional parent_id and mention IDs.
- `POST /conversations/:id/read`: monotonic last_sequence; `GET /messages/:id`, `PATCH /messages/:id`, `DELETE /messages/:id`: original-message retrieval and own-author mutations.
- `PUT /messages/:id/reactions`, `DELETE /messages/:id/reactions`: idempotent own emoji reaction state.
- `GET /notifications`, `POST /notifications/:id/read`, `PUT /preferences`: authorized in-app activity/preferences. Push enablement returns 503 until a real employee delivery provider is integrated.
- `GET /search`: q, conversation_id, sender_id, after_date, before_date, mentions_only.
- `POST /realtime-session`: short-lived read-only connection configuration; no service-role key or persistent frontend credential.
- `GET /messages/:id/attachments`, `POST /messages/:id/attachments` (multipart file), `GET /attachments/:id/download`: private attachments with authorization on every operation.
- `GET /saved`, `PUT /messages/:id/saved`, `DELETE /messages/:id/saved`; `GET /conversations/:id/pins`, `PUT /messages/:id/pin`, `DELETE /messages/:id/pin`.
- `GET /presence`, `PUT /presence`: company-visible explicit availability with expiry.
- `POST /messages/:id/task`: authorized existing school checklist conversion.

The frontend additionally reuses the existing `/api/super-admin/users` and `/api/super-admin/schools` directory/school contracts. Realtime adds one INSERT subscription to public.collaboration_events; message text and file contents are never subscribed to or broadcast directly.

## Exclusions and follow-up boundaries

All explicitly excluded Slack-scale features remain excluded. Rich unfurls are replaced by safe user-activated HTTP(S) links. Cross-product structured references await existing record/access contracts; ordinary URLs still open their original guarded screens. No separate general task system, automatic production seeding/deployment, commit, push, global REA setup, environment change or destructive live operation was performed.

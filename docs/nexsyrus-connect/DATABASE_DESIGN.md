# Database design

Target: existing control-plane `SCHOOL_DATABASE_URL`, which contains the internal directory and sessions. Despite its existing environment-variable name, Connect never uses `school_id` as company tenancy. No additional database is created. Do not apply this schema to CRM_DATABASE_URL or an individual school tenant database.

## Migration files and prerequisites

1. `SuperAdminBackend/src/db/migrations/31_nexsyrus_connect.sql`: core company/channel/messaging security and realtime invalidations.
2. `SuperAdminBackend/src/db/migrations/32_connect_extensions.sql`: attachments, saves, pins, availability and checklist integration.

Prerequisites: existing RBAC internal_users/internal_user_sessions/internal_user_permission_overrides/audit_logs, schools and school_onboarding_checklists with migration 23 delegation fields. Both migrations are applied explicitly by `src/db/run-connect-migration.js --apply`; the runner pins one connection, holds an advisory migration lock, and commits each migration and journal record atomically. A repeated run skips journaled files. Numerical prefixes also exist in unrelated Books work; use this explicit manifest, never glob every SQL file.

No live migration has been executed. Applying these files creates roles, grants, policies and a private bucket; review those changes against the intended non-production environment first.

## Entities

- `collaboration_organizations`: internal company registry; one initial `nexsyrus` row, no school identifiers or accounting-entity dependency.
- `collaboration_organization_members`: company access referencing existing internal_users. Migration 33 enrolls all existing active internal accounts. A trigger enrolls newly created active accounts and accounts transitioning to ACTIVE, regardless of role. Profile/role edits and logins do not restore explicitly removed membership; founders/admins can restore it through Company access. Deactivation in the existing directory also blocks access immediately.
- `collaboration_conversations`: common channel/DM history identity, company FK, kind, immutable DM pair, transactional sequence counter and timestamps. Canonical ordered DM pair has a unique company/pair constraint.
- `collaboration_channels`: same primary key as its conversation, company FK, unique company/name, category, public/private visibility, description, purpose, announcements-only flag and archive time. Public means discoverable/joinable by internal employees, not anonymously readable.
- `collaboration_channel_members`: unique channel/employee, member/manager role; reverse employee/channel index.
- `collaboration_messages`: unique UUID, conversation, author, client retry UUID, sequence, revision, root-parent FK, text and edit/delete timestamps. Unique conversation/author/client UUID deduplicates retry. Composite parent FK prevents cross-conversation threads; a trigger prevents nested replies and identity changes. Deleted roots remain tombstones; existing replies can still be edited/deleted. Database revisions prevent older client responses from restoring stale content or reactions.
- `collaboration_message_reactions`: unique message/employee/Unicode reaction; small allowlist, no custom assets.
- `collaboration_message_reads`: one employee/conversation watermark, not one receipt per message. API updates use GREATEST and clamp to committed conversation sequence. Unread excludes own messages and tombstones; includes replies. Mark read is an explicit conversation action.
- `collaboration_message_mentions`: unique message/employee, validated against current readable membership; self-mentions render but do not notify the sender.
- `collaboration_notification_preferences`: company/employee preference (all, mentions/DMs/threads/announcements, muted). Push remains disabled while no employee push provider is configured; enabling it returns 503 explicitly.
- `collaboration_notifications`: unique recipient/message, kind precedence mention → DM → participated thread → announcement → ordinary message. Holds references/read state, not a duplicate message body. Reserved push_state does not constitute a working FCM sender.
- `collaboration_events`: durable identifier-only invalidations: event ID, conversation ID, recipient ID, optional message ID and creation time. Only this table is added to an existing supabase_realtime publication. No message text, file paths or employee names enter realtime payloads.
- `collaboration_rate_limits`: minute buckets per employee/action, limiting successful operations across backend instances. Additional bounded process-local IP/employee attempt limiting counts invalid requests too.
- `collaboration_attachments`: authorized message FK, uploader, safe filename, MIME, byte size, private storage key and SHA-256. Unique message/hash makes upload retry idempotent. No public URLs.
- `collaboration_saved_messages`: unique employee/message, personal and membership-protected.
- `collaboration_pinned_messages`: message and pinning employee, channel-manager write permission and shared readable visibility.
- `collaboration_presence`: company/employee explicit online/away/busy, short note and five-minute expiry. Expired records read as away; not a proof a colleague is reading. Presence changes generate company-member invalidations.
- `collaboration_task_links`: one source message/existing school checklist task link, with source visibility enforced by RLS. Source references stay internal rather than being added to tenant-facing task fields.

The runner additionally creates `collaboration_schema_migrations`, a deployment journal. Existing school/CRM/support messaging schemas are not repurposed.

## Transactions and pagination

Message sending holds a per-conversation transaction advisory lock, checks current posting access, increments the conversation counter, inserts text, validates mentions, and creates deduplicated notifications in one transaction. Any failure rolls back the counter/message/notification changes. Operations use postgres.js bound parameters. Retry returns the existing message, including after an acknowledgement was lost.

History uses sequence keysets with bounded page size (default 50, maximum 100). Older history is descending in SQL then returned chronologically. Recovery uses ascending pages after a cursor so more than 100 missed messages cannot be skipped. Hydration batches author/reaction/mention/attachment fields rather than querying once per message. GIN full-text search uses the `simple` configuration and SQL RLS filters every candidate.

RLS SELECT policies protect all domain entities. REST transactions switch to NOBYPASSRLS `collaboration_api`, set server-only employee and company context locally, and reset automatically on commit/rollback. `collaboration_realtime` can SELECT only authorized identifier events and cannot read employee or school tables. Policies also check current active employee/company membership and active internal session/token version for realtime.

## Storage and retention

Where Supabase storage schema exists, the extension migration creates private `nexsyrus-connect` storage with an 8 MB ceiling. Restrictive anon/authenticated storage policies prevent broad pre-existing bucket policies from exposing it. The server additionally checks bucket privacy before upload/download. Objects are retrieved through authenticated API byte responses, not signed URLs that remain usable after membership removal.

Live text, threads, reactions, notification references and task source links have indefinite retention by default. Author deletion removes text immediately but retains a structural tombstone; audit records contain metadata, not past text. Attachments on deleted messages remain in private storage but become inaccessible. No automatic purge, legal-hold implementation or deletion job has been added. Company approval is needed for a production retention/legal-hold policy and eventual orphan/metadata cleanup. Events/rate buckets also need operational retention monitoring; reconnect recovery does not depend on retaining old events.

# Architecture proposal — NexSyrus Connect

Design completed after repository audit and before implementation. Independent implementation: Slack is a behavior reference, not a source-code or branding dependency.

## Deployment

Add `/api/super-admin/connect` to the existing Express app and `/connect` to the authenticated Expo app. Use the existing control-plane PostgreSQL database because it holds employees, sessions, checklist tasks and audit logs. Keep school support and dedicated CRM data separate. No new service, database or per-user subscription.

## Data and company boundary

An explicit `nexsyrus` internal organization references current internal_users through organization memberships. Channels and DMs reference this organization. Conversations unify history, pagination, threads and notifications; channels add management metadata and membership. DMs have a unique ordered employee pair and exactly those participants may read content. Company administrators can manage channels but have no implicit private-content or DM read rights. New hires are explicitly provisioned to the company registry by an authorized administrator.

## Defense in depth

Every REST request first passes existing authentication, then resolves canonical active employee/organization membership. Queries execute in a transaction with `SET LOCAL ROLE collaboration_api` (NOBYPASSRLS) and a transaction-local server actor. RLS protects conversations, messages, reactions, notifications, reads, attachments and saved messages. Helper functions have fixed search_path and narrowly scoped SECURITY DEFINER access to break membership-policy recursion. No browser write privileges are granted. All API identifiers and user input are validated; rendering uses text nodes only.

## Reliable delivery

Persist messages, mention targets, deduplicated notifications and a small invalidation event in one transaction. A client-generated UUID is unique per sender and conversation; retries return the original message. Conversation row locking serializes sequence allocation, making read watermarks and pagination independent of clock collisions or out-of-order transaction commits. History uses keyset pagination; reconnect reconciles durable history by sequence and ID. Thread parents must be top-level messages in the same conversation.

Evaluate Supabase Postgres Changes against a dedicated collaboration_events table containing identifiers only. A short-lived token uses a dedicated read-only database role and live employee/session authorization; no service keys or generic school authenticated role enter the frontend. Subscribe to authorized conversation/user invalidations, fetch changed data through REST, and reconcile on successful rejoin and app foreground. A disconnected UI must say so. No periodic message polling. Supabase deployment configuration and key compatibility require separate environment validation.

## Notifications, storage and retention

One recipient/message notification is chosen by precedence (mention, DM, thread, announcement, channel) and shared by the in-app centre and future push adapter. Preferences suppress optional notifications; no @everyone. No message content appears in invalidation or push payloads. FCM is an audited missing dependency; do not claim delivery without a configured provider/device test.

Attachments use a dedicated private Supabase bucket, strict size/type/signature validation and authenticated download. Reject active formats/macros/HTML/SVG and do not fetch arbitrary user URLs for previews (SSRF). Plain safe links suffice initially. Deleted messages become content-free tombstones; edits and deletes generate metadata audit events. Default retention is indefinite pending a company-approved retention/legal-hold policy; no purge job runs automatically.

## Milestones and gates

1. Schema, RLS, channel management, idempotent history/send and authorized realtime client. Prove cross-user/cross-company isolation with real SQL.
2. Threads, reactions, restricted mentions and notification centre. Prove transaction and deduplication behavior.
3. Secure DMs, filtered search and monotonic unread tracking. Prove administrators cannot read nonparticipant DMs and removed members cannot recover content.
4. Only after P0 checks: private attachments, pins/saves, explicit presence and conversion to existing authorized school checklist tasks. No separate generic task system.

Each milestone requires actual automated checks, migration/security review and recorded responsive UI coverage. Native-device performance, production publication/key configuration and actual push require available external environments. Production deployment, migrations and environment changes remain manual review steps.

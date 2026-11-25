# Notification centre

The shared inbox serves the 16 roles in the **SuperAdmin employee directory**. School parents, students, medical customers, and staff accounts owned by other applications are outside this directory and are not silently enrolled.

Examples: an implementation executive receives an assigned onboarding task; a CA receives a Connect mention or an accounting access change. Neither gains access to the other's records.

## Rollout

Install the existing optional business modules first, then apply these migrations once. The runner takes a database advisory lock, records applied files, and rolls back failed migrations. It does not run DDL at API startup.

From `SuperAdminBackend`:

```sh
npm run migrate:notifications -- --apply
npm run migrate:notifications -- --apply --crm
```

The first command targets `SCHOOL_DATABASE_URL` (the control-plane database); the second targets the separate `CRM_DATABASE_URL`. Do not point the CRM command at a tenant database. Run the second command only when CRM is configured. Module triggers attach only to tables installed when the migration runs. New Books companies attach their activity trigger during company initialization. Future business modules must attach their source trigger as part of their migration.

Deploy the backend and frontend after migrations. Inbox operation needs no external provider. The server starts a five-second worker. The app polls summary changes about every 15 seconds while visible, backs off to two minutes on failures, and refreshes on resume. Later inbox pages remain stable until the user refreshes available updates.

No production migrations, deployment, provider credential changes, or real user messages were performed as part of local implementation/testing.

## Channels and event sources

Business channels: announcements, account/security, assignments, support, sales/CRM, finance, payroll, requirements/approvals, builds/deployments, curriculum, Connect, and system.

Control-plane triggers capture installed requirements, complaints, onboarding checklists, employee access changes, school assignments/removals, selected security/configuration audits, Connect notification rows, targeted legacy notifications, school intake, expenses, collections, sprint tasks, learning-content requests, curriculum versions/releases, billing documents, payroll runs, Books access/activity, and school package jobs. Source bookkeeping updates do not produce alerts; status, assignment, priority, deadline, and access changes do.

The separate CRM outbox captures installed enquiries, tasks, demos, proposal versions, pilots, imports, onboarding operations, visits, follow-ups, and feedback items. Its bridge copies generic signals to the control plane and acknowledges the CRM row only after the destination insert commits. Retries use a unique source key. A CRM outage does not block control-plane delivery.

Examples: a ticket escalation produces a high-priority support alert; a failed package job produces a deployment alert for currently authorized school users. Operational records include their school ID. Financial, payroll, and CRM alerts use generic signals rather than copying sensitive amounts, salaries, or customer records into notifications.

Curriculum changes made by another service only appear if that service writes the installed source tables. External providers/services need an authenticated integration or transactional event producer; this module does not invent events it cannot observe.

## Routing and privacy

- Authenticate with the existing JWT/session middleware and reload current account status, role, permission overrides, and school hierarchy on every request.
- Every inbox, read, archive, preference, and device operation scopes to `req.user.id`. The client cannot select another recipient. Role targeting never grants application access.
- Fanout intersects explicit recipients/current role audiences with active accounts, required permissions, and current school scope. Reads and external sends recheck permission/school access. Support goes to ticket participants and founders, rather than all staff assigned to that school.
- Security alerts cannot be disabled in-app. Critical alerts bypass inbox muting. External transports remain opt-in, including for security.
- Direct Supabase clients have no grants to notification tables. RLS is enabled; the server uses its trusted database connection.
- Push/email/SMS carry a generic message and inbox reference. Record access stays behind the original module's authorization. Connect previews do not expose private message content. Connect and legacy source read states mirror the shared inbox in both directions, including reads before fanout.
- Existing targeted legacy inbox rows import with their read state. Unaddressed legacy global rows are not assigned to arbitrary users. The previous founder API remains for compatibility; the application UI uses `/notifications`.

## Delivery providers

External delivery is disabled until configured, and the UI reports that state. Enabling a provider affects future events; historical events are not resent automatically.

### Native Android and iOS push

The frontend includes the SDK-50-compatible `expo-notifications` dependency and config plugin. **Build and install a new native app**; a JavaScript-only update cannot add the native module. Configure the project's Android FCM v1 and Apple APNs credentials in EAS. See [Expo setup](https://docs.expo.dev/push-notifications/push-notifications-setup/).

Backend environment:

```dotenv
NOTIFICATION_EXPO_PUSH_ENABLED=true
# Set this when Expo enhanced push security is enabled for the project:
NOTIFICATION_EXPO_ACCESS_TOKEN=<server-only-expo-access-token>
```

In the native app, open Notifications → Preferences → Enable push on this device. Only this explicit action requests OS permission. Android creates named notification channels first. Then enable Push for the desired business channels. Token rotation re-registers already-enrolled devices without displaying a permission prompt. Sign-out/session revocation prevents subsequent sends. Notification taps open the current authenticated inbox, never an arbitrary payload URL.

Expo tickets are saved as `awaiting_receipt`; the worker polls receipts after 15 minutes. A successful receipt confirms handoff to FCM/APNs, not that a human saw the message. Missing receipts eventually dead-letter, and `DeviceNotRegistered` removes the token while retaining failure evidence. See [Expo delivery semantics](https://docs.expo.dev/push-notifications/sending-notifications/).

Web supports the full in-app centre. Web background push enrolment/service workers are not included. The native device enable action is therefore absent on web.

### Direct FCM integration

For separately registered FCM tokens, configure:

```dotenv
NOTIFICATION_FCM_SERVICE_ACCOUNT=<service-account-json>
NOTIFICATION_APP_URL=https://your-app.example/notifications
```

Service-account JSON remains server-only. OAuth assertions use RS256, form-encoded token exchange, and a cached expiring access token. The worker uses the [FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send/v1-api). Unregistered tokens are removed. Native Expo tokens route to Expo even when direct FCM is also configured.

### Email, SMS, or custom push gateway

```dotenv
NOTIFICATION_EMAIL_WEBHOOK_URL=https://gateway.example/notifications/email
NOTIFICATION_SMS_WEBHOOK_URL=https://gateway.example/notifications/sms
NOTIFICATION_PUSH_WEBHOOK_URL=https://gateway.example/notifications/push
NOTIFICATION_WEBHOOK_SECRET=<at-least-32-random-characters>
```

URLs are server configuration, HTTPS-only, without embedded credentials. Redirects are refused. Each request has an eight-second timeout and a JSON body:

```json
{
  "id": "stable-delivery-uuid",
  "user_id": "employee-uuid",
  "notification_id": "inbox-uuid",
  "channel": "support",
  "transport": "email",
  "recipient": "employee@example.test",
  "title": "NexSyrus notification",
  "body": "You have a new notification. Open your inbox to view it.",
  "path": "/notifications"
}
```

Headers: `Idempotency-Key` is the delivery UUID; `X-NexSyrus-Timestamp` is Unix seconds; `X-NexSyrus-Signature` is hex HMAC-SHA256 of `timestamp + "." + exactRequestBody`. The gateway must verify signature/timestamp, deduplicate by delivery UUID, and return 2xx only after durably accepting the request. A 2xx confirms gateway acceptance, not a delivered email/SMS. Provider delivery receipts beyond Expo are the gateway's responsibility.

Examples: replays after a timeout must return the original acceptance without sending another email; an HTTP 429 response must allow a later retry rather than discarding the SMS.

## Reliability and operational limits

Source capture and workflow writes share one transaction. A rollback removes both. The worker fanout transaction is atomic, protected by `FOR UPDATE SKIP LOCKED`, and deduplicated by `(event_id,user_id)`. A failing event uses a savepoint, exponential backoff/jitter, and a dead letter after eight attempts; it cannot poison later events.

External jobs use per-device delivery rows, two-minute leases, ownership tokens, retry backoff, and dead letters. A stale worker cannot acknowledge a replacement worker's lease. Preferences, active status, audience, school scope, and device session are rechecked immediately before sending. Expired/revoked device sessions do not receive queued push.

**Exactly-once external delivery cannot be promised.** A provider may accept a send immediately before the process dies. The durable job can then retry. Gateways must deduplicate; FCM notification tags and collapse identifiers reduce duplicate display but are not an exactly-once guarantee. Human reading is represented only by inbox read state.

Founder announcements require an idempotency key, reject key reuse with different content, and allow at most ten new announcements per actor per minute. All notification writes share a database-backed 120-request/minute/user limit. Inbox pagination uses `(created_at,id)` and preserves PostgreSQL microseconds. Mark-all-read takes a snapshot watermark so later arrivals remain unread.

No claim of measured 60fps or physical-device delivery is made by Node tests. Verify release builds on Android/iOS with configured credentials before enabling push for users.

## API

All paths below are relative to `/api/super-admin/notifications`. All require the existing Bearer token. Responses follow `{success:true,data:...}`; list responses add `next_cursor`. Errors use the existing central handler.

- `GET /bootstrap`: channels, unread counts, preferences, configured transports, active registered-device count.
- `GET /?channel=support&unread=true&limit=30&before=<cursor>`: caller inbox, limit 1–100.
- `PATCH /:id` with `{operation:"read"|"unread"|"archive"}`: caller's record; read/archive retries are idempotent.
- `POST /read-all` with `{through:"<snapshot timestamp>",channel?:"support"}`.
- `PATCH /preferences/:channel` with boolean `inbox_enabled`, `email_enabled`, `push_enabled`, `sms_enabled` fields.
- `POST /announcements` with `{title,body,roles:[],priority:"normal"|"high"}` and a 16–100-character `Idempotency-Key`: founder-only. Empty roles means all current active employees.
- `POST /devices` with `{token,platform:"android"|"ios"|"web"}`: bind to the authenticated internal session.
- `GET /devices/current`, `DELETE /devices/current`: inspect/remove registrations for the caller's current session.
- `DELETE /devices/:id`: remove the caller's device.
- `GET /health`: founder-only queue counts, oldest pending event, transport states, and up to 50 dead events/deliveries.
- `POST /events/:id/retry`, `POST /deliveries/:id/retry`: founder-only dead-letter replay. Fix provider/configuration errors before replay.

Device status/revocation examples: an enrolled phone can disable its current session without affecting a colleague's device; a founder viewing queue health cannot use inbox APIs to mark a colleague's alert read.

## Verification and recovery

```sh
# Backend SQL + real JWT/session integration and provider contract tests
npm run test:notifications
# Existing Books scope/workflow checks
npm run test:books
# Frontend checks, from SuperAdminFrontend
npm run typecheck
npm test
npm run build:web
# Synthetic local visual preview
node tests/notifications-preview.cjs
```

Failure tests cover cross-user writes, all 16 roles, CA password boundaries, school/permission revocation, poisoned fanout, microsecond cursor ties, session-bound push, stale leases, provider backoff, receipt handling, and cross-database bridge replay. Frontend tests cover failed actions, preserved announcement keys/drafts, late responses, native permission refusal, account changes during enrolment, and safe tap navigation.

If notifications are unavailable, first check migration installation and `GET /health`. If CRM signals stop while other channels work, inspect `crm_bridge_unavailable` logs and pending CRM outbox rows. If a provider fails, fix its configuration, then replay the dead IDs returned by health. Rollback application code without dropping event/inbox tables; queued events remain durable for the next compatible worker. Disabling a transport stops new fanout; remove opt-ins or stop the notification worker when existing external queues must be halted.

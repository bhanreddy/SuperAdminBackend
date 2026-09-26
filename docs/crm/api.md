# Sales CRM API

Base path: `/api/super-admin/crm`. Legacy enquiry reads and writes remain at `/api/super-admin/founder/enquiries` and call the same services. CRM requests must use the central SuperAdmin API. Cluster switching does not retarget them.

Authenticated responses use the existing JSON body. Errors are `{ error, code }`. Optimistic conflicts are HTTP 409 `VERSION_CONFLICT`. Out-of-scope records are HTTP 404.

## Leads

`GET /leads` returns `{ data, page: { limit, next_cursor } }`. Filters: `q`, `status`, `stage`, `outcome`, `owner`, `territory_id`, `channel_id`, `source`, `category`, `unassigned`, `limit` (1–100), `cursor`.

`GET /leads/:id` returns the lead plus bounded activities, tasks, demos, proposals, onboarding operations, closures, and stage history.

Mutations that change a lead require `expected_version`.

| Command | Path |
|---|---|
| Assign owner | `POST /leads/:id/owner` |
| Move stage | `POST /leads/:id/stage` |
| Log activity | `POST /leads/:id/activities` |
| Create task | `POST /leads/:id/tasks` |
| Complete or cancel next action | `POST /leads/:id/tasks/:taskId/complete` |
| Close | `POST /leads/:id/close` |
| Reopen | `POST /leads/:id/reopen` |
| Correct source | `POST /leads/:id/source` |
| Set territory | `POST /leads/:id/territory` |

Stages: `NEW`, `CONTACTED`, `QUALIFIED`, `DEMO`, `PROPOSAL`, `NEGOTIATION`, `PILOT`. Outcomes: `OPEN`, `WON`, `LOST`, `DISQUALIFIED`, `LEGACY_UNKNOWN`. Open `PILOT` uses the same legacy status as the other post-qualification stages: `QUALIFIED`.

Legacy status mapping for new writes: open `NEW`/`CONTACTED`/`QUALIFIED` keep those statuses; open `DEMO`/`PROPOSAL`/`NEGOTIATION` map to legacy `QUALIFIED`; `WON` maps to `CLOSED`; `LOST` and `DISQUALIFIED` map to `REJECTED`. A legacy PATCH of `CLOSED` or `REJECTED` returns `USE_CLOSE_COMMAND`. Historical `CLOSED` and `REJECTED` rows stay those statuses and become `LEGACY_UNKNOWN` with `outcome_review_required`. They are excluded from win/loss rates.

## Demos and proposals

`POST /leads/:id/demos` schedules a demo and does not move the stage. `POST /demos/:id/reschedule` and `POST /demos/:id/finish` record history and a result of `COMPLETED`, `CANCELLED`, or `NO_SHOW`.

`POST /leads/:id/proposals` creates proposal version 1 as `DRAFT`. `POST /proposals/:id/revise` inserts the next version after issuance. `POST /proposal-versions/:id/transition` moves `DRAFT → SENT|WITHDRAWN` and `SENT → ACCEPTED|REJECTED|EXPIRED|WITHDRAWN`. `delivery_state: RECORDED_SENT` means a person recorded the send. It is not email delivery. Commercial fields on an issued version are immutable. `POST /proposal-versions/:id/documents` stores a private file. `GET /documents/:id` downloads it only for a caller who can read the lead.

`WON` requires a close date, confirmed value and currency, and an accepted proposal or an authorized exception. `LOST` and `DISQUALIFIED` require a catalog reason code. Closure resolves open tasks and scheduled demos. Reopen requires a reason and a next action and keeps the prior closure row.

## Onboarding and activation

`POST /onboarding` body includes `idempotency_key`, `enquiry_id`, `name`, `code`, `cluster_id`, and optional `admin`. The enquiry must be `WON` and the vertical `SCHOOL`. The same key and payload returns the same operation. A changed payload is HTTP 409 `IDEMPOTENCY_CONFLICT`. Success is HTTP 200. A visible partial failure is HTTP 202 with `failure_reason`. Retry with `POST /onboarding/:id/retry` and resend `admin` because the stored payload redacts the password.

The operation records `RESERVE_CAPACITY`, `CREATE_SCHOOL`, `SEED_DEFAULTS`, `FIRST_ADMIN`, and `LINK_CRM`. The link uses the cluster returned by provisioning and sets the CRM account to `ONBOARDING`. `POST /accounts/:id/sync-activation` reads school readiness. The account becomes `ACTIVE` only when onboarding status is `live`, defaults are seeded, and a first admin exists. `suspended` does not become `CHURNED`. `pending_build` stays `ONBOARDING`.

Direct school creation without an enquiry still uses `POST /api/super-admin/schools`. Medical and other non-school links may still set `ACTIVE`. School accounts cannot.

## Work and reports

`GET /work?timezone=Asia/Kolkata` returns overdue, today, upcoming, missing action, and expired exception queues. Today and overdue use the requested timezone, otherwise `Asia/Kolkata`.

`GET /reports/sales` keeps its previous meaning. Totals are split by currency. Its win rate uses won divided by won+lost+disqualified in the close-date window. `LEGACY_UNKNOWN` is counted separately and excluded from that denominator. Proposal amounts are not revenue. Sales Command does not replace this report.

## Sales Command

Reads are mounted under `/sales-command` and return 404 `FEATURE_DISABLED` unless `CRM_FEATURE_SALES_COMMAND_READ=true`. Pilot writes return 404 `FEATURE_DISABLED` unless `CRM_FEATURE_PILOT_WRITE=true`. Responses set `Cache-Control: private, no-store`. There is no `school_id` and no success wrapper.

`GET /sales-command/summary` is one read-only repeatable-read snapshot. Stock metrics are labeled Now and ignore the creation window. Event metrics use `period=today|week|month|custom` in the requested IANA timezone, default `Asia/Kolkata`. The comparison is the previous equal-length interval. Unknown evidence is null, not zero. `scope_label` is `Company school sales` for an active SuperAdmin and `My pipeline` for a founder or approver.

`GET /sales-command/funnel`, `/trends`, `/aging`, `/follow-ups`, `/attention`, `/owners`, and `/opportunities` use the same filters. `metric` is required for opportunities. Account metrics `new_prospects` and `intake_backlog` return accounts. `decision_numerator` and `decision_denominator` return closure events. Other metrics return distinct enquiries. Cursor pages do not include contact notes. A list total that differs from `expected_total` sets `updated_since_dashboard_refresh`.

`POST /leads/:id/pilots` creates a planned pilot. `POST /pilots/:id/transition` with `action` `START`, `COMPLETE`, or `CANCEL` requires the lead `expected_version`, `pilot_expected_version`, and an idempotency key. The same key and payload replays. A different payload is HTTP 409. Starting a pilot moves the lead to `PILOT` in the same transaction when an edge exists. `PATCH /pilots/:id` edits planned dates only while the episode is planned or active.

`GET /prospects?without_enquiry=true` limits the directory to school accounts that have no enquiry.

`GET /catalog` lists stages, edges, territories, channels, and reasons. Territory, membership, and archive writes are SuperAdmin only. `GET /review-queue` is SuperAdmin only and lists open ambiguous follow-ups, legacy outcomes, and tenant links without customer message text.

## Public intake

`POST /api/public/enquiries` accepts phone-only or email submissions through `ingest_website_enquiry`. Owner, account, stage, outcome, value, and conversion fields in the body are ignored. Table INSERT for `anon` and `authenticated` is revoked where those roles exist.

## School prospects and import

See `docs/crm/school-prospects.md` for normalization, duplicate classes, and rollout limits.

`GET /prospects` is cursor-paginated school accounts, including contactless prospects. `POST /prospects` creates through the same normalization and match service. `PATCH /prospects/:accountId` requires `expected_version` and rejects lifecycle, owner, and tenant fields. `POST /prospects/:accountId/enquiries` creates or links an enquiry only when a real email or phone exists.

`POST /imports` accepts multipart field `file` and returns `{ id, status }`. Mapping, preview, decisions, confirm, retry, and cancel are under `/imports/:batchId`. Confirm requires `expected_version`, `preview_revision`, `preview_hash`, and `idempotency_key`. The same key and payload returns the original acknowledgement. A different payload is HTTP 409 `IDEMPOTENCY_CONFLICT`.

`GET /audit-logs` on this CRM router reads CRM `activity_logs`. It does not replace the founder audit route.


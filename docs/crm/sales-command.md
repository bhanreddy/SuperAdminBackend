# Founder Sales Command

School sales for the central CRM. This is not a second CRM, not a school tenant view, and not a replacement for `GET /reports/sales`.

## Scope

Active SuperAdmins see company school sales. Founders and approvers see owned records, labeled **My pipeline**. Approvers are read-only. A task assigned to someone else does not grant lead access. Nested enquiries on an account are filtered by enquiry owner. Inaccessible ids return 404.

School membership is `crm_school_sales_class`: a SCHOOL account, or an unlinked enquiry whose product or category is `SCHOOL` or `SCHOOLIMS`. Contradictory account and lead verticals are `CONFLICT` and stay out of the school totals. Medical, retail, and other leads are unchanged.

## Time and evidence

`evaluated_at` is the database clock inside one read-only repeatable-read transaction for a summary. Periods are `[from, to)` in the requested IANA timezone. Week starts Monday. Custom ranges are inclusive local dates, exclusive at the next midnight, capped at evaluation, and rejected past 366 days. The comparison period is the previous interval of the same elapsed length.

Stock metrics (open pipeline, stage occupancy, due today, overdue, active pilots, intake backlog) are **Now**. They do not inherit the creation window. Event metrics use the selected period. Unknown stage entry, demo completion, or contact evidence stays null. It is not counted as zero and it is not backfilled from `updated_at`.

Capture starts at `crm_capture_epochs.id = sales_command_v1`, written once by migration 17. Replaying the migration does not move that timestamp.

## Metrics

Definitions live in `src/services/crm/salesCommandRules.js` and the SQL in `src/services/crm/salesCommandQueries.js`. The summary contract is `src/services/crm/salesCommand.js`.

- New leads: school enquiries created in the period.
- Became contacted / qualified: distinct enquiries with an observed `STAGE` history row, not baseline or reopen.
- Demos booked: the original demo row's `created_at`. A reschedule is not another booking.
- Demo completed: authoritative `completed_at` in the period. Cancellation and no-show are separate.
- Proposals sent: distinct enquiries with a version `sent_recorded_at` in the period. That is a recorded send, not proof of delivery.
- Active pilots: open enquiries with `crm_pilots.status = ACTIVE`. A passed planned end does not auto-complete.
- Wins and losses: distinct enquiries with a matching closure in the period. Reopening does not delete the closure.
- Cohort conversion: ever-won by evaluation time, among leads created in the period, excluding duplicate and spam disqualifications from both sides. Other disqualifications stay in the denominator. A zero denominator is null.
- Decision win rate: won closure events divided by won plus lost closure events in the period. This is not the distinct win and loss cards, and it is not the legacy report denominator.
- Overdue: one open enquiry counts once even when several eligible tasks are overdue. Severe means due at or before evaluation minus 72 hours and is a subset of overdue.
- Due today: eligible open tasks due from evaluation until the next local midnight. Earlier today is overdue.
- Founder attention: one row per enquiry, or one account-only prospect. Highest severity orders the row. All matched reasons stay visible.
- Intake backlog: unarchived school prospects with no enquiry, including contactless schools. They are not fabricated leads.

Eligible follow-ups are `FOLLOW_UP`, `CALL`, `EMAIL`, or `MEETING` in `OPEN` or `IN_PROGRESS` with an active assignee and a due time. Onboarding, collection, and approval tasks are not sales follow-ups.

Money stays decimal strings per currency. INR and USD are never added. The high-value attention threshold is INR 100000. Other currencies say the threshold is not configured.

## Pilots

`PILOT` is an additional stage. `NEGOTIATION` remains. Edges added: proposal to pilot, negotiation to pilot, and the reverse edges, which require a reason. Starting a pilot and entering `PILOT` commit together. A direct win without a pilot is still valid. Closing an enquiry cancels planned and active pilots and keeps completed episodes.

## Flags

Read at process start. A change needs a restart.

- `CRM_FEATURE_SALES_COMMAND_READ` default false
- `CRM_FEATURE_PILOT_WRITE` default false

Disabling the flags hides the reads and pilot commands. It does not delete pilots, history, or the evidence columns.

## What this does not certify

PGlite tests are not a latency benchmark and not a production release. The 100,000-enquiry budget was not measured. No physical Android device was timed. Website topology for `NexsyrusWebsite` contact insert was not proven, so that route was not switched. SchoolIMS tenant code was not changed.

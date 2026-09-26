# Field feedback

Field teams capture a feature request, objection, curriculum finding, or an unsure note from the founder console. The original wording is stored on `field_feedback_submissions` and is immutable. Each actionable backlog row is a `field_feedback_items` record.

## Routing

Configurable rules live in `field_feedback_routing_rules`. Defaults:

| Category | Destination | Accountable team |
| --- | --- | --- |
| Feature request | Product backlog | Product |
| Objection | Sales/Enablement backlog | Sales and Enablement |
| Curriculum finding | Curriculum backlog | Curriculum |
| Unsure | Triage queue | Feedback triage |

If no rule matches, or two active rules for the same category point at different destinations, the item goes to triage. The capture form shows that destination before submit. A submission does not commit a delivery date.

There is no live Product, Sales/Enablement, or Curriculum backlog API in this service. The 11-day sprint, curriculum publication plane, and CRM follow-up tasks are different workflows, so this migration creates internal queues in `field_feedback_queue_entries`. Super admins, and founders listed in `field_feedback_triagers`, can change rules and the optional default owner on each destination.

Routing state (`pending`, `routed`, `failed`) is separate from backlog status (`new`, `needs_clarification`, `accepted`, `in_progress`, `resolved`, `duplicate`, `declined`). The submission is saved before routing. A failed route stays visible in Needs triage and can be retried. The queue row is unique per item, so a retry does not create a second destination item. Repeating the same `client_key` and payload returns the original submission.

## Triage

Triagers can reclassify, reroute, assign an owner, and split one submission into linked items. Split items keep the original observation and the original submission row. Duplicate links keep both submissions. Suggestions never merge records.

Submitter-reported urgency and owner-assigned triage priority are different fields.

## Access and notifications

Reads follow founder CRM scope: the submitter, the item owner, the account owner, the destination's default owner, and triagers. Everyone else receives not-found. Attachments use the same check. Approvers cannot submit.

Queue entry notifies the item owner, otherwise the destination's default owner, otherwise active triagers. Clarification and resolution notify the submitter. Notices are written to `field_feedback_notifications` and, when the school database has the founder console `notifications` table (`user_id`, `founder_id`, `title`, `body`, `type`), to that existing channel. The SchoolIMS `notification_events` pipeline is not used.

## Not tested against a live service

Tests run against temporary Postgres (PGlite), including a stand-in founder `notifications` table. They do not call a live Supabase project, a live school notification worker, or an external product, sales, or curriculum tracker.

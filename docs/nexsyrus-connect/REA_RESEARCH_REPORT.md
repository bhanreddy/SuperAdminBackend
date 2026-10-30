# REA-assisted Slack research

Research date: 30 October 2026. No Slack private APIs, credentials, proprietary sources or branding were extracted.

## Tool provenance and access limitations

Official sources read: [REA repository](https://github.com/morluto/rea), [installation](https://github.com/morluto/rea/blob/main/docs/installation.md), [browser observation](https://github.com/morluto/rea/blob/main/docs/browser-observation.md), [scenario contract](https://github.com/morluto/rea/blob/main/docs/browser-scenario-contract.md) and the installed reverse-engineer-anything skill.

Host Node is v24.14.1. The currently fetched upstream package metadata declares version 6.8.0 with engines `^22.23.4 || ^24.22.1 || >=26.12.1`; this host does NOT satisfy current upstream requirements. That metadata is not proof of the already-connected server's package version or runtime. Do not upgrade Node or agent configuration silently.

REA MCP tools were already advertised. An actual list_browser_targets call to loopback port 9222 returned provider_unavailable / endpoint_unreachable. Browser inventory exposed no authenticated Slack tab. A subsequent REA capture_browser_scenario successfully launched installed Chrome using an owned temporary profile and visited the public Slack thread help article. Evidence `ev_849822b96439117585b3e256fc7ce5e5e83a0b83301bc56dfc5366dc1396f44f` is retained in `evidence/rea-slack-thread-guide.json`. Requested accessibility and URL artifacts were complete, browser Chromium 156.0.8078.79, viewport 1280×720, cleanup terminated-owned-process. This proves REA browser capture is operational, NOT authenticated Slack investigation or compliance of this host with latest upstream engines.

No installation/configuration changes were necessary. The exported public-guide evidence is an analyst-selected summary retaining provenance, actions and original artifact SHA-256/byte fingerprints; the third-party article text is omitted. If future repair is needed: use official `rea-agents`, first `setup --client codex --dry-run --json`, review exact paths/backups/skill replacements and obtain approval before `setup --client codex --yes`; restart/reconnect and verify actual tools. Installation needs a supported Node runtime first. No Hopper or unrelated analysis engine is needed for this task.

## Evidence levels

- Observed: public documentation rendering captured by REA (thread guide only).
- Documented: official Slack help descriptions retrieved through web research. These describe intended behavior, not behavior observed in a logged-in workspace.
- Proposed: independent NexSyrus implementation decisions.
- Unknown: Slack loading/empty/error UI, backend contracts, realtime protocols, device behavior or permissions not established by an available source. Never infer private backend implementation from help pages.

## Feature investigation and selection

### 1. Channels

Documented workflow: desktop sidebar add control opens channel creation with name and public/private choice; mobile Home add control separates name/type steps. Components: sidebar list, create form, conversation header. States: type/name selection documented; loading/empty/error states unobserved. Permissions: workspace policies may restrict creation. Backend/realtime: unobserved. Edge cases: name collision, private discovery, archived channels and membership revocation need local explicit handling. NexSyrus needs founder/admin creation, purpose, description, department/project categorization, membership and archives. [Source](https://slack.com/help/articles/201402297-Create-a-channel). Confidence: documented.

### 2. Send/edit messages

Documented workflow: composer sends into a channel/DM; message actions permit own-message editing/deletion when workspace policy allows. Mobile uses message context actions. Components: composer, message row, action menu. Loading/empty/failure/retry UI and backend/realtime: unobserved. Permissions: author and workspace policy. Edge cases: lost acknowledgement, retries, deleted parents, concurrent edits. NexSyrus needs plain text, visible failure/retry, server-confirmed IDs, author checks and auditable tombstones. [Sending reference](https://slack.com/help/articles/201457107-Send-and-read-messages), [edit/delete](https://slack.com/help/articles/202395258-Edit-or-delete-messages). Confidence: documented.

### 3. Threads

REA observed public guide showing desktop/mobile tabs, reply-in-thread instructions and thread notification guidance. Documented workflow: open parent, reply in a separate thread view; desktop supports alongside the conversation. Components: parent row, reply count/action, thread composer/panel. Loading/empty/error states and actual app realtime/backend: unobserved. Permissions: access to parent conversation. Edge cases: removed parent, replies to replies, lost context, membership loss. NexSyrus needs one-level threads, same-conversation parent constraint, parent navigation and author/participant reply notifications. Reply rebroadcast and separate windows excluded. [Source](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions-). Confidence: guide rendering observed; app behavior documented.

### 4. Emoji reactions

Documented desktop hover actions and mobile long-press actions open reaction choices; selecting own reaction again removes it. Components: action menu, emoji picker, reaction chip. Highlighted ownership documented; loading/empty/error states and backend/realtime unobserved. Permissions: conversation access. Edge cases: duplicate taps, deleted messages and member removal. NexSyrus needs a small Unicode allowlist and idempotent PUT/DELETE operations. [Source](https://slack.com/help/articles/202931348-Use-emoji-and-reactions). Confidence: documented.

### 5. Mentions

Documented workflow: type @ and select a person; mentioned message appears in notification activity and highlights in context. Components: autocomplete, highlighted text, activity entry. Loading/no-matches/error states and backend/realtime unobserved. Permissions: visibility and membership must be checked independently. Edge cases: same names, removed users, editing/removing mentions and duplicate notifications. NexSyrus needs member-only employee choices and stable employee IDs, never organization-wide mention broadcast. [Source](https://slack.com/help/articles/205240127-Use-mentions-in-Slack), [notification guide](https://slack.com/help/articles/360025446073-Guide-to-Slack-notifications). Confidence: documented.

### 6. Direct messages

Documented desktop DMs navigation/search/compose and mobile DMs tab/compose. Components: employee selector, DM list, shared composer/history. Loading/empty/error and backend/realtime unobserved. Permissions: participants only. Edge cases: simultaneous A→B/B→A creation, self-DMs, disabled accounts. NexSyrus needs only one-to-one internal employees, canonical pair uniqueness and no founder content bypass. Group/external DMs excluded. [Source](https://slack.com/help/articles/212281468-Understand-direct-messages). Confidence: documented.

### 7. Search

Documented global search with filters including author, conversation, dates, threads, saved and pinned. Components: search field, result rows, filter controls. Loading/no-results/error and backend/realtime unobserved. Permissions: never widen result scope beyond readable conversations. Edge cases: SQL wildcards, removed membership, tombstones and thread results. NexSyrus needs messages/channels/employees/mentions with bounded author/channel/date filters and navigation. [Source](https://slack.com/help/articles/202528808-Search-in-Slack). Confidence: documented.

### 8. Unreads

Documented unread view and conversation navigation; activity differentiates DMs/mentions/thread notifications. Components: sidebar badges, activity list, mark-read action. Exact counting/backend/realtime and loading/empty/error unobserved. Edge cases: own posts, clock collisions, background tabs, thread reads, reconnection. NexSyrus uses committed conversation sequence watermarks and marks only displayed messages read. [Source](https://slack.com/help/articles/226410907-View-all-your-unread-messages). Confidence: documented.

### 9. Pins

Documented message menu pins shared within the conversation and pins navigation. Components: context action and pinned list. Loading/empty/error, detailed permissions and backend/realtime unobserved. Edge cases: deleted message, archived channel, membership loss. NexSyrus needs authorized channel managers pinning; saves remain personal. [Source](https://slack.com/help/articles/360002063088-Understand-your-actions-in-Slack). Confidence: documented.

### 10. Attachments

Documented composer can include files; conversation access controls visibility. Components: attachment picker and message file entry. Upload progress/failure/empty states, scanning and backend/realtime unobserved. Edge cases: oversized files, spoofed MIME, active documents, expired URLs and member revocation. NexSyrus needs private server-authorized downloads with signature/size validation; no public bucket or arbitrary URL fetch. [Source](https://slack.com/help/articles/218080037-Getting-started-for-new-Slack-users). Confidence: documented, exact upload behavior unknown.

### 11. Presence/status

Official help describes availability and user status separately. Profile/status controls are documented, but live presence transitions, mobile UI, loading/error states and backend/realtime were not observed. Permissions: reveal only within internal company membership. Edge cases: multiple devices, stale connections, foreground/background. NexSyrus initially needs explicit away/busy state and expiring activity, not an inferred guarantee someone is reading. [Source](https://slack.com/help/articles/201864558-Set-your-Slack-status-and-availability). Confidence: documentation reference; runtime unknown.

### 12. Notification preferences

Documented profile preferences and conversation-specific all-posts/mentions/mute options, with mobile settings navigation. Components: activity badge, notification settings and conversation preference control. Loading/empty/error and delivery/backend/realtime unobserved. Edge cases: overlapping DM/mention/thread events and multiple devices. NexSyrus needs a single durable notification ID shared across delivery channels and preferences checked before enqueueing push. [Global source](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications), [conversation source](https://slack.com/help/articles/360056534254-Manage-notifications-for-specific-channels-and-direct-messages). Confidence: documented.

## Conclusion and limits

The useful subset is company channels, reliable text, contextual threads, restrained mentions, private DMs and authorized retrieval. NexSyrus business requirements supply the acceptance specification. Public help corroborates workflow choices but cannot establish Slack's APIs, persistence, realtime or error behavior. No authenticated desktop/mobile app interactions, posting/editing, private data capture or native-device tests were performed. Those research gaps do not justify inventing evidence or copying proprietary implementation.

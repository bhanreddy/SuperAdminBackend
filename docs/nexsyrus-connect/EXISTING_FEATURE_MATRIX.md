# Existing features and reuse decisions

- Employee authentication: reuse authenticateUser, internal_user_sessions and token refresh; additionally bind Connect to active internal_users and organization membership. Never accept a school user as an employee.
- Employee directory: reuse internal_users. Expose only employee ID/name/job role within the company, and only conversation members in mention autocomplete. Do not expose phone, email, password hashes or HR records.
- Company context: add collaboration_organizations and collaboration_organization_members; Books companies and schools have different purposes.
- Channel messaging: new normalized internal entities; support messenger remains untouched because it serves external school and website participants.
- Channels, membership, archives, descriptions: new, founder/admin management; even administrators require membership to read private messages.
- DMs: new two-member conversations with canonical unique pair and no administrative content bypass.
- Threads/reactions/mentions: new records linked to the same conversation and validated parent; existing school support has no equivalent internal API.
- Notification centre/read position: new employee-only records with one notification per recipient/message and monotonic read position. Existing console screen does not supply this model.
- FCM: missing sending infrastructure in this checkout. Build a deduplicated outbox/adapter boundary; actual push integration remains blocked until an employee FCM service is available.
- Realtime: reuse Supabase dependency and deployment, add least-privilege event subscription. Durable REST history remains authoritative after reconnect.
- File storage: reuse Supabase server client; add a private Connect bucket and authorization checks. Existing public poster storage is unsuitable.
- Saved/pinned messages/presence: no internal equivalent; add only after P0 automated checks pass.
- Task conversion: reuse school_onboarding_checklists with existing school access and checklist.delegate checks, explicit assignee/school and a source message reference. Fixed sprint definitions remain intact. Generic company tasks and cross-product record links need an existing compatible system and permission contract before expansion.
- Shell/UI: reuse Expo Router, DashboardLayout, ThemeContext, Lucide icons, native Pressable/TextInput/FlatList and superAdminClient.
- Audit: reuse audit_logs schema, with transactional inserts for Connect sensitive changes.
- Tests: reuse node:test, Supertest, PGlite and React test renderer. Add real cross-user SQL/RLS and HTTP tests.

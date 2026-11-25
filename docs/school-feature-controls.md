# Per-school feature controls

Open Schools → a school → Feature Flags. The school-wide catalog is read from the SchoolIMS `public.features` catalog, including Smart Diary, curriculum, planning, LMS, examinations and other registered modules. Student portal cards retain the student portal switches, including existing overrides. Home and Dashboard remain core navigation.

`GET /api/super-admin/schools/:schoolId/features` returns the configuration catalog. `PUT` on that URL sets every toggleable feature using `{ "enabled": false }` (or true). `PUT /:featureKey` changes one setting; `DELETE /:featureKey` removes its override and returns it to disabled. Bulk operations affect the entire catalog even when the UI search is filtering rows.

Founder/Superadmin writes require `configs.modify` and school scope; Approvers remain read-only. Each write locks the school row and stores its changes and activity log in one transaction. Module writes also synchronize linked student flags for older clients. Individual student switches remain separate controls. These settings do not delete school data, grant RBAC permissions, or release globally unavailable functionality.

Examples:

- Disable **Smart Diary** under School-wide Features for School A: staff diary publishing and student/parent diary reads are blocked; School B is unchanged.
- Disable **Curriculum** for School B: published curriculum, question bank, curriculum v1/v2 and curriculum sync are blocked; School A retains its settings.

Deploy the changed Superadmin backend/frontend and SchoolIMS backend/frontend together. They must address the same school database. This change uses the existing `features`, `school_feature_overrides`, `school_feature_flags` and `activity_logs` tables; the SchoolIMS universal feature-access migrations must already be installed. On 16 November 2026, the owner-requested disable-all operation was applied to all 10 schools in the active configured cluster: 22 modules and 21 portal features per school. Both SQL verification and an independent REST read reported zero enabled optional flags. Each school has a `DISABLE_ALL` audit record containing its previous settings. No deployment or schema change was performed.

SchoolIMS checks school overrides on matching API requests for every role. Optional modules require an explicit, unexpired school grant; absent or expired grants deny access before any user-specific grant. Defaults are disabled in both server and client registries. A parent school module must be enabled before its portal switches can take effect. Client navigation, dashboard widgets and shortcuts refresh with `/me/features` on mount/foreground; an already-open offline client can retain cached visibility, but server requests are denied immediately after the setting is saved. Platform curriculum authoring remains outside school runtime restrictions.

The feature library uses the existing paper/navy theme, responsive virtualized cards, category and status filters, accessible toggles, an in-app bulk confirmation, skeleton loading, and explicit save/error feedback. Both bulk directions require confirmation.

Verification:

- `node --test test/schoolFeatures.test.cjs` (isolated PGlite; API test binds localhost).
- `node --experimental-test-module-mocks --test test/schoolFeatureRuntime.test.cjs` (uses sibling SchoolIMS source and mocked DB; no live database).
- `node tests/school-features-preview.cjs --capture` in SuperAdminFrontend (real React Native Web screen with isolated API/auth fixtures; desktop, tablet, phone, dark mode, toggle/reset, bulk/cancel, search/empty, failed save, Approver access and load retry).
- `npm run typecheck` in SuperAdminFrontend.

The general SchoolIMS frontend typecheck currently reports unrelated missing `react-test-renderer` declarations and implicit-any errors in `src/features/fluency/tests/screen.test.tsx`.

Operational commands (never run during normal startup):

- `node scripts/disable-all-school-features.cjs --apply` explicitly disables existing school settings in an audited transaction. Re-running deliberately revokes any grants made since the previous run.
- `node scripts/verify-feature-disable.cjs` independently checks enabled counts and the latest school audit records through the configured Supabase REST API. It never prints credentials.
- `node scripts/enable-all-except-diary.cjs --apply` enables every registered optional module and portal feature for existing schools except `diary` and `topbar.diary`. It clears module grant expiry, restores registered portal flags for existing roles, and retains each school's previous settings in an `ENABLE_ALL_EXCEPT_DIARY` audit record within the same transaction.
- `node scripts/verify-all-except-diary.cjs` independently verifies the exception policy and school audit coverage through Supabase REST.

On 17 November 2026, the owner replaced the earlier disable-all instruction with enable-all-except-Smart-Diary. This was applied to all 10 existing schools: 21 optional modules and 20 portal features enabled per school; `diary` and `topbar.diary` disabled. Core Dashboard/Home remain available. The operation does not change defaults for future schools or deploy application code.

Later on 17 November 2026, the owner requested all features including Smart Diary. `node scripts/enable-all-school-features.cjs --apply` applied that policy to all 10 existing schools: 22 optional modules and 21 portal features enabled per school, including `diary` and `topbar.diary`. Each school has an `ENABLE_ALL` audit snapshot of its previous settings. `node scripts/verify-all-except-diary.cjs --include-diary` checks this latest policy independently. Future-school defaults and application deployments are unchanged.

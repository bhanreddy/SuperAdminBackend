# School onboarding checklist contract

Canonical API prefix: `/api/super-admin/checklist`.
The frontend's `src/services/checklistService.ts` owns the calls and types;
`superAdminApi` re-exports those methods for the checklist screen.

| Operation | HTTP route | Request | Response data |
| --- | --- | --- | --- |
| Fetch | `GET /api/super-admin/checklist/:schoolId` | None | `{ schoolId, items, progress }` |
| Initialize | `POST /api/super-admin/checklist/:schoolId/init` | None | `{ schoolId, items, progress }` |
| Update | `PATCH /api/super-admin/checklist/:schoolId/items/:itemId` | `{ status, blocker_reason?, notes? }` | Updated item |

Successful responses are `{ success: true, data: ... }`. `progress` has
`total`, `completed`, and integer `percentage`. An uninitialized school returns
an empty list; GET does not seed data. Initialization inserts missing defaults
without duplicating tasks or overwriting existing status/notes.

Valid statuses: `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `BLOCKED`,
`NOT_APPLICABLE`. BLOCKED requires a nonblank reason. Omit notes to preserve them;
send `""` to clear them. Completion records the actor and timestamp; reopening
clears completion metadata. Nonblocked states clear the blocker reason.

All routes require authentication and school access. Fetch requires
`checklist.read`; initialization and updates require `checklist.update`.
Item lookup includes the school ID, preventing another school's task ID from
being used to change its tasks. Invalid school IDs/statuses return 400; missing
items return 404; authorization failures return 401/403.

Legacy compatibility:

- `GET /api/super-admin/schools/:schoolId/checklist`
- `POST /api/super-admin/schools/:schoolId/checklist/init`
- `PATCH /api/super-admin/schools/:schoolId/checklist/:taskKey`

The legacy PATCH uses the task key, while the canonical PATCH uses the item ID.
Both mounts use the same handlers and access checks. Keep the existing `/schools`
detail router ahead of the compatibility mount.

## Regression verification

Install dependencies in both sibling repositories, then run:

```sh
# In SuperAdminFrontend
npm test
npm run test:checklist
npx tsc --noEmit

# Alternatively, in SuperAdminBackend
npm run test:checklist
```

The contract suite imports the real frontend service and mounts the real backend
route index/checklist router on an ephemeral local HTTP server. It exercises
fetch, repeat initialization, all statuses, notes clearing/preservation,
completion metadata, aliases, permission checks, and school isolation. React
screen tests exercise initialize/edit/save/reload and retry and stale-response
behavior. Changing the frontend URL/method or backend mount/route breaks these
round trips.

Database/session infrastructure and unrelated routes use isolated fixtures; the
real permission/school-scope middleware runs. Tests require no credentials and do
not write to a live database. This suite does not substitute for database
migration verification in a configured staging environment. The existing RBAC
migration must provide `school_onboarding_checklists` with unique
`(school_id, task_key)` before deployment.

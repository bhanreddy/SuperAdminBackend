# NexSyrus Connect deployment — 30 October 2026

This release was explicitly authorized by the user's subsequent request to push both repositories and deploy them to their existing platforms. This report supersedes the earlier implementation-phase statements that deployment/migrations had not yet run.

## Source release

- Backend: `fc6083e165cdebc340694c7defc6b5db175a8580`, pushed to main at https://github.com/bhanreddy/SuperAdminBackend.
- Frontend: `39c94001529e8afa7a16d4ce1e62847906659519`, pushed to main at https://github.com/bhanreddy/superAdminFrontend.
- Scope: Connect implementation, narrow app integration and its reports. Existing uncommitted fingerprint and Books changes were excluded and preserved locally.
- Builds/tests used isolated Git worktrees based on the original remote main branches. Runtime source hashes were compared against the reviewed workspace before publishing. No force push was used.

## Backend / Catalyst

- Existing project: NexsyrusSuperAdmin; existing AppSail: superadmin-backend, Node 22, existing memory/startup/environment configuration preserved.
- Deployment ID: `78544000000073002`; Catalyst reported success at 17:28 IST.
- Target: https://superadmin-backend-50046840729.development.catalystappsail.in.
- This is the existing Catalyst Development environment already used by the live API proxy at https://superadminapi.nexsyrus.com. The separate Catalyst Production environment was not promoted or altered. No unrelated project services were deployed.
- Direct `/health`: HTTP 200, service superadmin-backend.
- Direct and public-proxy `/api/super-admin/connect/bootstrap`: HTTP 401 with the required-Bearer-token response, confirming the deployed route rejects unauthenticated access.
- Existing environment values were retained; no signing key or FCM credential was added.

## Database and storage

- Applied 31_nexsyrus_connect.sql and 32_connect_extensions.sql through the explicit journaled runner against the existing control-plane database.
- Verified two applied migrations; 18 domain tables with RLS plus the deployment journal; both restricted roles have NOLOGIN and NOBYPASSRLS.
- Verified the authenticated school role cannot SELECT collaboration_messages and the realtime role cannot SELECT internal_users.
- Verified private nexsyrus-connect bucket, restrictive storage policy and collaboration_events in the existing supabase_realtime publication.
- Existing active internal employees were enrolled according to the reviewed migration; no messages or channels were created for smoke tests. No destructive database operations were run.

## Frontend / Cloudflare

- Existing Worker: superadminfrontend; existing GitHub-connected main build pipeline and public build variables retained.
- Build ID: `4fdd625d-3075-48e6-be78-51ee6c0a76ff`; outcome success.
- Deployment ID: `b75649d7-4a44-4cd7-9109-d27934fdfddf`.
- Version ID: `d58da5b6-8bbe-4225-9c8b-09a81a6fe028`, deployed at 100% traffic.
- Build completed at 17:33:22 IST.
- Live page: https://founderconsole.nexsyrus.com/connect, HTTP 200.
- Verified the deployed entry bundle contains both NexSyrus Connect and its API prefix; the bundle was served successfully. Login/employee workflows still require the user's employee session.

## Release validation

- Isolated backend: 27/27 Connect tests passed.
- Isolated frontend: 55/55 tests passed. This count excludes the unrelated local fingerprint/Books additions included in the earlier 72-test workspace run.
- Isolated TypeScript, Expo web export and Wrangler deployment dry run passed.
- Earlier broader backend baseline failures remain documented in TEST_REPORT.md; unrelated authorization behavior was not modified by this release.
- Commit scans found no private-key blocks, JWT credential values or non-fixture credential-bearing database URLs in either release commit. Secrets are excluded from Git and this report.

## Remaining configuration and acceptance gaps

- The existing Supabase JWT signing-key setting is unconfigured, so the realtime-session endpoint fails closed. Publication and RLS are installed, but live realtime delivery is not claimed. No production secret was silently introduced.
- Employee FCM registration/sending is not integrated. In-app notification records are implemented; push delivery is not claimed.
- No authenticated end-to-end employee smoke test, physical-device test, malware-scanning certification or new retention/legal-hold approval was performed. See SECURITY_REVIEW.md for the remaining release limitations.

Only deployment records were updated after the runtime-source commits above; those documentation updates do not change the deployed binaries.

# Phase 8 backend deployment — 31 October 2026

Deployed backend commit `1cffbe8775fb981356c5a5f09e609c900ff0c962` to the existing Catalyst AppSail after the user explicitly requested the deployment.

- Project: NexsyrusSuperAdmin (`78544000000020001`), India data center.
- Service: `superadmin-backend` (`78544000000022001`).
- Environment: Catalyst Development, already used by the live public API proxy. The separate Catalyst Production environment was not promoted.
- Deployment ID: `78544000000066005`. Catalyst status: success, 31 October 2026 at 09:15 IST.
- Direct URL: https://superadmin-backend-50046840729.development.catalystappsail.in
- Public proxy: https://superadminapi.nexsyrus.com
- Runtime remains Node 22, 512 MB, `npm start`, existing Catalyst authentication-gate setting unchanged. Environment variables were compared before/after and match. Application authentication remains enabled in Express.
- `.catalyst-build` source/templates (195 files) and package files matched the pushed backend. Linux x64 production dependencies were installed from the lockfile. Ignored deployment secrets were not committed.

## Schema check

Read-only database checks confirmed `cash_flow_activity` exists on Books accounts and journals in both active company schemas (`public` and `books_nexmaxx`). No manual database migration was needed or run. The existing application's startup workers/schema initializers retain their normal behavior.

## Verification

Both direct AppSail and public-proxy origins passed:

- `GET /health`: 200 with status ok.
- Unauthenticated `GET /api/super-admin/auth/me`: 401.
- Unauthenticated `GET /api/super-admin/connect/bootstrap`: 401.
- Unauthenticated `GET /api/super-admin/books/reports`: 401.
- Login OPTIONS preflight from `https://founderconsole.nexsyrus.com`: 200 with the correct origin, POST method, and content-type/authorization headers.

[Deployment log](evidence/catalyst-deploy.log) · [Smoke results](evidence/catalyst-smoke.json)

These checks establish deployment, liveness, unauthenticated protection and browser preflight. They do not certify authenticated workflows, native-device behavior, realtime delivery or complete tenant isolation in the live environment. The earlier QA limitations and missing cross-project tests remain applicable.

## Subsequent GitHub update

Frontend command-centre login changes were pushed separately as `9b17ac048b8dc7218f9345e0e75e3fbe004547f5`. TypeScript, lint, all 110 frontend tests and the production web export passed. The recovery-dispatch UI is simulated and sends no backend request. No manual frontend deployment was initiated by this backend deployment command; a connected hosting pipeline may react to the GitHub push.

This record is a documentation-only commit after the deployed runtime commit.

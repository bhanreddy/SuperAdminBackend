# Zoho Catalyst AppSail

The dedicated Development project is `NexsyrusSuperAdmin` (project ID `78544000000020001`) in Zoho's India data center. The service is `superadmin-backend`, using Node.js 22, 512 MB memory, and `npm start`.

The existing application handles login and role permissions. AppSail's separate Catalyst Authentication gate is disabled.

Development API origin: `https://superadmin-backend-50046840729.development.catalystappsail.in`.

## Prepare and deploy

Use Zoho's `zcatalyst-cli`, rather than the unrelated `catalyst-cli` package already installed on this computer.

```sh
npm exec --package=zcatalyst-cli@1.28.0 -- catalyst login --dc in
npm run catalyst:prepare
npm exec --package=zcatalyst-cli@1.28.0 -- catalyst deploy --only appsail --project 78544000000020001 --dc in
```

The prepare command copies `src`, school package `templates`, package files, and production dependencies to `.catalyst-build`. Dependencies target Linux x64 with glibc so sharp's native image processing packages match AppSail even when preparing on macOS. It reads local `.env` and writes the environment values to ignored `app-config.json`, with file permissions restricted to the owner. Those values are sent to AppSail configuration, outside the application ZIP. Never commit this file. To use a separate environment file, set `CATALYST_ENV_FILE`.

AppSail supplies `X_ZOHO_CATALYST_LISTEN_PORT`. The server binds to `0.0.0.0` and gives that variable precedence over the local `PORT`.

After the first deployment, set `PUBLIC_BASE_URL` and `CLUSTER_BACKEND_URL` in the backend environment file to the returned HTTPS service origin. `CLUSTER_ID` identifies the deployment's cluster (default `cluster_a`). The public cluster response overrides the school and medical backend URLs only for that cluster, avoiding redirects to legacy services while keeping shared database registry rows unchanged. Other clusters retain their registered URLs. Set frontend `EXPO_PUBLIC_SUPERADMIN_API_URL` and `EXPO_PUBLIC_SUPERADMIN_API_URL_WEB` to that origin, without an API path suffix. Rebuild the frontend to apply Expo environment values.

## Verify

Check `GET /health` for `status: ok`; verify protected endpoints reject requests without a token. Then sign in through the frontend and test a database-backed endpoint. Health is a liveness check; it does not prove database connectivity.

## Browser CORS

Catalyst intercepts browser `OPTIONS` preflight requests before Express and adds CORS headers to actual responses. Its project CORS domain list must include each frontend host and port. Express CORS runs only outside AppSail (when `X_ZOHO_CATALYST_LISTEN_PORT` is absent), preventing duplicate `Access-Control-Allow-Origin` headers in deployed responses. Development now authorizes `localhost:8081` and `founderconsole.nexsyrus.com` with CORS enabled and iframe access disabled. The deployed frontend uses `https://superadminapi.nexsyrus.com`, which forwards to the AppSail service. Enter domains without the URL scheme in Catalyst (for example, `localhost:8081`, not `http://localhost:8081`). Configure each actual deployed frontend domain before publishing it.

Verify an `OPTIONS /api/super-admin/auth/login` request with `Origin: http://localhost:8081`, `Access-Control-Request-Method: POST`, and `Access-Control-Request-Headers: content-type,authorization`. Its response must include the matching allowed origin, allowed methods, and allowed headers. A successful health GET alone does not verify browser login connectivity.

## Production considerations

Production deployment and billing are separate from the Development setup. Configure the intended frontend web origins in `ALLOWED_ORIGINS` before production. The existing CRM and payroll workers run on process timers; reliable scheduling through scale-to-zero and restarts needs a separate scheduled-job implementation. Database schema migrations are not part of this deployment workflow.

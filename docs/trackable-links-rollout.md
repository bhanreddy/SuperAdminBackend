# Trackable brochure and demo links

This is a local implementation. It is not production-ready until the checks below are done on the real host.

## What the code showed before this change

- SuperAdmin CRM lives on `CRM_DATABASE_URL` and is migrated in manifest order, not filename order. Migration 17 is in the working tree. That is not proof it has been applied in production.
- `POST /api/public/enquiries` already calls `ingest_website_enquiry` on that CRM database.
- The SchoolIMS marketing contact route inserted into a Supabase `enquiries` table with the anon/publishable client. Nothing in the repo proves that table is the dedicated CRM database. The new route therefore does not write both. Set `CRM_PUBLIC_ENQUIRY_URL` to cut over. Leave it unset and the old Supabase insert remains the only write.
- `NexsyrusWebsite/apps/SchoolIMS/wrangler.jsonc` has no custom domain and no `/d` route of its own. The new handler is `src/app/d/[code]/route.ts` on that Next app. Printed URLs use `TRACKING_PUBLIC_ORIGIN`, not the request host and not `PUBLIC_BASE_URL`.
- No App Link or Universal Link association exists. Store redirects log a link open only. Conversion coverage for those destinations is `unavailable`, not zero.
- Student login QR, visitor passes, and school analytics were not changed.

## Migration order

`09_dedicated_crm_baseline` → `08_website_chat` → `07_top_level_crm` → `15_sales_crm_foundation` → `16_school_prospect_import` → `17_founder_sales_command` → `18_trackable_links`.

Apply with `npm run migrate:crm` in `NexsyrusSuperAdmin/SuperAdminBackend`. Do not edit migrations 09–17. Do not drop issued codes to roll back. Old enquiries stay unattributed. There is no backfill.

Verified onboarded targets must use `(cluster_id, school_id)`. Dev and QA fixtures in this feature use `school_id=1` only. Prospects leave both fields null.

## Flags and environment

All default off:

- `CRM_FEATURE_TRACK_WRITE`
- `CRM_FEATURE_TRACK_RESOLVE`
- `CRM_FEATURE_TRACK_ATTRIBUTION`
- `CRM_FEATURE_TRACK_REPORTS`

Required before a flag is turned on:

- `TRACKING_PUBLIC_ORIGIN` — `https://` origin, no path. Startup exits if a tracking flag is on and this is missing or not https.
- `TRACKING_INGRESS_SECRET` — at least 16 characters. Shared by the marketing server and `POST /api/internal/track/resolve`.
- `TRACKING_OWNED_SITE_ORIGINS` — comma-separated origins that may receive an attribution cookie.
- `TRACKING_ALLOWED_DESTINATION_HOSTS` — exact hosts for brochure files and other approved pages. Play Store and App Store URLs are separate canonical patterns.
- `TRACKING_RESOLVE_URL` — on the marketing app, the server-side URL of the internal resolve endpoint.
- `CRM_PUBLIC_ENQUIRY_URL` — full URL of `POST /api/public/enquiries`.
- `CRM_ENQUIRY_INTAKE_SECRET` — optional. When set, attributed intake must send `x-crm-intake-secret`. Untracked public posts still work without it.
- `TRACKING_BROWSER_KEY_SECRET` — HMAC for a consented browser id. Distinct browsers are not people.

`ALLOWED_ORIGINS=*` is still the backend default. This feature’s cookie is set on the marketing host, not as a credentialed admin cookie. Tighten `ALLOWED_ORIGINS` before any future cookie-authenticated admin mutation.

## Rollout

1. Apply migration 18. Confirm `crm_schema_migrations` contains `18_trackable_links`.
2. Set the origin, secrets, and allowlists. Confirm startup accepts them.
3. Enable `CRM_FEATURE_TRACK_WRITE` in staging. Create a link and download the QR.
4. Point DNS and TLS for `TRACKING_PUBLIC_ORIGIN` at the SchoolIMS Next app. Confirm Cloudflare does not cache `GET /d/*` (`Cache-Control: no-store, private` is set; a CDN rule must not override it).
5. Enable `CRM_FEATURE_TRACK_RESOLVE`. Scan one code on Android and iOS at brochure size. Disabled and expired codes must show the plain unavailable page and must not redirect.
6. Set `CRM_PUBLIC_ENQUIRY_URL` and enable `CRM_FEATURE_TRACK_ATTRIBUTION`. Submit the contact form with and without a cookie. Confirm a single CRM row, not a second Supabase insert.
7. Enable `CRM_FEATURE_TRACK_REPORTS` and `CRM_FEATURE_SALES_COMMAND_READ`. Compare a campaign card with its drilldown.

Rollback is the reverse: turn the flags off and unset `CRM_PUBLIC_ENQUIRY_URL` if the form must return to Supabase. Printed codes stay reserved. History rows are not deleted. `crm_track_purge_ephemeral()` deletes only expired browser windows, rate buckets, and old context tokens.

## Metrics

Rule version 1. Opens use event time. Enquiry filters use the existing lead scope, so a founder who does not own the lead does not see it. First and latest touch are two views of the same enquiries and must not be added together. `DEMO_REQUESTED` is the form. `DEMO_BOOKED` happens only when staff schedule a demo. A later reopen does not delete a won or lost fact. Consented browser keys are “observed distinct browsers.” Missing cookies are not counted as people. Preview, bot, and repeat opens are stored and are not qualified.

## Checks run here

- `node --test --test-force-exit --test-concurrency=1 test/crm/*.test.js` — 33 passed, including the previous CRM tests.
- `npm run test:sales-command` in SuperAdminFrontend — passed.
- `tsc --noEmit` in SuperAdminFrontend — passed.

Not done: a physical scanner check, DNS/TLS/Cloudflare verification, `EXPLAIN (ANALYZE, BUFFERS)` on a production-sized CRM, or a redirect latency percentile on the deployed host. Do not print brochures from local tests alone.

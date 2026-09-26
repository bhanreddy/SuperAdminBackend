# School prospect import

This note separates what was already in the working tree, what this change decided, and what is still an operational constraint. No live database was inspected.

## Verified baseline

The implementation extends the uncommitted SuperAdmin CRM foundation. It does not reset that work and it does not add a second CRM.

- CRM data stays on `CRM_DATABASE_URL`. The School database remains authentication, founder identity, and the cluster registry.
- Sales stage, sales outcome, account lifecycle, and school onboarding status stay separate.
- Import does not create schools, users, credentials, capacity reservations, or `ACTIVE` accounts.
- A contactless school is a `crm_accounts` row plus `crm_school_profiles`. It does not invent an email, phone, or person, and it does not relax the enquiry email-or-phone constraint.
- Preview writes only import staging tables.

## Decisions

- Migration `16_school_prospect_import` is appended after `15`. The runner takes a session advisory lock, stores a SHA-256 checksum, and applies each new file in a transaction with a statement timeout. `CREATE INDEX CONCURRENTLY` is intentionally not used; these tables are empty at first install.
- Untrusted XLSX is read by a bounded ZIP/deflate and worksheet XML parser. SheetJS `xlsx@0.18.5` remains installed for the existing student importer and is not used for prospect uploads because that community build is affected by CVE-2023-30533 and CVE-2024-22363.
- Phone parsing is a versioned calling-code subset for IN, US, CA, GB, AE, SG, and AU. It is not a full libphonenumber metadata set. Ambiguous Indian landlines and numbers without a country are rejected. Extensions stay separate. Comparison uses E.164, never the last ten digits.
- Email comparison lowercases the domain only. Dots and plus tags stay. There is no network lookup.
- UDISE is an 11-digit string. A numeric spreadsheet cell is rejected rather than repaired. The UDISE index is not unique until a collision report is clear.
- One active primary contact is enforced by a unique index only when the migration finds no existing violations. New writes still lock the account and clear other primaries in the same transaction.
- Duplicate rule version 1: validated UDISE, or organization channel plus strict name plus location key, can be exact. A shared phone or email alone is possible, including when UDISE values differ. Loose similarity is token Jaccard at 0.85 with at least 3 shared tokens and equal campus/direction/number tokens. It cannot by itself authorize a merge.
- A founder's out-of-scope match is returned as `RESTRICTED_MATCH` without a name, phone, email, or count, and cannot be imported as new.
- Customer coverage is complete only when every active cluster has a successful directory refresh inside the freshness window. A failed cluster keeps its last rows and blocks confirmed-new execution.
- Import execution defaults off (`CRM_FEATURE_IMPORT_EXECUTE=false`). Reads and preview default on. Changing a flag requires a process restart.
- The worker is a PostgreSQL lease (`FOR UPDATE SKIP LOCKED`, heartbeat, fencing token). Run one `npm run crm:import-worker` process, or set `CRM_IMPORT_WORKER_ENABLED=true` on a single instance. A timer inside every request-scaled replica is not a reliable queue.
- Mapping changes and cell corrections clear the preview hash. Review decisions bump the batch version and are part of confirmation; they do not discard match evidence, because the review screen has to keep that evidence.
- "Merge" writes the incoming row into one existing account. It does not merge two established accounts or their commercial history.
- Won-sale onboarding that reuses a prospect sets `account_type` from `PROSPECT` to `CUSTOMER` and lifecycle `ONBOARDING`. It still does not set `ACTIVE`.
- Account creation no longer accepts another founder's owner id, a school `ACTIVE` lifecycle, or a founder-supplied `CUSTOMER` type. The response row shape is unchanged.
- CRM audit for this feature is `GET /api/super-admin/crm/audit-logs`, read from the CRM database. The founder `/audit-logs` route still reads the School database and is left in place for platform and finance history.

## Normalization and duplicate table

| Input | Result |
|---|---|
| `Sunrise   Public School` and `sunrise public school` | Same strict key |
| East Campus and West Campus | Different strict keys |
| IN `98765 43210` and `+91 9876543210` | `+919876543210` |
| Same number with extensions 101 and 102 | Same E.164, different extension |
| `office@Example.org` | `office@example.org` |
| `admissions+east@example.org` | Distinct from `admissions@example.org` |
| UDISE `01234567890` | Preserved |
| Numeric or formula UDISE | `ROUNDED_IDENTIFIER` or `FORMULA_IDENTIFIER` |
| Same UDISE, compatible name, different principal | Exact school duplicate, new contact |
| Same phone, different UDISE | Possible duplicate, not an automatic merge |
| Customer check incomplete and no CRM match | Not `NEW`; import-new is not permitted |

Resolution effects: `SKIP` and default `ALREADY_CUSTOMER` do not change business rows. `IMPORT_NEW` creates one prospect per school group. `MERGE` fills empty profile fields and adds contacts. `UPDATE` replaces only `notes`, `board`, and `website` when those keys are in `field_changes`. `ADD_CONTACT` adds contacts and does not change owner, stage, or tenant link.

## Unresolved constraints

- Live CRM migration state, primary-contact violations, and UDISE collisions were not queried. Run the migration preflight on the dedicated CRM database before production.
- The directory refresh uses `schools` and `school_settings` (`school_id`, `key`, `value`). Confirm that shape on each cluster before the first refresh. A failed refresh must stay failed.
- Paginated read p95 and non-upload command latency were not measured on a production-sized host. The local PGlite import of a 3-row file completed in about 1.8s including database startup. That is not a production latency claim.
- Signed-in browser and device performance were not run in this session.
- File bodies expire with the batch retention window. `importRecovery.purgeExpiredFiles` deletes blobs only. Compensation archives an unused imported account only when a SuperAdmin applies the dry-run plan and the account has no tenant link or later commercial activity.

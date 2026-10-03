# School folder import verification

Verified 2026-09-29T06:27:13.784Z.

The local SuperAdmin app now downloads a ZIP automatically after creation. Existing schools can download their imported SSD folder from the school configuration Review step. New schools use the Default File layout with their own identity and cluster connection values.

## Applied to the connected database

- Imported 10 school folders into private object storage; the SSD is no longer a runtime dependency.
- Filled 25 previously empty fields in school records, including contact information and missing app identifiers.
- Created or completed configuration drafts from the SSD constants and app settings.
- Imported the original logo, app icon, and campus image for each school into private configuration assets.
- Preserved populated database fields. The 33 disagreements below require a separate reconciliation decision.

## File verification

All 661 application files were compared by path and SHA-256 after downloading generated ZIPs from storage. Every file matched the SSD bytes. macOS metadata (.DS_Store and ._* files) is excluded. VMS retains its env filename; Chanakya retains the absence of an environment file.

| School ID | Folder | Files verified |
| --- | --- | --- |
| 18 | Bhashayam High School File | 67 |
| 15 | Chaitanya School Nancharla File | 70 |
| 1 | Default File | 65 |
| 17 | GHS File | 65 |
| 14 | Global School File | 65 |
| 19 | NMMS goka File | 65 |
| 13 | Samskruthe File | 70 |
| 12 | Slate School File | 65 |
| 16 | VMS File | 65 |
| 20 | chanakya maddur File | 64 |

A synthetic new-school package also passed using the real Default File source: 65 files, replaced identity and color, no inherited demo contact details, no inherited EAS project ID. No dummy school was added to the database.

## Existing disagreements retained

| Folder | Field | Existing database value | SSD constant value |
| --- | --- | --- | --- |
| Bhashayam High School File | name | Bhashyam Vidhyanikethan School | Bhashyam Vidyanikethan Mohammadabad |
| Bhashayam High School File | address | VenkatReddypally Road , Mahammadabad Mandal , Mahabubnagar , 509337 | Bhashyam Vidyanikethan School,VenkatReddypally Road, Mohammadabad,Mahabubnagar District, Telangana-509337 |
| Bhashayam High School File | android_package | com.nexsyrussims.bvsmahammadabad | com.nexsyrussims.bashyammhbd |
| Bhashayam High School File | ios_bundle_id | com.nexsyrussims.bvsmahammadabad | com.nexsyrussims.bashyammhbd |
| Bhashayam High School File | primary_color | #1A73E8 | #3535A8 |
| Chaitanya School Nancharla File | name | Chaitanya Vidhyanikethan School | Chaitanya Vidyaniketan School Nancharla |
| Chaitanya School Nancharla File | address | Village Nancharla , Mandal Mohmaddabad , Dist Mahabubnagar 509337 | Chaitanya Vidyaniketan School ,Nancharla , Nancharla, Dist Mahabubnagar, Telangana-501111 |
| Chaitanya School Nancharla File | primary_color | #1A73E8 | #002448 |
| Default File | name | Default School | Nexsyrus School IMS |
| Default File | code | DEFAULT | NSIMS |
| Default File | primary_color | #1A73E8 | #1A1A1A |
| GHS File | code | GHSM | 46117 |
| GHS File | address | Geetanjali High School narayanapet road , Maddur , Narayanapet , Telangana 509411 | Narayanapet Road, Maddur, Narayanapet District, Telangana - 509411 |
| GHS File | primary_color | #6A2C91 | #6B2FA0 |
| Global School File | name | The Global School - Ravulapally | The Global School Ravulpally |
| Global School File | code | TGSR | TGSRAVULPALLY |
| Global School File | address | Gurunath Reddy Complex First Floor Ravulapally (V), Kodangal (M) , Vikarabad (D), 509336 | The Global School , Ravulpally , Vikarabad , Telangana , 509336 |
| Global School File | primary_color | #E9D700 | #103070 |
| NMMS goka File | name | New Master Minds School Gokafasalwad | New Master Minds E/M School Gokafasalwad |
| NMMS goka File | code | NMMS | NMS |
| NMMS goka File | address | Maddur Road , Gokafasalwad Village , Doulthabad Mandal , Vikarabad District , 509336 | Maddur Road , Gokafasalwad(V) , Doulthabad(M) , Vikarabad(Dist), Telangana 509336 |
| NMMS goka File | primary_color | #1A73E8 | #5D101D |
| Samskruthe File | name | Samskruthe School | Samskruthe School Nawabpet |
| Samskruthe File | address | Nawabpet (Village & Mandal) Main Road, Vikarabad Dist ,501111 | Samskruthe School ,Nawabpet.,Nawabpet,Dist Vikarabad., Telangana-501111 |
| Samskruthe File | primary_color | #42536C | #113053 |
| Slate School File | name | SLATE SCHOOL KOSGI | Slate School Kosgi |
| Slate School File | address | SLATE SCHOOL  KOSGI. Hakeempet-Polepally Road. Dist Narayanpet., Telangana-509339 | Slate School Kosgi , Hakeempet-Polepally road , Dist Narayanpet. Telangana-509339 |
| Slate School File | primary_color | #1A73E8 | #665990 |
| VMS File | address | Vikas Model School , Village Balampet , Mandal Doulathabad , District Vikarabad , Telangana 509336 | Vikas Model School ,Balampet, Mandal Doulathabad, Dist Vikarabad, Telangana-509336 |
| VMS File | primary_color | #FFD700 | #2563EB |
| chanakya maddur File | name | Chanakya E/M School Maddur | Chanakya E/M School |
| chanakya maddur File | code | CSM | VMS |
| chanakya maddur File | primary_color | #1565C0 | #D42B2B |

The SSD itself contains inconsistent identifiers: Chanakya schoolConfig.ts uses VMS; Global uses TGSRAVULPALLY in schoolConfig.ts and theglobalschoolravulpally in its environment. Exact downloads preserve these differences. The SSD folders also reference Firebase files that are not present; a matching folder download does not certify Android/iOS build readiness.

## Operation and validation

- `node scripts/importSchoolFolders.js` performs a read-only comparison.
- `node scripts/importSchoolFolders.js --apply` imports immutable, checksum-verified source objects and fills missing values. Run with development dependencies installed (TypeScript is used only to parse literals; school source code is never executed).
- The importer matches school ID plus Supabase project/cluster, backs up rows locally before writes, and rechecks missing values under row locks.
- Original database backups and verification hashes are in `.school-library-backups/`, excluded from Git. Re-running imports preserves existing values and asset assignments.
- Source references are pinned in package revisions. A changed source or cluster connection creates a new revision; previous artifacts remain available.
- The default template is shared for newly assigned clusters; exact school folders remain scoped to their original cluster.
- Package tests, frontend TypeScript check, and production web export passed. Browser click-through and native device testing were not performed.
- Changes are active in the local development app. No remote code deployment was performed.

## Public API domain update

All 10 SSD folders now use `https://simsapi.nexsyrus.com/api/v1` in their environment file and EAS build profiles. Chanakya now has a `.env` reconstructed from its own EAS school profile; VMS retains its existing `env` filename. This adds one application file to the original inventory (662 total). Stored source folders and latest package revisions were refreshed; historical revisions remain available.

The cluster and school backend URL fields were updated. New school creation, intake approval, configuration snippets, and new package snapshots use `src/config/schoolPublicApi.js`. `SCHOOL_PUBLIC_API_URL` can override the central default with a complete HTTPS API base URL. Internal cluster addresses do not become public app URLs. Changes to this public setting create a new package revision even when school branding is unchanged.

To update the physical library and stored source copies after a future domain change, run `node scripts/updateSchoolApiUrl.js --apply` with the SSD attached. Without `--apply`, the script reports proposed file changes. Previous source files and database URL/source metadata are backed up under `.school-library-backups/api-url-*` before writing.

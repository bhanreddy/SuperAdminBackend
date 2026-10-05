# SuperAdmin learning content library

The SuperAdmin sidebar's **Content Studio** opens `/manage-content`. Upload reusable
content here; **School enrichment programs** opens the previous form. Only the
existing Founder / SuperAdmin guard may access the library and image endpoints.
No SchoolIMS or PaperForge code is changed by this feature.

## Database decision

The configured database was inspected before implementation. `content_assets`,
`curriculum_master_lessons`, `curriculum_topics`, `syllabus_topics` and
`question_bank` existed; `content_documents` did not. The operational topic and
question tables require school/chapter relationships and cannot model an
independent platform library. This feature reuses `content_assets` for media and
adds normalized `learning_content_*` tables for platform-owned topics,
subtopics, questions, image links, revision snapshots and idempotency receipts.

Run `npm run migrate:learning-content` to install the idempotent additive migration
and provision the private `nexsyrus-content-private` bucket. A pre-existing public
bucket causes an explicit setup error. Existing content-asset architecture (v462)
is a prerequisite. The API's `/schema` reports missing tables; it does not run
migrations during a user request. The migration was applied to the configured
database on 2026-10-05.

## Content contract (schema version 1)

Each topic has a definition, ordered subtopics, images and ordered questions.
Every question and image has a UUID and nullable `subtopic_id`; null means it
belongs to the topic itself. Composite foreign keys prevent cross-topic links.
Arrays retain authoring order. Question kinds are `example`, `activity`,
`exercise`, and `long_answer`, with model answers, explanation, difficulty,
decimal marks and Bloom level. Images store durable asset IDs and alt text;
expiring download URLs are never stored in documents.

Classification includes subject, grade/level, board/framework, language, tags,
learning objectives and source attribution. `metadata` is a bounded JSON object
for additional integration attributes. `draft` supports incomplete definitions
and answers; titles and question prompts must be nonempty. `ready` requires
subject, grade, definitions for the topic and every subtopic, and an answer for
every question. `archived` preserves content and history.

Examples of reuse:

- An LMS can render topic definitions, illustrations and worked examples.
- A question paper generator can select `exercise` / `long_answer` questions by
  subject, grade, difficulty, Bloom level and marks, retaining the model answer.

Teacher plans can reference stable topic/subtopic IDs and learning objectives.
NexMaxx retrieval can use the same IDs, language and tags. These downstream
integrations are future work: marking a topic ready does not publish it to tenant
apps or existing question-bank tables. Consumer access must use a separately
authorized backend adapter, restricted to ready content; never expose the
SuperAdmin API or service credentials to teachers/students.

## API

All paths below are prefixed `/api/super-admin/learning-content` and require the
existing workforce bearer authentication and Founder / SuperAdmin authorization.
Responses follow the existing SuperAdmin conventions: direct resources or
`{data, next_cursor}`; errors have a string `error` field.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/schema` | Schema readiness |
| GET | `/` | List summaries, keyset pagination (default 20, maximum 50) |
| GET | `/:id` | Composite topic document |
| POST | `/` | Create topic with `Idempotency-Key` UUID |
| PUT | `/:id` | Full save with `expected_revision` and `Idempotency-Key` UUID |
| GET | `/:id/revisions` | Revision summaries, 20 per page, optional `before` |
| GET | `/:id/revisions/:revision` | Immutable snapshot |
| POST | `/images/sign-upload` | Validate filename/MIME/size, reserve asset, sign upload |
| POST | `/images/:id/confirm` | Verify size/magic bytes, normalize image, mark ready |
| GET | `/images/:id` | Authorize private image preview, URL expires in one hour |

List filters: `search` (title or exact tag), `subject`, `grade`, `language`,
`status`, `limit`, `cursor`. All are validated and SQL values are parameterized.
Every full save commits topic, children, immutable snapshot and retry receipt in
one transaction. An expected-revision mismatch returns 409. Concurrent repeated
requests share a receipt; changing the payload with the same key returns 409.
Restoring history loads a snapshot into the editor; saving appends a new revision.
The editor queues local draft writes under the authenticated user's ID and
preserves a retry key while the payload is unchanged. Local drafts stay on that
device and require the same logged-in user to recover them through the UI.

Limits: 50 subtopics, 200 questions, 20 images, 500 KB document, 16 KB metadata,
30 writes/minute/actor/instance. The instance-local limiter is intentionally not
a global quota. Images upload directly to Supabase Storage; confirmation decodes
JPEG/PNG/WebP up to 16 megapixels and 5 MB, strips metadata, preserves aspect ratio,
and outputs WebP at a maximum 1600×1600. Incomplete uploads and removed image links
do not erase assets; future retention cleanup must account for immutable revision
references before removing an asset. Idempotency receipts are currently retained.

## Validation

- Backend: `npm run test:learning-content` uses isolated PGlite with real Express
  routes and authentication. PGlite has one session, so database connections are
  serialized while concurrent HTTP submissions verify retry and revision rules.
- Frontend: `node --test tests/learning-content.test.cjs` exercises desktop/mobile
  authoring, all Q&A kinds, linked subtopics, preview, save failures, stable retry
  keys and draft preservation with native UI boundaries mocked.
- `npm run typecheck` and `npm run build:web` validate the Expo app.

The editor uses existing theme tokens and UI components, flat scrolling surfaces,
virtualized library rows, one active question editor, and a focus-animation opt-out
for dense fields. Release-device 60 fps and a signed-in visual/browser walkthrough
remain separate verification; they are not claimed by unit tests or web export.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message, statusCode = 422) { throw Object.assign(new Error(message), { statusCode }); }
function id(value, label = 'ID') { if (!UUID.test(value || '')) fail(`${label} must be a UUID`); return value; }
function text(value, label, max = 20000, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label} must be ${required ? 'non-empty ' : ''}text, up to ${max} characters`);
  return value.trim();
}
function choice(value, options, label, fallback) { value ??= fallback; if (!options.includes(value)) fail(`Choose a valid ${label}`); return value; }
function array(value, label, max) { value ??= []; if (!Array.isArray(value) || value.length > max) fail(`${label} supports up to ${max} entries`); return value; }
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some(k => !allowed.includes(k))) fail(`${label} contains unsupported fields`);
}
function validateDocument(body, updating = false) {
  keys(body, ['title','definition','subject','grade','board','language','tags','learning_objectives','source','status','metadata','subtopics','questions','images','expected_revision'], 'Content');
  if (Buffer.byteLength(JSON.stringify(body)) > 512000) fail('Content exceeds 500 KB; split it into smaller topics');
  if (updating && (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1)) fail('expected_revision is required to protect existing edits');
  const metadata = body.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 16000) fail('Metadata must be an object up to 16 KB');
  const doc = {
    schema_version: 1,
    title: text(body.title, 'Topic', 255, true), definition: text(body.definition, 'Definition'),
    subject: text(body.subject, 'Subject', 120), grade: text(body.grade, 'Grade', 40), board: text(body.board, 'Board', 120),
    language: text(body.language ?? 'en', 'Language', 10, true), source: text(body.source, 'Source', 2000),
    status: choice(body.status, ['draft','ready','archived'], 'status', 'draft'), metadata,
    tags: array(body.tags, 'Tags', 30).map(t => text(t, 'Tag', 80, true)),
    learning_objectives: array(body.learning_objectives, 'Learning objectives', 30).map(t => text(t, 'Objective', 1000, true)),
    subtopics: array(body.subtopics, 'Subtopics', 50).map(s => {
      keys(s, ['id','title','definition'], 'Subtopic');
      return { id: id(s.id, 'Subtopic ID'), title: text(s.title, 'Subtopic title', 255, true), definition: text(s.definition, 'Subtopic definition') };
    }), questions: [], images: [],
  };
  const allIds = new Set();
  function unique(value) { if (allIds.has(value)) fail('Each subtopic, question and image needs a unique ID'); allIds.add(value); return value; }
  doc.subtopics.forEach(s => unique(s.id));
  const subtopics = new Set(doc.subtopics.map(s => s.id));
  function scope(value) { if (value == null) return null; id(value, 'Subtopic link'); if (!subtopics.has(value)) fail('A question or image links to a subtopic outside this topic'); return value; }
  doc.questions = array(body.questions, 'Questions', 200).map(q => {
    keys(q, ['id','subtopic_id','kind','question','answer','explanation','difficulty','marks','bloom_level'], 'Question');
    if (q.marks !== undefined && (typeof q.marks !== 'number' || !Number.isFinite(q.marks) || q.marks < 0 || q.marks > 1000 || Math.abs(q.marks * 100 - Math.round(q.marks * 100)) > 0.000001)) fail('Marks must be a number from 0 to 1000 with up to two decimals');
    return { id: unique(id(q.id, 'Question ID')), subtopic_id: scope(q.subtopic_id),
      kind: choice(q.kind, ['example','activity','exercise','long_answer'], 'question category'),
      question: text(q.question, 'Question', 20000, true), answer: text(q.answer, 'Answer'), explanation: text(q.explanation, 'Explanation'),
      difficulty: choice(q.difficulty, ['easy','medium','hard'], 'difficulty', 'medium'), marks: q.marks ?? 1,
      bloom_level: choice(q.bloom_level, ['remember','understand','apply','analyze','evaluate','create'], 'Bloom level', 'understand') };
  });
  doc.images = array(body.images, 'Images', 20).map(i => {
    keys(i, ['id','asset_id','subtopic_id','alt_text','caption'], 'Image');
    return { id: unique(id(i.id, 'Image ID')), asset_id: id(i.asset_id, 'Asset ID'), subtopic_id: scope(i.subtopic_id), alt_text: text(i.alt_text, 'Image description', 1000, true), caption: text(i.caption, 'Caption', 2000) };
  });
  if (doc.status === 'ready') {
    if (!doc.definition || !doc.subject || !doc.grade) fail('Ready content requires a definition, subject and grade');
    if (doc.subtopics.some(s => !s.definition)) fail('Add a definition for every subtopic before marking ready');
    if (doc.questions.some(q => !q.answer)) fail('Add an answer for every question before marking ready');
  }
  return doc;
}
module.exports = { id, text, choice, array, keys, fail, validateDocument };

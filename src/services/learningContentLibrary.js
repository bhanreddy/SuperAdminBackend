const crypto = require('node:crypto');
const sql = require('../config/db');
const { fail, validateDocument } = require('./learningContentValidation');

async function readTopic(db, topicId) {
  const [topic] = await db`SELECT id,title,definition,subject,grade,board,language,tags,learning_objectives,source,status,metadata,revision,created_at,updated_at FROM learning_content_topics WHERE id=${topicId}`;
  if (!topic) fail('Content topic not found', 404);
  const subtopics = await db`SELECT id,title,definition FROM learning_content_subtopics WHERE topic_id=${topicId} ORDER BY sequence`;
  const questions = await db`SELECT id,subtopic_id,kind,question,answer,explanation,difficulty,marks,bloom_level FROM learning_content_questions WHERE topic_id=${topicId} ORDER BY sequence`;
  const images = await db`SELECT id,subtopic_id,asset_id,alt_text,caption FROM learning_content_images WHERE topic_id=${topicId} ORDER BY sequence`;
  return { ...topic, schema_version: 1, subtopics, questions: questions.map(q => ({...q,marks:Number(q.marks)})), images };
}

async function saveTopic({ topicId, body, actorId, requestKey }) {
  const doc = validateDocument(body, Boolean(topicId));
  const checksum = crypto.createHash('sha256').update(JSON.stringify({ topicId, body })).digest('hex');
  return sql.begin(async db => {
    await db`SET LOCAL statement_timeout = '15s'`;
    const reserved = await db`INSERT INTO learning_content_requests(request_key,actor_id,checksum,response)
      VALUES(${requestKey},${actorId},${checksum},'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING request_key`;
    if (!reserved.length) {
      const [previous] = await db`SELECT checksum,response FROM learning_content_requests WHERE request_key=${requestKey} AND actor_id=${actorId}`;
      if (previous.checksum !== checksum) fail('This save key was already used for different content', 409);
      return previous.response;
    }
    let revision = 1;
    if (topicId) {
      const [existing] = await db`SELECT revision FROM learning_content_topics WHERE id=${topicId} FOR UPDATE`;
      if (!existing) fail('Content topic not found', 404);
      if (existing.revision !== body.expected_revision) fail('Another editor saved this topic. Reload it before saving your changes.', 409);
      revision = existing.revision + 1;
    } else topicId = crypto.randomUUID();
    if (doc.images.length) {
      const ids = [...new Set(doc.images.map(i => i.asset_id))];
      const assets = await db`SELECT id FROM content_assets WHERE id IN ${db(ids)} AND school_id IS NULL AND asset_type='IMAGE' AND status IN ('READY','PUBLISHED') AND metadata->>'origin'='superadmin-learning-library'`;
      if (assets.length !== ids.length) fail('Use completed images uploaded through the content library');
    }
    const row = { title:doc.title,definition:doc.definition,subject:doc.subject,grade:doc.grade,board:doc.board,language:doc.language,
      tags:doc.tags,learning_objectives:doc.learning_objectives,source:doc.source,status:doc.status,metadata:doc.metadata,revision,updated_by:actorId };
    if (revision === 1) await db`INSERT INTO learning_content_topics ${db({...row,id:topicId,created_by:actorId})}`;
    else {
      await db`UPDATE learning_content_topics SET ${db(row)},updated_at=now() WHERE id=${topicId}`;
      await db`DELETE FROM learning_content_questions WHERE topic_id=${topicId}`;
      await db`DELETE FROM learning_content_images WHERE topic_id=${topicId}`;
      await db`DELETE FROM learning_content_subtopics WHERE topic_id=${topicId}`;
    }
    if (doc.subtopics.length) await db`INSERT INTO learning_content_subtopics ${db(doc.subtopics.map((s,sequence)=>({...s,topic_id:topicId,sequence})))}`;
    if (doc.questions.length) await db`INSERT INTO learning_content_questions ${db(doc.questions.map((q,sequence)=>({...q,topic_id:topicId,sequence})))}`;
    if (doc.images.length) await db`INSERT INTO learning_content_images ${db(doc.images.map((i,sequence)=>({...i,topic_id:topicId,sequence})))}`;
    // The revision is also the audit record; snapshot and content commit together.
    await db`INSERT INTO learning_content_revisions(topic_id,revision,document,actor_id) VALUES(${topicId},${revision},${db.json(doc)},${actorId})`;
    const result = await readTopic(db,topicId);
    await db`UPDATE learning_content_requests SET response=${db.json(result)} WHERE request_key=${requestKey} AND actor_id=${actorId}`;
    return result;
  });
}

async function listTopics({ search='',subject='',grade='',language='',status='',limit=20,cursor=null }) {
  const rows = await sql`SELECT id,title,subject,grade,board,language,status,revision,updated_at,
    (SELECT count(*)::int FROM learning_content_subtopics s WHERE s.topic_id=t.id) AS subtopic_count,
    (SELECT count(*)::int FROM learning_content_questions q WHERE q.topic_id=t.id) AS question_count
    FROM learning_content_topics t WHERE
    (${search}='' OR title ILIKE ${`%${search}%`} OR ${search}=ANY(tags))
    AND (${subject}='' OR subject=${subject}) AND (${grade}='' OR grade=${grade})
    AND (${language}='' OR language=${language}) AND (${status}='' OR status=${status})
    ${cursor ? sql`AND (updated_at,id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : sql``}
    ORDER BY updated_at DESC,id DESC LIMIT ${limit+1}`;
  const more = rows.length > limit;
  const data = rows.slice(0,limit);
  const last = data.at(-1);
  return { data, next_cursor:more ? Buffer.from(JSON.stringify({at:last.updated_at,id:last.id})).toString('base64url') : null };
}
async function schemaStatus() {
  const required = ['content_assets','learning_content_topics','learning_content_subtopics','learning_content_questions','learning_content_images','learning_content_revisions','learning_content_requests'];
  const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ${sql(required)}`;
  const missing = required.filter(t=>!rows.some(r=>r.table_name===t));
  return { ready:!missing.length, missing, schema_version:1 };
}
module.exports = { readTopic, saveTopic, listTopics, schemaStatus };

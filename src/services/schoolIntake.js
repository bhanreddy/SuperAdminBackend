const { schoolPublicApiUrl } = require('../config/schoolPublicApi');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('../config/db');
const { schoolSupabaseAdmin } = require('../config/supabase');
const { getClusterServiceClient } = require('../utils/clusterClient');
const { provisionFirstAdmin } = require('./schoolProvisioning');
const { logAudit } = require('./auditLogger');
const { seedDraftFromSchool } = require('./schoolConfiguration');
const { normalizeDossier, evaluateDossier } = require('./schoolIntakeIntelligence');

const OPEN_STATUSES = ['SUBMITTED', 'CHANGES_REQUESTED', 'PROVISIONING', 'FAILED'];
let schemaReady = null;

function ensureSchoolIntakeSchema() {
  if (!schemaReady) {
    const ddl = fs.readFileSync(path.join(__dirname, '../db/migrations/22_school_intake.sql'), 'utf8');
    schemaReady = sql.unsafe(ddl).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let body = '';
  for (let i = 0; i < bytes.length; i += 1) body += alphabet[bytes[i] % alphabet.length];
  return `Nx${body}!`;
}

async function loadClusterPreview() {
  const rows = await sql`
    SELECT cluster_id, label, school_count, max_schools
    FROM clusters
    WHERE status = 'active' AND school_count < max_schools
    ORDER BY school_count ASC, cluster_id ASC
    LIMIT 1
  `;
  return rows[0] || null;
}

async function loadLiveSchools() {
  const { data: clusters, error } = await schoolSupabaseAdmin.from('clusters').select('cluster_id').eq('status', 'active');
  if (error) throw error;
  const schools = [];
  let unreachable = false;
  await Promise.all((clusters || []).map(async (cluster) => {
    try {
      const client = await getClusterServiceClient(cluster.cluster_id, 'school');
      const { data, error: schoolError } = await client.from('schools').select('id, name, code, android_package');
      if (schoolError) throw schoolError;
      (data || []).forEach((school) => schools.push({ ...school, cluster_id: cluster.cluster_id }));
    } catch (err) {
      unreachable = true;
    }
  }));
  return { schools, unreachable };
}

async function loadOpenIntakes(excludeId) {
  const rows = await sql`
    SELECT id, dossier->>'name' AS name, dossier->>'code' AS code
    FROM school_intake_requests
    WHERE status IN ${sql(OPEN_STATUSES)}
      ${excludeId ? sql`AND id <> ${excludeId}` : sql``}
  `;
  return rows;
}

async function buildIntelligence(rawDossier, excludeIntakeId) {
  const dossier = normalizeDossier(rawDossier);
  const [{ schools, unreachable }, openIntakes, cluster] = await Promise.all([
    loadLiveSchools().catch(() => ({ schools: [], unreachable: true })),
    loadOpenIntakes(excludeIntakeId),
    loadClusterPreview().catch(() => null),
  ]);
  const intelligence = evaluateDossier({
    dossier,
    liveSchools: schools,
    openIntakes,
    cluster,
    excludeIntakeId,
  });
  delete dossier.color_was_invalid;
  if (unreachable) {
    intelligence.warnings.push({
      code: 'DIRECTORY',
      message: 'One or more clusters could not be checked for duplicates. The founder should confirm before approving.',
    });
    if (intelligence.grade === 'READY') intelligence.grade = 'REVIEW';
  }
  return { dossier, intelligence };
}

function present(row, events) {
  const dossier = row.dossier || {};
  const intelligence = row.intelligence || {};
  return {
    id: row.id,
    status: row.status,
    name: dossier.name || '',
    code: dossier.code || '',
    city: dossier.city || '',
    state: dossier.state || '',
    score: intelligence.score ?? 0,
    grade: intelligence.grade || 'REVIEW',
    brief: intelligence.brief || '',
    submitted_by: row.submitted_by,
    submitted_by_name: row.submitted_by_name || '',
    submitted_by_employee_id: row.submitted_by_employee_id || '',
    reviewed_by_name: row.reviewed_by_name || '',
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    onboarded_at: row.onboarded_at,
    updated_at: row.updated_at,
    review_note: row.review_note,
    school_id: row.school_id,
    cluster_id: row.cluster_id,
    failure_reason: row.failure_reason,
    provision_steps: row.provision_steps || [],
    dossier,
    intelligence,
    events: events || undefined,
  };
}

const REQUEST_SELECT = sql`
  r.id, r.status, r.submitted_by, r.reviewed_by, r.dossier, r.intelligence,
  r.review_note, r.school_id, r.cluster_id, r.provision_steps, r.failure_reason,
  r.submitted_at, r.reviewed_at, r.onboarded_at, r.created_at, r.updated_at,
  u.full_name AS submitted_by_name, u.employee_id AS submitted_by_employee_id,
  reviewer.full_name AS reviewed_by_name
`;

async function listIntakes(user) {
  await ensureSchoolIntakeSchema();
  const founder = Boolean(user.isFounder);
  const rows = founder
    ? await sql`
        SELECT ${REQUEST_SELECT}
        FROM school_intake_requests r
        JOIN internal_users u ON u.id = r.submitted_by
        LEFT JOIN internal_users reviewer ON reviewer.id = r.reviewed_by
        ORDER BY r.submitted_at DESC
        LIMIT 200
      `
    : await sql`
        WITH RECURSIVE reports AS (
          SELECT id FROM internal_users WHERE id = ${user.id}
          UNION ALL
          SELECT child.id FROM internal_users child
          JOIN reports parent ON child.manager_id = parent.id
          WHERE child.status = 'ACTIVE'
        )
        SELECT ${REQUEST_SELECT}
        FROM school_intake_requests r
        JOIN internal_users u ON u.id = r.submitted_by
        LEFT JOIN internal_users reviewer ON reviewer.id = r.reviewed_by
        WHERE r.submitted_by IN (SELECT id FROM reports)
        ORDER BY r.submitted_at DESC
        LIMIT 200
      `;
  return rows.map((row) => present(row));
}

async function getIntake(id, user) {
  await ensureSchoolIntakeSchema();
  const [row] = await sql`
    SELECT ${REQUEST_SELECT}
    FROM school_intake_requests r
    JOIN internal_users u ON u.id = r.submitted_by
    LEFT JOIN internal_users reviewer ON reviewer.id = r.reviewed_by
    WHERE r.id = ${id}
    LIMIT 1
  `;
  if (!row) return null;
  if (!user.isFounder && row.submitted_by !== user.id) {
    const [visible] = await sql`
      WITH RECURSIVE reports AS (
        SELECT id FROM internal_users WHERE id = ${user.id}
        UNION ALL
        SELECT child.id FROM internal_users child
        JOIN reports parent ON child.manager_id = parent.id
        WHERE child.status = 'ACTIVE'
      )
      SELECT 1 AS ok FROM reports WHERE id = ${row.submitted_by} LIMIT 1
    `;
    if (!visible) return { forbidden: true };
  }
  const events = await sql`
    SELECT e.id, e.event_type, e.note, e.created_at, u.full_name AS actor_name
    FROM school_intake_events e
    LEFT JOIN internal_users u ON u.id = e.actor_id
    WHERE e.request_id = ${id}
    ORDER BY e.created_at ASC
  `;
  return present(row, events);
}

async function addEvent(requestId, actorId, eventType, note, payload = {}) {
  await sql`
    INSERT INTO school_intake_events (request_id, actor_id, event_type, note, payload)
    VALUES (${requestId}, ${actorId}, ${eventType}, ${note || null}, ${sql.json(payload)})
  `;
}

async function submitIntake(user, rawDossier) {
  await ensureSchoolIntakeSchema();
  const { dossier, intelligence } = await buildIntelligence(rawDossier);
  if (intelligence.grade === 'BLOCKED') {
    const error = new Error(intelligence.blockers[0]?.message || 'This dossier cannot be sent yet.');
    error.status = 422;
    error.intelligence = intelligence;
    error.dossier = dossier;
    throw error;
  }
  const [row] = await sql`
    INSERT INTO school_intake_requests (submitted_by, dossier, intelligence, status)
    VALUES (${user.id}, ${sql.json(dossier)}, ${sql.json(intelligence)}, 'SUBMITTED')
    RETURNING id
  `;
  await addEvent(row.id, user.id, 'SUBMITTED', 'Sent to the founder for review.', { score: intelligence.score, grade: intelligence.grade });
  await logAudit({
    userId: user.id,
    action: 'SCHOOL_INTAKE_SUBMITTED',
    entity: 'SCHOOL_INTAKE',
    entityId: row.id,
    details: { name: dossier.name, code: dossier.code, score: intelligence.score },
  });
  return getIntake(row.id, user);
}

async function resubmitIntake(user, id, rawDossier) {
  await ensureSchoolIntakeSchema();
  const current = await getIntake(id, user);
  if (!current || current.forbidden) return current;
  if (current.submitted_by !== user.id && !user.isFounder) return { forbidden: true };
  if (current.status !== 'CHANGES_REQUESTED') {
    const error = new Error('This dossier can be updated only after the founder asks for changes.');
    error.status = 409;
    throw error;
  }
  const { dossier, intelligence } = await buildIntelligence(rawDossier, id);
  if (intelligence.grade === 'BLOCKED') {
    const error = new Error(intelligence.blockers[0]?.message || 'This dossier cannot be sent yet.');
    error.status = 422;
    error.intelligence = intelligence;
    throw error;
  }
  await sql`
    UPDATE school_intake_requests
    SET dossier = ${sql.json(dossier)},
        intelligence = ${sql.json(intelligence)},
        status = 'SUBMITTED',
        review_note = NULL,
        failure_reason = NULL,
        submitted_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
  `;
  await addEvent(id, user.id, 'RESUBMITTED', 'Updated dossier sent back to the founder.', { score: intelligence.score });
  return getIntake(id, user);
}

async function founderDecision(user, id, { status, note, eventType }) {
  if (!user.isFounder) {
    const error = new Error('Only the founder tech lead can review school intake.');
    error.status = 403;
    throw error;
  }
  const trimmed = String(note || '').trim();
  if (trimmed.length < 4) {
    const error = new Error('Add a short note so the executive knows what to do.');
    error.status = 400;
    throw error;
  }
  const [row] = await sql`
    UPDATE school_intake_requests
    SET status = ${status},
        review_note = ${trimmed},
        reviewed_by = ${user.id},
        reviewed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id} AND status = 'SUBMITTED'
    RETURNING id
  `;
  if (!row) {
    const error = new Error('This dossier is not waiting for review.');
    error.status = 409;
    throw error;
  }
  await addEvent(id, user.id, eventType, trimmed);
  await logAudit({
    userId: user.id,
    action: eventType,
    entity: 'SCHOOL_INTAKE',
    entityId: id,
    details: { note: trimmed },
  });
  return getIntake(id, user);
}

async function reserveCluster() {
  const [cluster] = await sql`
    SELECT cluster_id, label, school_backend_url, school_count, max_schools
    FROM clusters
    WHERE status = 'active' AND school_count < max_schools
    ORDER BY school_count ASC, cluster_id ASC
    LIMIT 1
  `;
  if (!cluster) return null;
  const reserved = await sql`
    UPDATE clusters
    SET school_count = school_count + 1, updated_at = NOW()
    WHERE cluster_id = ${cluster.cluster_id}
      AND status = 'active'
      AND school_count < max_schools
    RETURNING cluster_id
  `;
  if (!reserved.length) return null;
  return cluster;
}

async function releaseCluster(clusterId) {
  await sql`
    UPDATE clusters
    SET school_count = GREATEST(school_count - 1, 0), updated_at = NOW()
    WHERE cluster_id = ${clusterId}
  `;
}

async function approveIntake(user, id) {
  if (!user.isFounder) {
    const error = new Error('Only the founder tech lead can onboard a school.');
    error.status = 403;
    throw error;
  }
  await ensureSchoolIntakeSchema();
  const [locked] = await sql`
    UPDATE school_intake_requests
    SET status = 'PROVISIONING', reviewed_by = ${user.id}, reviewed_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND status IN ('SUBMITTED', 'FAILED')
    RETURNING *
  `;
  if (!locked) {
    const existing = await getIntake(id, user);
    if (existing && existing.status === 'ONBOARDED') return { intake: existing };
    const error = new Error('This dossier is not ready to onboard.');
    error.status = 409;
    throw error;
  }

  const { dossier, intelligence } = await buildIntelligence(locked.dossier, id);
  if (intelligence.grade === 'BLOCKED') {
    await sql`
      UPDATE school_intake_requests
      SET status = 'SUBMITTED', intelligence = ${sql.json(intelligence)}, dossier = ${sql.json(dossier)}, updated_at = NOW()
      WHERE id = ${id}
    `;
    const error = new Error(intelligence.blockers[0]?.message || 'Checks failed. The dossier is back in the review queue.');
    error.status = 422;
    throw error;
  }

  const steps = [];
  let cluster = null;
  let schoolId = locked.school_id || null;
  let releaseOnFailure = false;
  try {
    if (!schoolId) {
      cluster = await reserveCluster();
      if (!cluster) throw Object.assign(new Error('All clusters are full. Add capacity, then approve again.'), { status: 503 });
      releaseOnFailure = true;
      steps.push({ id: 'cluster', status: 'done', detail: `${cluster.label} (${cluster.cluster_id})` });
      const clientForCreate = await getClusterServiceClient(cluster.cluster_id, 'school');
      const schoolRow = {
        name: dossier.name,
        code: dossier.code,
        address: [dossier.address, dossier.city, dossier.state, dossier.pincode].filter(Boolean).join(', ') || null,
        logo_url: dossier.logo_url || null,
        cluster_id: cluster.cluster_id,
        backend_url: schoolPublicApiUrl(),
        android_package: dossier.android_package || null,
        ios_bundle_id: dossier.ios_bundle_id || null,
        primary_color: dossier.primary_color || '#1A73E8',
        onboarding_status: 'pending_build',
      };
      const inserted = await clientForCreate.from('schools').insert(schoolRow).select().single();
      if (inserted.error) {
        if (inserted.error.code === '23505') {
          throw Object.assign(new Error('That school code already exists on the assigned cluster.'), { status: 409 });
        }
        throw inserted.error;
      }
      schoolId = inserted.data.id;
      steps.push({ id: 'school', status: 'done', detail: String(schoolId) });
      await sql`
        UPDATE school_intake_requests
        SET school_id = ${schoolId}, cluster_id = ${cluster.cluster_id}, provision_steps = ${sql.json(steps)}, updated_at = NOW()
        WHERE id = ${id}
      `;
      releaseOnFailure = false;
    } else {
      cluster = { cluster_id: locked.cluster_id, label: locked.cluster_id };
      steps.push({ id: 'school', status: 'done', detail: String(schoolId) });
    }

    const client = await getClusterServiceClient(cluster.cluster_id, 'school');
    const school = { id: schoolId };

    await sql`
      INSERT INTO internal_user_schools (user_id, school_id, assigned_by)
      VALUES (${locked.submitted_by}, ${school.id}, ${user.id})
      ON CONFLICT DO NOTHING
    `;
    steps.push({ id: 'assignment', status: 'done', detail: 'Assigned to the submitting executive' });

    let temporaryPasswordValue = null;
    let adminEmail = null;
    if (dossier.admin_email && dossier.admin_first_name && dossier.admin_last_name) {
      temporaryPasswordValue = temporaryPassword();
      const adminResult = await provisionFirstAdmin(client, school.id, {
        email: dossier.admin_email,
        password: temporaryPasswordValue,
        first_name: dossier.admin_first_name,
        last_name: dossier.admin_last_name,
        gender_id: 1,
        dob: '1990-01-01',
      });
      if (!adminResult.ok) {
        temporaryPasswordValue = null;
        steps.push({ id: 'admin', status: 'skipped', detail: adminResult.error || 'First admin was not created' });
      } else {
        adminEmail = dossier.admin_email;
        steps.push({ id: 'admin', status: 'done', detail: dossier.admin_email });
      }
    } else {
      steps.push({ id: 'admin', status: 'skipped', detail: 'No complete first admin on the dossier' });
    }

    try {
      const seeded = await client.rpc('seed_school_defaults', { p_school_id: school.id });
      if (seeded.error) throw seeded.error;
      steps.push({ id: 'defaults', status: 'done', detail: 'Default roles seeded' });
    } catch (seedErr) {
      steps.push({ id: 'defaults', status: 'skipped', detail: 'Default seed was not available on this cluster' });
    }

    await sql`
      UPDATE school_intake_requests
      SET status = 'ONBOARDED',
          dossier = ${sql.json(dossier)},
          intelligence = ${sql.json(intelligence)},
          school_id = ${school.id},
          cluster_id = ${cluster.cluster_id},
          provision_steps = ${sql.json(steps)},
          failure_reason = NULL,
          onboarded_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id}
    `;
    await addEvent(id, user.id, 'ONBOARDED', `School ${school.id} is live on ${cluster.label}.`, {
      school_id: school.id,
      cluster_id: cluster.cluster_id,
    });
    await seedDraftFromSchool(sql, {
      clusterId: cluster.cluster_id,
      school: {
        id: school.id,
        name: dossier.name,
        code: dossier.code,
        address: [dossier.address, dossier.city, dossier.state, dossier.pincode].filter(Boolean).join(', '),
        android_package: dossier.android_package || null,
        ios_bundle_id: dossier.ios_bundle_id || null,
        primary_color: dossier.primary_color || null,
      },
      userId: user.id,
      origin: 'created',
      intakeId: id,
    }).catch((seedErr) => console.error('[school-intake] configuration seed failed:', seedErr.message));
    await logAudit({
      userId: user.id,
      action: 'SCHOOL_INTAKE_ONBOARDED',
      entity: 'SCHOOL',
      entityId: school.id,
      schoolId: school.id,
      details: { intake_id: id, cluster_id: cluster.cluster_id, code: dossier.code },
    });
    const intake = await getIntake(id, user);
    return {
      intake,
      temporary_password: temporaryPasswordValue,
      admin_email: adminEmail,
    };
  } catch (err) {
    if (releaseOnFailure && cluster) await releaseCluster(cluster.cluster_id).catch(() => {});
    const reason = err.message || 'Onboarding failed.';
    await sql`
      UPDATE school_intake_requests
      SET status = 'FAILED',
          failure_reason = ${reason},
          provision_steps = ${sql.json(steps)},
          updated_at = NOW()
      WHERE id = ${id}
    `;
    await addEvent(id, user.id, 'FAILED', reason);
    throw err;
  }
}

module.exports = {
  ensureSchoolIntakeSchema,
  buildIntelligence,
  listIntakes,
  getIntake,
  submitIntake,
  resubmitIntake,
  founderDecision,
  approveIntake,
};

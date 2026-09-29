const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { imageKind } = require('../utils/uploadBytes');
const {
  TEMPLATE_VERSION,
  applyPatch,
  backfillFromSchool,
  collectBlockers,
  effectiveConfig,
  hashRequest,
  publicClusterSnapshot,
  diffValues,
  coded,
} = require('./schoolConfigSchema');

const MIGRATION = path.join(__dirname, '../db/migrations/24_school_configuration.sql');
let schemaReady = null;

function ensureSchoolConfigurationSchema(sql) {
  if (!schemaReady) {
    const ddl = fs.readFileSync(MIGRATION, 'utf8');
    schemaReady = sql.unsafe(ddl).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function resetSchemaForTests() {
  schemaReady = null;
}

async function getDraft(sql, clusterId, schoolId) {
  const [row] = await sql`
    SELECT cluster_id, school_id, version, config, asset_ids, intake_id, origin, updated_at
    FROM school_config_drafts
    WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
  `;
  return row || null;
}

async function seedDraftFromSchool(sql, { clusterId, school, userId = null, origin = 'created', intakeId = null }) {
  await ensureSchoolConfigurationSchema(sql);
  const existing = await getDraft(sql, clusterId, school.id);
  if (existing) return existing;
  const config = backfillFromSchool(school, origin);
  const [row] = await sql`
    INSERT INTO school_config_drafts (cluster_id, school_id, version, config, asset_ids, intake_id, origin, updated_by)
    VALUES (
      ${clusterId},
      ${Number(school.id)},
      1,
      ${sql.json({ ...config, origin })},
      ${sql.json({})},
      ${intakeId},
      ${origin},
      ${userId}
    )
    ON CONFLICT (cluster_id, school_id) DO NOTHING
    RETURNING *
  `;
  return row || getDraft(sql, clusterId, school.id);
}

async function saveDraft(sql, { clusterId, schoolId, expectedVersion, patch, isFounder, userId }) {
  const current = await getDraft(sql, clusterId, schoolId);
  if (!current) throw coded(404, 'Configuration draft not found', 'DRAFT_MISSING');
  if (Number(current.version) !== Number(expectedVersion)) {
    throw coded(409, 'The configuration was updated by someone else. Reload and try again.', 'CONFIG_VERSION_CONFLICT');
  }
  const next = applyPatch({ ...current.config, origin: current.origin }, patch, { isFounder });
  const [row] = await sql`
    UPDATE school_config_drafts
    SET config = ${sql.json({ ...next, origin: current.origin })},
        version = version + 1,
        updated_by = ${userId ?? null},
        updated_at = NOW()
    WHERE cluster_id = ${clusterId}
      AND school_id = ${Number(schoolId)}
      AND version = ${Number(expectedVersion)}
    RETURNING *
  `;
  if (!row) throw coded(409, 'The configuration was updated by someone else. Reload and try again.', 'CONFIG_VERSION_CONFLICT');
  return row;
}

async function listAssets(sql, clusterId, schoolId) {
  return sql`
    SELECT id, slot, sha256, mime, width, height, byte_size, storage_path, created_at
    FROM school_config_assets
    WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
    ORDER BY created_at ASC
  `;
}

async function assetMap(sql, clusterId, schoolId, assetIds) {
  const ids = Object.values(assetIds || {});
  if (!ids.length) return {};
  const rows = await sql`
    SELECT id, slot, sha256, mime, width, height, byte_size, storage_path
    FROM school_config_assets
    WHERE cluster_id = ${clusterId}
      AND school_id = ${Number(schoolId)}
      AND id IN ${sql(ids)}
  `;
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  return Object.fromEntries(Object.entries(assetIds).map(([slot, id]) => [slot, byId[id] || null]));
}

function classifyImage(bytes, declaredType) {
  const kind = imageKind(bytes);
  if (!kind) return { ok: false, error: 'File contents are not a PNG, JPEG, or WebP image' };
  const declared = String(declaredType || kind.mime).toLowerCase().split(';')[0].trim();
  if (declared && declared !== kind.mime && declared !== 'application/octet-stream') {
    return { ok: false, error: 'File contents do not match the declared image type' };
  }
  return { ok: true, ...kind };
}

async function attachAsset(sql, { clusterId, schoolId, slot, storagePath, sha256, mime, width, height, byteSize, userId, derivedFrom = null, expectedVersion }) {
  return sql.begin(async (tx) => {
    const [draft] = await tx`
      SELECT version, asset_ids FROM school_config_drafts
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!draft) throw coded(404, 'Configuration draft not found', 'DRAFT_MISSING');
    if (expectedVersion != null && Number(draft.version) !== Number(expectedVersion)) {
      throw coded(409, 'The configuration was updated by someone else. Reload and try again.', 'CONFIG_VERSION_CONFLICT');
    }
    const [asset] = await tx`
      INSERT INTO school_config_assets (
        cluster_id, school_id, slot, storage_path, sha256, mime, width, height, byte_size, derived_from, created_by
      ) VALUES (
        ${clusterId}, ${Number(schoolId)}, ${slot}, ${storagePath}, ${sha256}, ${mime}, ${width}, ${height}, ${byteSize}, ${derivedFrom ?? null}, ${userId ?? null}
      )
      RETURNING *
    `;
    const assetIds = { ...(draft.asset_ids || {}), [slot]: asset.id };
    const [updated] = await tx`
      UPDATE school_config_drafts
      SET asset_ids = ${tx.json(assetIds)}, version = version + 1, updated_at = NOW(), updated_by = ${userId ?? null}
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
      RETURNING *
    `;
    return { asset, draft: updated };
  });
}

async function requestPackage(sql, { clusterId, schoolId, userId, idempotencyKey, note, cluster, assetPresence }) {
  if (!idempotencyKey || String(idempotencyKey).trim().length < 8 || String(idempotencyKey).trim().length > 200) {
    throw coded(400, 'Idempotency-Key must be between 8 and 200 characters', 'IDEMPOTENCY_KEY');
  }
  const snapshot = publicClusterSnapshot(cluster);
  return sql.begin(async (tx) => {
    const [draft] = await tx`
      SELECT * FROM school_config_drafts
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!draft) throw coded(404, 'Configuration draft not found', 'DRAFT_MISSING');
    const blockers = collectBlockers({ ...draft.config, origin: draft.origin }, assetPresence, snapshot);
    if (blockers.length) throw coded(422, 'Selected platforms are not ready', 'PLATFORM_BLOCKED', blockers);
    const requestHash = hashRequest(draft, snapshot);
    const key = String(idempotencyKey).trim();
    const [existingKey] = await tx`
      SELECT * FROM school_package_jobs
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)} AND idempotency_key = ${key}
    `;
    if (existingKey) {
      if (existingKey.request_hash !== requestHash) {
        throw coded(409, 'This idempotency key was already used for a different configuration', 'IDEMPOTENCY_CONFLICT');
      }
      return { job: existingKey, created: false };
    }
    const [last] = await tx`
      SELECT revision, draft_version FROM school_config_revisions
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
      ORDER BY revision DESC
      LIMIT 1
    `;
    let revision = last ? Number(last.revision) : 0;
    if (!last || Number(last.draft_version) !== Number(draft.version)) {
      revision += 1;
      await tx`
        INSERT INTO school_config_revisions (
          cluster_id, school_id, revision, config, cluster_snapshot, asset_ids, template_version, draft_version, created_by
        ) VALUES (
          ${clusterId},
          ${Number(schoolId)},
          ${revision},
          ${tx.json({ ...draft.config, origin: draft.origin })},
          ${tx.json(snapshot)},
          ${tx.json(draft.asset_ids || {})},
          ${TEMPLATE_VERSION},
          ${draft.version},
          ${userId ?? null}
        )
      `;
    } else {
      const [inflight] = await tx`
        SELECT * FROM school_package_jobs
        WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)} AND revision = ${revision}
          AND status IN ('QUEUED', 'RUNNING', 'SUCCEEDED')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (inflight) return { job: inflight, created: false };
    }
    const [job] = await tx`
      INSERT INTO school_package_jobs (
        cluster_id, school_id, revision, idempotency_key, request_hash, status, note, created_by
      ) VALUES (
        ${clusterId}, ${Number(schoolId)}, ${revision}, ${key}, ${requestHash}, 'QUEUED', ${note || null}, ${userId ?? null}
      )
      RETURNING *
    `;
    return { job, created: true };
  });
}

async function retryJob(sql, { clusterId, schoolId, jobId }) {
  const [job] = await sql`
    UPDATE school_package_jobs
    SET status = 'QUEUED', lease_expires_at = NULL, locked_by = NULL, error = NULL, updated_at = NOW()
    WHERE id = ${jobId}
      AND cluster_id = ${clusterId}
      AND school_id = ${Number(schoolId)}
      AND status = 'FAILED'
    RETURNING *
  `;
  if (!job) throw coded(409, 'Only a failed package job can be retried', 'JOB_NOT_RETRYABLE');
  return job;
}

async function getRevision(sql, clusterId, schoolId, revision) {
  const [row] = await sql`
    SELECT * FROM school_config_revisions
    WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)} AND revision = ${Number(revision)}
  `;
  return row || null;
}

async function listRevisions(sql, clusterId, schoolId) {
  return sql`
    SELECT revision, draft_version, template_version, created_at, created_by
    FROM school_config_revisions
    WHERE cluster_id = ${clusterId} AND school_id = ${Number(schoolId)}
    ORDER BY revision DESC
  `;
}

function diffRevisions(left, right) {
  return {
    from_revision: left.revision,
    to_revision: right.revision,
    config: diffValues(left.config, right.config),
    assets: diffValues(left.asset_ids, right.asset_ids),
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  ensureSchoolConfigurationSchema,
  resetSchemaForTests,
  getDraft,
  seedDraftFromSchool,
  saveDraft,
  listAssets,
  assetMap,
  classifyImage,
  attachAsset,
  requestPackage,
  retryJob,
  getRevision,
  listRevisions,
  diffRevisions,
  sha256,
};

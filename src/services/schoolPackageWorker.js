const crypto = require('crypto');
const os = require('os');
const { schoolSupabaseAdmin } = require('../config/supabase');
const { getRevision, sha256 } = require('./schoolConfiguration');
const { renderPackage } = require('./schoolPackageRender');

const BUCKET = 'school-packages';
const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

function memoryStorage() {
  const objects = new Map();
  return {
    async put(objectPath, body, contentType) {
      objects.set(objectPath, { body: Buffer.from(body), contentType });
    },
    async get(objectPath) {
      return objects.get(objectPath)?.body || null;
    },
  };
}

function supabaseStorage() {
  return {
    async put(objectPath, body, contentType) {
      const { error } = await schoolSupabaseAdmin.storage.from(BUCKET).upload(objectPath, body, {
        contentType: contentType || 'application/zip',
        upsert: false,
      });
      if (error && !/already exists|Duplicate/i.test(error.message || '')) {
        const wrapped = new Error(error.message || 'Object storage is unavailable');
        wrapped.code = 'STORAGE_UNAVAILABLE';
        throw wrapped;
      }
    },
    async get(objectPath) {
      const { data, error } = await schoolSupabaseAdmin.storage.from(BUCKET).download(objectPath);
      if (error || !data) return null;
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
  };
}

async function claimJob(sql) {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      SELECT * FROM school_package_jobs
      WHERE status IN ('QUEUED', 'RUNNING')
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        AND attempt_count < max_attempts
      ORDER BY updated_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!row) return null;
    const [claimed] = await tx`
      UPDATE school_package_jobs
      SET status = 'RUNNING',
          attempt_count = attempt_count + 1,
          lease_expires_at = NOW() + INTERVAL '120 seconds',
          locked_by = ${workerId},
          updated_at = NOW()
      WHERE id = ${row.id}
      RETURNING *
    `;
    return claimed;
  });
}

async function loadAssetBodies(sql, storage, revision) {
  const ids = Object.values(revision.asset_ids || {});
  if (!ids.length) return { bodies: {}, notificationDedicated: false };
  const rows = await sql`
    SELECT id, slot, storage_path FROM school_config_assets
    WHERE cluster_id = ${revision.cluster_id}
      AND school_id = ${revision.school_id}
      AND id IN ${sql(ids)}
  `;
  const bodies = {};
  for (const row of rows) {
    bodies[row.slot] = await storage.get(row.storage_path);
  }
  return {
    bodies,
    notificationDedicated: Boolean(revision.asset_ids.notification_icon) && revision.asset_ids.notification_icon !== revision.asset_ids.app_icon,
  };
}

async function executeJob(sql, job, storage) {
  const revision = await getRevision(sql, job.cluster_id, job.school_id, job.revision);
  if (!revision) throw Object.assign(new Error('Configuration revision is missing'), { code: 'REVISION_MISSING' });
  const { bodies, notificationDedicated } = await loadAssetBodies(sql, storage, revision);
  const rendered = await renderPackage({
    rawConfig: revision.config,
    schoolId: job.school_id,
    clusterId: job.cluster_id,
    revision: job.revision,
    snapshot: revision.cluster_snapshot,
    assetBodies: bodies,
    notificationDedicated,
  });
  const objectPath = `${job.cluster_id}/${job.school_id}/packages/r${job.revision}/${rendered.sha256}.zip`;
  const existing = await storage.get(objectPath);
  if (!existing || sha256(existing) !== rendered.sha256) {
    await storage.put(objectPath, rendered.zip, 'application/zip');
  }
  const fileName = `${rendered.folder}.zip`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO school_package_artifacts (
        job_id, cluster_id, school_id, revision, storage_path, sha256, byte_size, file_name
      ) VALUES (
        ${job.id}, ${job.cluster_id}, ${job.school_id}, ${job.revision}, ${objectPath}, ${rendered.sha256}, ${rendered.zip.length}, ${fileName}
      )
      ON CONFLICT (cluster_id, school_id, revision) DO NOTHING
    `;
    await tx`
      UPDATE school_package_jobs
      SET status = 'SUCCEEDED', lease_expires_at = NULL, error = NULL, updated_at = NOW()
      WHERE id = ${job.id}
    `;
  });
  return { sha256: rendered.sha256, fileName };
}

async function failJob(sql, job, error) {
  const terminal = Number(job.attempt_count) >= Number(job.max_attempts);
  await sql`
    UPDATE school_package_jobs
    SET status = ${terminal ? 'FAILED' : 'QUEUED'},
        lease_expires_at = NULL,
        error = ${sql.json({ message: error.message || 'Package generation failed', code: error.code || 'PACKAGE_FAILED' })},
        updated_at = NOW()
    WHERE id = ${job.id}
  `;
}

async function tick(sql, storage) {
  const job = await claimJob(sql);
  if (!job) return null;
  try {
    await executeJob(sql, job, storage);
    return job.id;
  } catch (err) {
    await failJob(sql, job, err);
    return job.id;
  }
}

let timer = null;
let running = false;

function startSchoolPackageWorker(sql, storage = supabaseStorage()) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(sql, storage);
    } catch (err) {
      console.error('[school-package] worker tick failed:', err.message);
    } finally {
      running = false;
    }
  }, 5000);
  if (timer.unref) timer.unref();
}

function stopSchoolPackageWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  BUCKET,
  memoryStorage,
  supabaseStorage,
  claimJob,
  executeJob,
  failJob,
  tick,
  startSchoolPackageWorker,
  stopSchoolPackageWorker,
};

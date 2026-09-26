const crypto = require('crypto');
const os = require('os');
const config = require('../../config/env');
const crmSql = require('../../config/crmDb');
const schoolSql = require('../../config/db');
const { CrmError } = require('./errors');
const { parseStored, previewStored, executeStored, loadBatch } = require('./importService');

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
let timer = null;
let running = false;

async function revalidateActor(batch) {
  const [admin] = await schoolSql`SELECT id, is_active, email FROM super_admins WHERE id = ${batch.created_by}`;
  if (admin?.is_active) {
    return { kind: 'platform', canWrite: true, founderId: null, actor: { id: admin.id, isSuperAdmin: true, email: admin.email } };
  }
  const [founder] = await schoolSql`
    SELECT id, user_id, is_active, role FROM founders WHERE user_id = ${batch.created_by}
  `;
  if (!founder?.is_active || founder.role === 'APPROVER') {
    throw new CrmError(403, 'Import actor is no longer allowed to write CRM data', 'ACTOR_REVOKED');
  }
  if (batch.scope_kind === 'owner' && batch.scope_founder_id !== founder.id) {
    throw new CrmError(403, 'Import scope no longer matches the actor', 'ACTOR_REVOKED');
  }
  return { kind: 'owner', canWrite: true, founderId: founder.id, actor: { id: founder.user_id, founderId: founder.id, founderRole: founder.role } };
}

async function claim(db = crmSql) {
  return db.begin(async (tx) => {
    const [row] = await tx`
      SELECT * FROM crm_import_batches
      WHERE status IN ('PARSING', 'PREVIEW_QUEUED', 'CONFIRMED', 'PROCESSING')
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
        AND cancel_requested_at IS NULL
        AND attempt_count < max_attempts
      ORDER BY updated_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!row) return null;
    const token = crypto.randomUUID();
    const [claimed] = await tx`
      UPDATE crm_import_batches SET
        lease_owner = ${workerId}, lease_token = ${token}, lease_expires_at = now() + (${config.crmImport.leaseSeconds} * interval '1 second'),
        attempt_count = attempt_count + 1, status = CASE WHEN status = 'CONFIRMED' THEN 'PROCESSING' WHEN status = 'PREVIEW_QUEUED' THEN 'PREVIEWING' ELSE status END,
        updated_at = now()
      WHERE id = ${row.id}
      RETURNING *
    `;
    return claimed;
  });
}

async function processNext(db = crmSql, schools = schoolSql) {
  const batch = await claim(db);
  if (!batch) return false;
  try {
    const scope = await revalidateActor(batch);
    if (batch.status === 'PARSING') await parseStored(db, batch);
    else if (batch.status === 'PREVIEWING' || batch.status === 'PREVIEW_QUEUED') await previewStored(db, schools, scope, batch);
    else if (batch.status === 'PROCESSING' || batch.status === 'CONFIRMED') await executeStored(db, schools, scope, batch);
  } catch (err) {
    await db`
      UPDATE crm_import_batches SET status = 'FAILED', last_error = ${err.code || 'PROCESSING_RETRYABLE'}, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ${batch.id} AND lease_token = ${batch.lease_token}
    `.catch(() => {});
  }
  return true;
}

async function tick() {
  if (running || !config.crmDatabaseUrl || !config.crmFeatures.importPreview) return;
  running = true;
  try {
    const [exists] = await crmSql`SELECT to_regclass('public.crm_import_batches') AS name`;
    if (!exists?.name) return;
    for (let i = 0; i < 5; i += 1) if (!(await processNext())) break;
  } catch (err) {
    console.error(JSON.stringify({ component: 'crm_import_worker', event: 'tick_failed', code: err.code || 'WORKER_FAILED' }));
  } finally {
    running = false;
  }
}

function startImportWorker() {
  if (!config.crmImport.workerEnabled || timer) return;
  timer = setInterval(tick, config.crmImport.workerIntervalMs);
  timer.unref?.();
  tick();
}

function stopImportWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startImportWorker, stopImportWorker, processNext, claim, revalidateActor, workerId };

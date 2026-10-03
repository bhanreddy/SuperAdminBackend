const express = require('express');
const multer = require('multer');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const sql = require('../../config/db');
const { authenticateUser, requirePermission, requireSchoolAccess } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');
const { getClusterServiceClient } = require('../../utils/clusterClient');
const { sendResponse } = require('../../utils/apiResponse');
const { safeDownloadName } = require('../../utils/uploadBytes');
const { logAudit } = require('../../services/auditLogger');
const {
  ensureSchoolConfigurationSchema,
  getDraft,
  seedDraftFromSchool,
  saveDraft,
  assetMap,
  attachAsset,
  requestPackage,
  retryJob,
  getRevision,
  listRevisions,
  diffRevisions,
  sha256,
} = require('../../services/schoolConfiguration');
const { effectiveConfig, collectBlockers, publicClusterSnapshot, ASSET_SLOTS } = require('../../services/schoolConfigSchema');
const { processImageSlot, deriveVariants } = require('../../services/schoolAssetProcessor');
const { snippetFromDraft, stripGoogleServices, assertPlist } = require('../../services/schoolPackageRender');
const { storedLibrary } = require('../../services/schoolLibrary');
const { supabaseStorage, BUCKET } = require('../../services/schoolPackageWorker');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const router = express.Router({ mergeParams: true });
const storage = supabaseStorage();

router.use('/:id/configuration', authenticateUser);
router.use('/:id/packages', authenticateUser);

const IDENTITY_KEYS = ['official_name', 'school_code', 'address', 'contact_phone', 'contact_email', 'android_package', 'ios_bundle_id', 'primary'];

async function locate(id, clusterId) {
  if (!clusterId) {
    const error = new Error('cluster_id is required');
    error.status = 400;
    error.code = 'CLUSTER_REQUIRED';
    throw error;
  }
  try {
    const client = await getClusterServiceClient(clusterId, 'school');
    const { data } = await client.from('schools').select('*').eq('id', id).maybeSingle();
    if (!data) return { school: null, client: null, cluster_id: clusterId };
    if (data.cluster_id && data.cluster_id !== clusterId) {
      return { mismatch: true, school: data, client, cluster_id: clusterId };
    }
    return { school: data, client, cluster_id: clusterId };
  } catch (err) {
    return { school: null, client: null, cluster_id: clusterId };
  }
}

function sendKnownError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[school-config]', err);
  return res.status(status).json({
    error: status >= 500 ? 'School configuration request failed' : err.message,
    code: err.code || 'CONFIG_ERROR',
    blockers: err.blockers || undefined,
  });
}

async function loadCluster(clusterId) {
  const { data, error } = await schoolSupabaseAdmin
    .from('clusters')
    .select('cluster_id, school_backend_url, school_supabase_url, school_anon_key')
    .eq('cluster_id', clusterId)
    .maybeSingle();
  if (error || !data) {
    const err = new Error('Assigned cluster not found');
    err.status = 404;
    err.code = 'CLUSTER_NOT_FOUND';
    throw err;
  }
  return data;
}

async function ensureDraft(clusterId, school, userId) {
  await ensureSchoolConfigurationSchema(sql);
  const existing = await getDraft(sql, clusterId, school.id);
  if (existing) return existing;
  return seedDraftFromSchool(sql, { clusterId, school, userId, origin: 'backfill' });
}

function readiness(draft, assets, cluster) {
  const blockers = collectBlockers({ ...draft.config, origin: draft.origin }, assets, publicClusterSnapshot(cluster));
  const platforms = draft.config.platforms || [];
  const platformState = {};
  for (const platform of ['android', 'ios', 'web']) {
    const own = blockers.filter((item) => item.platform === platform);
    const selected = platforms.includes(platform);
    platformState[platform] = !selected
      ? { status: 'unselected' }
      : own.length
        ? { status: 'blocked', missing: own.map((item) => item.field) }
        : { status: 'ready' };
  }
  return {
    status: blockers.length ? 'incomplete' : 'ready',
    blockers,
    platforms: platformState,
    onboarding_status_independent: true,
  };
}

async function presentDraft(draft, cluster) {
  const assets = await assetMap(sql, draft.cluster_id, draft.school_id, draft.asset_ids || {});
  const presence = Object.fromEntries(Object.entries(assets).map(([slot, row]) => [slot, Boolean(row)]));
  const model = effectiveConfig({ ...draft.config, origin: draft.origin });
  const revisions = await listRevisions(sql, draft.cluster_id, draft.school_id);
  const [latestJob] = await sql`
    SELECT id, revision, status, attempt_count, max_attempts, error, created_at, updated_at
    FROM school_package_jobs
    WHERE cluster_id = ${draft.cluster_id} AND school_id = ${draft.school_id}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return {
    cluster_id: draft.cluster_id,
    school_id: draft.school_id,
    version: draft.version,
    origin: draft.origin,
    config: draft.config,
    suggestions: model.suggestions,
    preview: model.config,
    assets: Object.fromEntries(Object.entries(assets).filter(([, row]) => row).map(([slot, row]) => [slot, {
      id: row.id,
      sha256: row.sha256,
      mime: row.mime,
      width: row.width,
      height: row.height,
    }])),
    readiness: readiness(draft, presence, cluster),
    library: await storedLibrary(sql, draft.cluster_id, draft.school_id),
    latest_revision: revisions[0] || null,
    latest_job: latestJob || null,
  };
}

async function writeThrough(client, schoolId, config) {
  const primary = {
    name: config.official_name,
    code: config.school_code,
    address: config.address || null,
    android_package: config.android_package || null,
    ios_bundle_id: config.ios_bundle_id || null,
    primary_color: config.primary || null,
  };
  const updated = await client.from('schools').update(primary).eq('id', schoolId).select().single();
  if (updated.error) {
    if (updated.error.code === '23505') {
      const error = new Error('School code already exists');
      error.status = 409;
      error.code = 'DUPLICATE_CODE';
      throw error;
    }
    throw updated.error;
  }
  await client.from('schools').update({
    contact_phone: config.contact_phone || null,
    contact_email: config.contact_email || null,
  }).eq('id', schoolId);
  return updated.data;
}

router.get('/:id/configuration', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const located = await locate(req.params.id, req.query.cluster_id);
    if (located.mismatch) return res.status(409).json({ error: 'School cluster does not match cluster_id', code: 'CLUSTER_MISMATCH' });
    if (!located.school) return res.status(404).json({ error: 'School not found' });
    const cluster = await loadCluster(located.cluster_id);
    const draft = await ensureDraft(located.cluster_id, located.school, req.user.id);
    return sendResponse(res, 200, await presentDraft(draft, cluster));
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.put('/:id/configuration', requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('id'), async (req, res) => {
  try {
    const located = await locate(req.params.id, req.query.cluster_id);
    if (located.mismatch) return res.status(409).json({ error: 'School cluster does not match cluster_id', code: 'CLUSTER_MISMATCH' });
    if (!located.school) return res.status(404).json({ error: 'School not found' });
    const patch = req.body?.config || {};
    const touchesIdentity = IDENTITY_KEYS.some((key) => patch[key] !== undefined);
    if (touchesIdentity && !req.user.isFounder && !req.user.permissions?.includes(PERMISSIONS.SCHOOLS_UPDATE_ASSIGNED) && !req.user.permissions?.includes(PERMISSIONS.SCHOOLS_UPDATE_ALL)) {
      return res.status(403).json({ error: 'Updating school identity requires school update permission', code: 'SCHOOL_UPDATE_REQUIRED' });
    }
    await ensureDraft(located.cluster_id, located.school, req.user.id);
    const saved = await saveDraft(sql, {
      clusterId: located.cluster_id,
      schoolId: located.school.id,
      expectedVersion: req.body?.expected_version,
      patch,
      isFounder: Boolean(req.user.isFounder),
      userId: req.user.id,
    });
    if (touchesIdentity) await writeThrough(located.client, located.school.id, saved.config);
    await logAudit({
      userId: req.user.id,
      action: 'CONFIG_DRAFT_SAVED',
      entity: 'SCHOOL_CONFIG',
      entityId: located.school.id,
      schoolId: located.school.id,
      details: { cluster_id: located.cluster_id, version: saved.version },
    });
    const cluster = await loadCluster(located.cluster_id);
    return sendResponse(res, 200, await presentDraft(saved, cluster));
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.post('/:id/configuration/assets', requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('id'), upload.single('file'), async (req, res) => {
  try {
    const located = await locate(req.params.id, req.query.cluster_id);
    if (!located.school || located.mismatch) return res.status(located.mismatch ? 409 : 404).json({ error: 'School not found for this cluster', code: located.mismatch ? 'CLUSTER_MISMATCH' : 'NOT_FOUND' });
    const slot = String(req.body.slot || '');
    if (!ASSET_SLOTS.includes(slot)) return res.status(400).json({ error: 'Unknown asset slot', code: 'UNKNOWN_SLOT' });
    if (!req.file) return res.status(400).json({ error: 'File is required', code: 'FILE_REQUIRED' });
    const draft = await ensureDraft(located.cluster_id, located.school, req.user.id);
    const preview = effectiveConfig({ ...draft.config, origin: draft.origin }).config;
    let processed;
    let mime = req.file.mimetype;
    if (slot === 'google_services') {
      processed = { buffer: stripGoogleServices(req.file.buffer, preview.android_package), mime: 'application/json', width: null, height: null };
      mime = 'application/json';
    } else if (slot === 'google_service_info_plist') {
      processed = { buffer: assertPlist(req.file.buffer, preview.ios_bundle_id || preview.android_package), mime: 'application/xml', width: null, height: null };
      mime = 'application/xml';
    } else {
      let crop = null;
      if (req.body.crop) {
        try { crop = JSON.parse(req.body.crop); } catch (err) { crop = null; }
      }
      processed = await processImageSlot(req.file.buffer, req.file.mimetype, slot, crop);
      mime = processed.mime;
    }
    const digest = sha256(processed.buffer);
    const ext = mime === 'application/json' ? 'json' : mime === 'application/xml' ? 'plist' : 'png';
    const objectPath = `${located.cluster_id}/${located.school.id}/assets/${slot}/${digest}.${ext}`;
    await storage.put(objectPath, processed.buffer, mime);
    const attached = await attachAsset(sql, {
      clusterId: located.cluster_id,
      schoolId: located.school.id,
      slot,
      storagePath: objectPath,
      sha256: digest,
      mime,
      width: processed.width,
      height: processed.height,
      byteSize: processed.buffer.length,
      userId: req.user.id,
      expectedVersion: req.body.expected_version,
    });
    if (slot === 'app_icon') {
      const variants = await deriveVariants(processed.buffer);
      let version = attached.draft.version;
      for (const [variantSlot, variant] of Object.entries(variants)) {
        if (attached.draft.asset_ids?.[variantSlot] && variantSlot !== 'favicon') continue;
        const variantDigest = sha256(variant.buffer);
        const variantPath = `${located.cluster_id}/${located.school.id}/assets/${variantSlot}/${variantDigest}.png`;
        await storage.put(variantPath, variant.buffer, 'image/png');
        const saved = await attachAsset(sql, {
          clusterId: located.cluster_id,
          schoolId: located.school.id,
          slot: variantSlot,
          storagePath: variantPath,
          sha256: variantDigest,
          mime: 'image/png',
          width: variant.width,
          height: variant.height,
          byteSize: variant.buffer.length,
          userId: req.user.id,
          derivedFrom: attached.asset.id,
          expectedVersion: version,
        });
        version = saved.draft.version;
      }
    }
    await logAudit({
      userId: req.user.id,
      action: 'CONFIG_ASSET_UPLOADED',
      entity: 'SCHOOL_CONFIG',
      entityId: located.school.id,
      schoolId: located.school.id,
      details: { cluster_id: located.cluster_id, slot, sha256: digest },
    });
    const fresh = await getDraft(sql, located.cluster_id, located.school.id);
    return sendResponse(res, 201, { asset_id: attached.asset.id, version: fresh.version, slot });
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.get('/:id/configuration/assets/:assetId', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const clusterId = req.query.cluster_id;
    if (!clusterId) return res.status(400).json({ error: 'cluster_id is required', code: 'CLUSTER_REQUIRED' });
    const [row] = await sql`
      SELECT storage_path, mime FROM school_config_assets
      WHERE id = ${req.params.assetId} AND cluster_id = ${clusterId} AND school_id = ${Number(req.params.id)}
    `;
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    const body = await storage.get(row.storage_path);
    if (!body) return res.status(404).json({ error: 'Asset bytes not found' });
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.send(body);
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.post('/:id/configuration/validate', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const located = await locate(req.params.id, req.query.cluster_id);
    if (!located.school) return res.status(404).json({ error: 'School not found' });
    const cluster = await loadCluster(located.cluster_id);
    const draft = await ensureDraft(located.cluster_id, located.school, req.user.id);
    const assets = await assetMap(sql, located.cluster_id, located.school.id, draft.asset_ids || {});
    const presence = Object.fromEntries(Object.entries(assets).map(([slot, row]) => [slot, Boolean(row)]));
    return sendResponse(res, 200, readiness(draft, presence, cluster));
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.get('/:id/configuration/revisions/:revision/diff', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const clusterId = req.query.cluster_id;
    const against = Number(req.query.against || Number(req.params.revision) - 1);
    const left = await getRevision(sql, clusterId, req.params.id, against);
    const right = await getRevision(sql, clusterId, req.params.id, req.params.revision);
    if (!left || !right) return res.status(404).json({ error: 'Revision not found' });
    return sendResponse(res, 200, diffRevisions(left, right));
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.post('/:id/packages', requirePermission(PERMISSIONS.BUILDS_TRIGGER), requireSchoolAccess('id'), async (req, res) => {
  try {
    const located = await locate(req.params.id, req.query.cluster_id);
    if (!located.school || located.mismatch) return res.status(located.mismatch ? 409 : 404).json({ error: 'School not found for this cluster' });
    const cluster = await loadCluster(located.cluster_id);
    const draft = await ensureDraft(located.cluster_id, located.school, req.user.id);
    const assets = await assetMap(sql, located.cluster_id, located.school.id, draft.asset_ids || {});
    const presence = Object.fromEntries(Object.entries(assets).map(([slot, row]) => [slot, Boolean(row)]));
    const result = await requestPackage(sql, {
      clusterId: located.cluster_id,
      schoolId: located.school.id,
      userId: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
      note: req.body?.note,
      cluster,
      assetPresence: presence,
    });
    await logAudit({
      userId: req.user.id,
      action: 'PACKAGE_REQUESTED',
      entity: 'SCHOOL_PACKAGE',
      entityId: result.job.id,
      schoolId: located.school.id,
      details: { cluster_id: located.cluster_id, revision: result.job.revision, created: result.created },
    });
    return sendResponse(res, result.created ? 202 : 200, { job_id: result.job.id, revision: result.job.revision, status: result.job.status });
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.get('/:id/packages', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const clusterId = req.query.cluster_id;
    if (!clusterId) return res.status(400).json({ error: 'cluster_id is required', code: 'CLUSTER_REQUIRED' });
    const jobs = await sql`
      SELECT id, revision, status, attempt_count, max_attempts, error, created_at, updated_at
      FROM school_package_jobs
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(req.params.id)}
      ORDER BY created_at DESC
      LIMIT 20
    `;
    const artifacts = await sql`
      SELECT id, revision, sha256, byte_size, file_name, created_at
      FROM school_package_artifacts
      WHERE cluster_id = ${clusterId} AND school_id = ${Number(req.params.id)}
      ORDER BY revision DESC
    `;
    return sendResponse(res, 200, { jobs, artifacts });
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.get('/:id/packages/jobs/:jobId', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const [job] = await sql`
      SELECT id, revision, status, attempt_count, max_attempts, error, created_at, updated_at
      FROM school_package_jobs
      WHERE id = ${req.params.jobId} AND cluster_id = ${req.query.cluster_id} AND school_id = ${Number(req.params.id)}
    `;
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return sendResponse(res, 200, job);
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.post('/:id/packages/jobs/:jobId/retry', requirePermission(PERMISSIONS.BUILDS_TRIGGER), requireSchoolAccess('id'), async (req, res) => {
  try {
    const job = await retryJob(sql, { clusterId: req.query.cluster_id, schoolId: req.params.id, jobId: req.params.jobId });
    return sendResponse(res, 202, { job_id: job.id, revision: job.revision, status: job.status });
  } catch (err) {
    return sendKnownError(res, err);
  }
});

router.get('/:id/packages/:artifactId/download', requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const clusterId = req.query.cluster_id;
    const [artifact] = await sql`
      SELECT * FROM school_package_artifacts
      WHERE id = ${req.params.artifactId} AND cluster_id = ${clusterId} AND school_id = ${Number(req.params.id)}
    `;
    if (!artifact) return res.status(404).json({ error: 'Package not found' });
    const body = await storage.get(artifact.storage_path);
    if (!body) return res.status(404).json({ error: 'Package bytes not found' });
    await logAudit({
      userId: req.user.id,
      action: 'PACKAGE_DOWNLOADED',
      entity: 'SCHOOL_PACKAGE',
      entityId: artifact.id,
      schoolId: Number(req.params.id),
      details: { cluster_id: clusterId, revision: artifact.revision, sha256: artifact.sha256 },
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(artifact.file_name)}"`);
    return res.send(body);
  } catch (err) {
    return sendKnownError(res, err);
  }
});

async function buildConfigFromDraft(school, clusterId) {
  try {
    await ensureSchoolConfigurationSchema(sql);
    const draft = await getDraft(sql, clusterId, school.id);
    if (!draft) return null;
    const cluster = await loadCluster(clusterId);
    const assets = await assetMap(sql, clusterId, school.id, draft.asset_ids || {});
    const presence = Object.fromEntries(Object.entries(assets).map(([slot, row]) => [slot, Boolean(row)]));
    const snippet = snippetFromDraft({ ...draft.config, origin: draft.origin }, { ...school, cluster_id: clusterId }, cluster);
    return {
      ...snippet,
      configuration_version: draft.version,
      readiness: readiness(draft, presence, cluster),
    };
  } catch (err) {
    console.error('[school-config] build-config fallback:', err.message);
    return null;
  }
}

module.exports = router;
module.exports.buildConfigFromDraft = buildConfigFromDraft;
module.exports.BUCKET = BUCKET;

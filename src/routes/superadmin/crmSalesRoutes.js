const crmSql = require('../../config/crmDb');
const schoolSql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { resolveCrmScope, assertCrmWrite, assertPlatform } = require('../../services/crm/accessPolicy');
const { sendCrmError } = require('../../services/crm/errors');
const sales = require('../../services/crm/salesCrm');
const { safeDownloadName } = require('../../utils/uploadBytes');
const { salesReport } = require('../../services/crm/reporting');
const catalog = require('../../services/crm/catalog');
const { startOnboarding, retryOnboarding, syncActivation } = require('../../services/crm/onboarding');
const { syncFounderDirectory } = require('../../services/crm/founderSync');
const { reserveClusterCapacity, consumeClusterCapacity } = require('../../services/crm/capacity');
const { getClusterServiceClient } = require('../../utils/clusterClient');
const { readSchoolReadiness, provisionFirstAdmin } = require('../../services/schoolProvisioning');
const config = require('../../config/env');
const pilots = require('../../services/crm/pilots');

function provisionerFor(req) {
  if (req.app.locals.crmProvisioner) return req.app.locals.crmProvisioner;
  return {
    reserveCapacity: (input) => reserveClusterCapacity(schoolSql, crmSql, input),
    consumeCapacity: ({ operationId }) => consumeClusterCapacity(crmSql, operationId),
    async findByCorrelation(clusterId, correlationKey) {
      const client = await getClusterServiceClient(clusterId, 'school');
      const { data, error } = await client.from('schools').select('id, cluster_id, onboarding_status, crm_correlation_key').eq('crm_correlation_key', correlationKey).maybeSingle();
      if (error) throw error;
      return data ? { ...data, cluster_id: data.cluster_id || clusterId } : null;
    },
    async createSchool(input) {
      const client = await getClusterServiceClient(input.clusterId, 'school');
      const { data, error } = await client.from('schools').insert({
        name: input.name,
        code: input.code,
        address: input.address,
        logo_url: input.logo_url,
        cluster_id: input.clusterId,
        android_package: input.android_package,
        ios_bundle_id: input.ios_bundle_id,
        primary_color: input.primary_color,
        onboarding_status: 'pending_build',
        crm_correlation_key: input.correlationKey,
      }).select('id, cluster_id, onboarding_status').single();
      if (error) throw error;
      return { id: data.id, cluster_id: data.cluster_id || input.clusterId, onboarding_status: data.onboarding_status || 'pending_build' };
    },
    async seedDefaults(clusterId, schoolId) {
      const client = await getClusterServiceClient(clusterId, 'school');
      const { error } = await client.rpc('seed_school_defaults', { p_school_id: schoolId });
      if (error) return { ok: false, error: 'School defaults could not be seeded' };
      return { ok: true };
    },
    async createFirstAdmin(clusterId, schoolId, admin) {
      const client = await getClusterServiceClient(clusterId, 'school');
      return provisionFirstAdmin(client, schoolId, admin);
    },
    async readiness(clusterId, schoolId) {
      const client = await getClusterServiceClient(clusterId, 'school');
      return readSchoolReadiness(client, schoolId);
    },
  };
}

function mountSalesRoutes(router) {
  const guard = (handler, { write = false, platform = false } = {}) => async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      if (write) assertCrmWrite(scope);
      if (platform) assertPlatform(scope);
      await handler(req, res, scope);
    } catch (err) {
      return sendCrmError(res, err, { path: req.path });
    }
  };

  router.get('/leads', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.listLeads(crmSql, scope, req.query));
  }));
  router.get('/leads/:id', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.getLead(crmSql, scope, req.params.id));
  }));
  router.post('/leads/:id/stage', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.moveStage(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/owner', guard(async (req, res, scope) => {
    await syncFounderDirectory(schoolSql, crmSql);
    return sendResponse(res, 200, await sales.assignOwner(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/territory', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.setTerritory(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/source', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.correctSource(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/activities', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.logActivity(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/tasks', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.createTask(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/tasks/:taskId/complete', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.completeTask(crmSql, scope, req.params.id, req.params.taskId, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/tasks/:taskId/reopen', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.reopenTask(crmSql, scope, req.params.id, req.params.taskId, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/pilots', guard(async (req, res, scope) => {
    if (!config.crmFeatures.pilotWrite) return res.status(404).json({ error: 'Pilot commands are not enabled', code: 'FEATURE_DISABLED' });
    return sendResponse(res, 201, await pilots.createPilot(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/pilots/:id/transition', guard(async (req, res, scope) => {
    if (!config.crmFeatures.pilotWrite) return res.status(404).json({ error: 'Pilot commands are not enabled', code: 'FEATURE_DISABLED' });
    return sendResponse(res, 200, await pilots.transitionPilot(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.patch('/pilots/:id', guard(async (req, res, scope) => {
    if (!config.crmFeatures.pilotWrite) return res.status(404).json({ error: 'Pilot commands are not enabled', code: 'FEATURE_DISABLED' });
    return sendResponse(res, 200, await pilots.patchPilot(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/review-queue/:id/resolve', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.resolveReview(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/close', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.closeLead(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/reopen', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.reopenLead(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/demos', guard(async (req, res, scope) => {
    return sendResponse(res, 201, await sales.scheduleDemo(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/demos/:id/reschedule', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.rescheduleDemo(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/demos/:id/finish', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.finishDemo(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/leads/:id/proposals', guard(async (req, res, scope) => {
    return sendResponse(res, 201, await sales.createProposal(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/proposals/:id/revise', guard(async (req, res, scope) => {
    return sendResponse(res, 201, await sales.reviseProposal(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/proposal-versions/:id/transition', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.transitionProposal(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.post('/proposal-versions/:id/documents', guard(async (req, res, scope) => {
    return sendResponse(res, 201, await sales.attachDocument(crmSql, scope, req.params.id, req.body || {}));
  }, { write: true }));
  router.get('/documents/:id', guard(async (req, res, scope) => {
    const doc = await sales.readDocument(crmSql, scope, req.params.id);
    const type = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'].includes(doc.content_type)
      ? doc.content_type
      : 'application/octet-stream';
    res.set('Content-Type', type);
    res.set('Content-Disposition', `attachment; filename="${safeDownloadName(doc.filename)}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).send(Buffer.from(doc.body));
  }));
  router.get('/work', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await sales.listWork(crmSql, scope, req.query));
  }));
  router.get('/reports/sales', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await salesReport(crmSql, scope, req.query));
  }));
  router.get('/review-queue', guard(async (req, res) => {
    const rows = await crmSql`
      SELECT id, enquiry_id, account_id, reason, status, created_at
      FROM crm_review_queue
      WHERE status = 'OPEN'
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return sendResponse(res, 200, rows);
  }, { platform: true }));
  router.get('/catalog', guard(async (req, res, scope) => {
    const listed = await catalog.listCatalog(crmSql, scope);
    return sendResponse(res, 200, {
      ...listed,
      sales_command: {
        read_enabled: config.crmFeatures.salesCommandRead === true,
        pilot_write_enabled: config.crmFeatures.pilotWrite === true,
        rule_version: 1,
        scope: scope.kind,
      },
    });
  }));
  router.post('/catalog/territories', guard(async (req, res, scope) => {
    return sendResponse(res, 201, await catalog.createTerritory(crmSql, scope, req.body || {}));
  }, { write: true, platform: true }));
  router.post('/catalog/territories/:id/members', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await catalog.addTerritoryMember(crmSql, scope, req.params.id, req.body.founder_id));
  }, { write: true, platform: true }));
  router.post('/catalog/channels/:id/archive', guard(async (req, res, scope) => {
    return sendResponse(res, 200, await catalog.archiveDefinition(crmSql, scope, 'crm_acquisition_channels', 'id', req.params.id));
  }, { write: true, platform: true }));
  router.post('/founders/sync', guard(async (req, res) => {
    return sendResponse(res, 200, await syncFounderDirectory(schoolSql, crmSql));
  }, { write: true, platform: true }));
  router.post('/onboarding', guard(async (req, res, scope) => {
    const operation = await startOnboarding(crmSql, scope, req.body || {}, provisionerFor(req));
    return sendResponse(res, operation.status === 'SUCCEEDED' ? 200 : 202, publicOperation(operation));
  }, { write: true }));
  router.get('/onboarding/:id', guard(async (req, res, scope) => {
    const [operation] = await crmSql`SELECT * FROM crm_onboarding_operations WHERE id = ${req.params.id}`;
    if (!operation) return res.status(404).json({ error: 'Onboarding operation not found', code: 'NOT_FOUND' });
    const detail = await sales.getLead(crmSql, scope, operation.enquiry_id);
    return sendResponse(res, 200, { operation: publicOperation(operation), lead: detail.lead });
  }));
  router.post('/onboarding/:id/retry', guard(async (req, res, scope) => {
    const operation = await retryOnboarding(crmSql, scope, req.params.id, req.body || {}, provisionerFor(req));
    return sendResponse(res, operation.status === 'SUCCEEDED' ? 200 : 202, publicOperation(operation));
  }, { write: true }));
  router.post('/accounts/:id/sync-activation', guard(async (req, res, scope) => {
    const readiness = req.body?.readiness || req.body || {};
    const provisioner = provisionerFor(req);
    if (!readiness.onboarding_status && provisioner.readiness) {
      const [account] = await crmSql`SELECT * FROM crm_accounts WHERE id = ${req.params.id}`;
      if (account?.cluster_id && account?.external_client_id) {
        const live = await provisioner.readiness(account.cluster_id, account.external_client_id);
        Object.assign(readiness, live || {});
      }
    }
    const result = await syncActivation(crmSql, scope, req.params.id, readiness);
    return sendResponse(res, 200, { account: result.account, decision: result.decision });
  }, { write: true }));
}

function publicOperation(operation) {
  return {
    id: operation.id,
    status: operation.status,
    enquiry_id: operation.enquiry_id,
    account_id: operation.account_id,
    cluster_id: operation.cluster_id,
    target_school_id: operation.target_school_id,
    correlation_key: operation.correlation_key,
    failure_reason: operation.failure_reason,
    attempt_count: operation.attempt_count,
    steps: operation.steps,
    updated_at: operation.updated_at,
  };
}

module.exports = { mountSalesRoutes };

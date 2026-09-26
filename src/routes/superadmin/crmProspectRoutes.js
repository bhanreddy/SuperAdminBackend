const { sendResponse } = require('../../utils/apiResponse');
const { sendCrmError } = require('../../services/crm/errors');
const { resolveCrmScope, assertCrmWrite } = require('../../services/crm/accessPolicy');
const prospects = require('../../services/crm/prospects');
const contacts = require('../../services/crm/contactService');
const sql = require('../../config/crmDb');
const schoolSql = require('../../config/db');

function mountProspectRoutes(router) {
  router.get('/prospects', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await prospects.listProspects(sql, scope, req.query || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/prospects/:accountId', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await prospects.getProspect(sql, scope, req.params.accountId));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/prospects', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      assertCrmWrite(scope);
      const row = await prospects.createProspect(sql, schoolSql, scope, req.body || {});
      return sendResponse(res, 201, row);
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.patch('/prospects/:accountId', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await prospects.patchProspect(sql, scope, req.params.accountId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/prospects/:accountId/enquiries', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 201, await prospects.linkEnquiry(sql, scope, req.params.accountId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.patch('/accounts/:accountId/contacts/:contactId', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await contacts.updateContact(sql, scope, req.params.accountId, req.params.contactId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/accounts/:accountId/contacts/:contactId/archive', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await contacts.archiveContact(sql, scope, req.params.accountId, req.params.contactId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/audit-logs', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const rows = await sql`
        SELECT id, entity_type, action, actor_id, created_at,
          jsonb_build_object(
            'entity_id', metadata->>'entity_id',
            'fields', metadata->'fields',
            'batch_id', metadata->>'batch_id',
            'source', metadata->>'source'
          ) AS metadata
        FROM activity_logs
        WHERE (${scope.kind === 'platform'} OR actor_id = ${scope.actor.id} OR metadata->>'entity_id' IN (
          SELECT id::text FROM crm_accounts WHERE owner_founder_id = ${scope.founderId}
        ))
          AND (${req.query.entity_type || null}::text IS NULL OR entity_type = ${req.query.entity_type || null})
          AND (${req.query.action || null}::text IS NULL OR action = ${req.query.action || null})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return sendResponse(res, 200, { data: rows, source: 'crm' });
    } catch (err) {
      return sendCrmError(res, err);
    }
  });
}

module.exports = { mountProspectRoutes };

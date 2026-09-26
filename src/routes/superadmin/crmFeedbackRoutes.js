const { sendResponse } = require('../../utils/apiResponse');
const { sendCrmError } = require('../../services/crm/errors');
const { resolveCrmScope } = require('../../services/crm/accessPolicy');
const { requireCrmWrite } = require('../../middleware/crmAccess');
const crmSql = require('../../config/crmDb');
const schoolSql = require('../../config/db');
const feedback = require('../../services/crm/fieldFeedback');

function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      return sendCrmError(res, err, { route: 'field_feedback' });
    }
  };
}

function mountFeedbackRoutes(router) {
  router.get('/feedback/access', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.access(crmSql, scope));
  }));

  router.get('/feedback/destinations', guard(async (req, res) => {
    resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.listDestinations(crmSql));
  }));

  router.patch('/feedback/destinations/:key', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.updateDestination(crmSql, scope, req.params.key, req.body || {}));
  }));

  router.get('/feedback/rules', guard(async (req, res) => {
    resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.listRules(crmSql));
  }));

  router.post('/feedback/rules', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 201, await feedback.addRule(crmSql, scope, req.body || {}));
  }));

  router.patch('/feedback/rules/:id', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.updateRule(crmSql, scope, req.params.id, req.body || {}));
  }));

  router.post('/feedback/preview', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.preview(crmSql, scope, req.body || {}));
  }));

  router.post('/feedback', requireCrmWrite, guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    const result = await feedback.createSubmission(crmSql, scope, req.body || {}, schoolSql);
    return sendResponse(res, result.replay ? 200 : 201, result);
  }));

  router.get('/feedback/items', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.listItems(crmSql, scope, req.query || {}));
  }));

  router.get('/feedback/items/:id', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.getItem(crmSql, scope, req.params.id));
  }));

  router.post('/feedback/items/:id/reroute', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.reroute(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.post('/feedback/items/:id/split', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.splitItem(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.post('/feedback/items/:id/status', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.setStatus(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.post('/feedback/items/:id/owner', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.setOwner(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.post('/feedback/items/:id/comments', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 201, await feedback.addComment(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.post('/feedback/items/:id/duplicates', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.linkDuplicate(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.post('/feedback/items/:id/retry-routing', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.retryRouting(crmSql, scope, req.params.id, req.body || {}, schoolSql));
  }));

  router.get('/feedback/attachments/:id', guard(async (req, res) => {
    const scope = resolveCrmScope(req.superAdmin);
    return sendResponse(res, 200, await feedback.readAttachment(crmSql, scope, req.params.id));
  }));
}

module.exports = { mountFeedbackRoutes };

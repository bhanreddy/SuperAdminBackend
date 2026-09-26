const config = require('../../config/env');
const crmSql = require('../../config/crmDb');
const { sendResponse } = require('../../utils/apiResponse');
const { resolveCrmScope } = require('../../services/crm/accessPolicy');
const { sendCrmError, CrmError } = require('../../services/crm/errors');
const salesCommand = require('../../services/crm/salesCommand');

function requireRead() {
  if (!config.crmFeatures.salesCommandRead) {
    throw new CrmError(404, 'Sales Command is not enabled', 'FEATURE_DISABLED');
  }
}

function mountSalesCommandRoutes(router) {
  const guard = (handler) => async (req, res) => {
    const started = Date.now();
    try {
      requireRead();
      const scope = resolveCrmScope(req.superAdmin);
      res.set('Cache-Control', 'private, no-store');
      const body = await handler(req, scope);
      console.log(JSON.stringify({
        component: 'sales_command',
        event: 'read',
        path: req.path,
        metric: req.query?.metric || null,
        scope: scope.kind,
        duration_ms: Date.now() - started,
        status: 200,
      }));
      return sendResponse(res, 200, body);
    } catch (err) {
      console.log(JSON.stringify({
        component: 'sales_command',
        event: 'read_failed',
        path: req.path,
        metric: req.query?.metric || null,
        code: err?.code || 'CRM_INTERNAL',
        duration_ms: Date.now() - started,
      }));
      return sendCrmError(res, err, { path: req.path, metric: req.query?.metric || null });
    }
  };

  router.get('/sales-command/summary', guard((req, scope) => salesCommand.summary(crmSql, scope, req.query)));
  router.get('/sales-command/funnel', guard((req, scope) => salesCommand.funnel(crmSql, scope, req.query)));
  router.get('/sales-command/trends', guard((req, scope) => salesCommand.trends(crmSql, scope, req.query)));
  router.get('/sales-command/aging', guard((req, scope) => salesCommand.aging(crmSql, scope, req.query)));
  router.get('/sales-command/follow-ups', guard((req, scope) => salesCommand.followUps(crmSql, scope, req.query)));
  router.get('/sales-command/attention', guard((req, scope) => salesCommand.attention(crmSql, scope, req.query)));
  router.get('/sales-command/owners', guard((req, scope) => salesCommand.owners(crmSql, scope, req.query)));
  router.get('/sales-command/opportunities', guard((req, scope) => salesCommand.opportunities(crmSql, scope, req.query)));
}

module.exports = { mountSalesCommandRoutes };

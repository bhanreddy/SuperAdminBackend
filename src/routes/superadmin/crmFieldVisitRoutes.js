const express = require('express');
const crmSql = require('../../config/crmDb');
const schoolSql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser } = require('../../middleware/rbac');
const { CrmError, sendCrmError } = require('../../services/crm/errors');
const field = require('../../services/crm/fieldVisits');

const ALLOWED = new Set(['SALES_EXECUTIVE', 'SALES_MANAGER', 'FOUNDER', 'SUPER_ADMIN']);

function fieldScope(user) {
  if (!user?.id) throw new CrmError(401, 'Authentication required', 'UNAUTHENTICATED');
  if (!ALLOWED.has(user.role) && !user.isFounder) {
    throw new CrmError(403, 'Field sales access denied', 'SCOPE_DENIED');
  }
  const platform = Boolean(user.isFounder);
  return {
    kind: platform ? 'platform' : 'owner',
    founderId: user.id,
    canWrite: true,
    actor: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      managerId: user.managerId || null,
    },
  };
}

async function teamIdsFor(user) {
  if (user.isFounder) return null;
  const rows = await schoolSql`
    SELECT id FROM internal_users
    WHERE status = 'ACTIVE' AND (id = ${user.id} OR manager_id = ${user.id})
  `;
  return rows.map((row) => row.id);
}

const router = express.Router();
router.use(authenticateUser);

const guard = (handler) => async (req, res) => {
  try {
    const scope = fieldScope(req.user);
    await handler(req, res, scope);
  } catch (err) {
    return sendCrmError(res, err, { path: req.path });
  }
};

router.post('/day/start', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.startDay(crmSql, scope, req.body || {}));
}));

router.post('/day/end', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.endDay(crmSql, scope, req.body || {}));
}));

router.post('/day/reopen', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.reopenDay(crmSql, scope));
}));

router.get('/home-base', guard(async (req, res, scope) => {
  const id = scope.kind === 'platform' && req.query.executive_id ? req.query.executive_id : scope.founderId;
  const row = await field.getHomeBase(crmSql, id);
  const own = id === scope.founderId;
  return sendResponse(res, 200, field.publicHomeBase(row, { revealCoordinates: own }));
}));

router.put('/home-base', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.setHomeBase(crmSql, scope.founderId, req.body || {}));
}));

router.post('/visits/check-in', guard(async (req, res, scope) => {
  return sendResponse(res, 201, await field.checkIn(crmSql, scope, req.body || {}));
}));

router.get('/visits/:id', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.getVisit(crmSql, scope, req.params.id));
}));

router.patch('/visits/:id', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.updateVisit(crmSql, scope, req.params.id, req.body || {}));
}));

router.post('/visits/:id/complete', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.completeVisit(crmSql, scope, req.params.id, req.body || {}));
}));

router.get('/schools/search', guard(async (req, res) => {
  return sendResponse(res, 200, await field.searchSchoolsForPlan(crmSql, req.query.q));
}));

router.get('/plan', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.getPlan(crmSql, scope, req.query.date));
}));

router.post('/plan/stops', guard(async (req, res, scope) => {
  return sendResponse(res, 201, await field.addPlanStop(crmSql, scope, req.body || {}));
}));

router.delete('/plan/stops/:id', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.removePlanStop(crmSql, scope, req.params.id));
}));

router.get('/today', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.todaySummary(crmSql, scope));
}));

router.post('/schools/duplicates', guard(async (req, res) => {
  return sendResponse(res, 200, await field.findDuplicateSchools(crmSql, req.body || {}));
}));

router.post('/schools', guard(async (req, res, scope) => {
  return sendResponse(res, 201, await field.createUnplannedSchool(crmSql, scope, req.body || {}));
}));

router.put('/schools/:id/profile', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.upsertSalesProfile(crmSql, scope, req.params.id, req.body || {}));
}));

router.post('/schools/:id/contacts', guard(async (req, res, scope) => {
  return sendResponse(res, 201, await field.addDecisionMaker(crmSql, scope, req.params.id, req.body || {}));
}));

router.post('/visits/:id/demo', guard(async (req, res, scope) => {
  return sendResponse(res, 201, await field.recordDemo(crmSql, scope, req.params.id, req.body || {}));
}));

router.post('/visits/:id/skip', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.skipVisit(crmSql, scope, req.params.id, req.body || {}));
}));

router.get('/followups', guard(async (req, res, scope) => {
  return sendResponse(res, 200, await field.listFollowups(crmSql, scope));
}));

router.get('/team', guard(async (req, res, scope) => {
  const ids = await teamIdsFor(req.user);
  return sendResponse(res, 200, await field.teamBoard(crmSql, scope, ids));
}));

router.get('/visits/:id/timeline', guard(async (req, res, scope) => {
  const [visit] = await crmSql`SELECT executive_id FROM sales_visits WHERE id = ${req.params.id}`;
  if (!visit) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && visit.executive_id !== scope.founderId) {
    throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  }
  const rows = await crmSql`SELECT * FROM sales_visit_events WHERE visit_id = ${req.params.id} ORDER BY occurred_at`;
  return sendResponse(res, 200, rows);
}));

module.exports = router;

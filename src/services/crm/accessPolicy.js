const { CrmError } = require('./errors');

/**
 * Platform SuperAdmin sees every CRM record.
 * FOUNDER is limited to records they own. APPROVER may read only their own
 * founder scope and cannot write sales data. A non-super-admin without a
 * founder id fails closed — null is never treated as unrestricted access.
 * Territory membership does not widen this scope.
 */
function resolveCrmScope(actor) {
  if (!actor?.id) throw new CrmError(401, 'Authentication required', 'UNAUTHENTICATED');
  if (actor.isSuperAdmin) {
    return { kind: 'platform', actor, canWrite: true, founderId: actor.founderId || null };
  }
  if (!actor.founderId) {
    throw new CrmError(403, 'CRM access requires an active founder scope', 'SCOPE_REQUIRED');
  }
  if (actor.founderRole === 'APPROVER') {
    return { kind: 'owner', actor, canWrite: false, founderId: actor.founderId };
  }
  if (actor.founderRole === 'FOUNDER') {
    return { kind: 'owner', actor, canWrite: true, founderId: actor.founderId };
  }
  throw new CrmError(403, 'CRM access denied', 'SCOPE_DENIED');
}

function assertCrmWrite(scope) {
  if (!scope?.canWrite) throw new CrmError(403, 'CRM write access requires Founder or Super Admin role', 'WRITE_DENIED');
}

function assertPlatform(scope) {
  if (scope?.kind !== 'platform') throw new CrmError(403, 'This action requires Super Admin', 'PLATFORM_REQUIRED');
}

function assertLeadAccess(scope, lead) {
  if (!lead) throw new CrmError(404, 'Enquiry not found', 'NOT_FOUND');
  if (scope.kind === 'platform') return lead;
  if (lead.assigned_to && lead.assigned_to === scope.founderId) return lead;
  throw new CrmError(404, 'Enquiry not found', 'NOT_FOUND');
}

function assertAccountAccess(scope, account) {
  if (!account) throw new CrmError(404, 'CRM account not found', 'NOT_FOUND');
  if (scope.kind === 'platform') return account;
  if (account.owner_founder_id && account.owner_founder_id === scope.founderId) return account;
  throw new CrmError(404, 'CRM account not found', 'NOT_FOUND');
}

function ownerFilter(scope, columnSql) {
  if (scope.kind === 'platform') return { scoped: false, founderId: null };
  return { scoped: true, founderId: scope.founderId, columnSql };
}

module.exports = {
  resolveCrmScope,
  assertCrmWrite,
  assertPlatform,
  assertLeadAccess,
  assertAccountAccess,
  ownerFilter,
};

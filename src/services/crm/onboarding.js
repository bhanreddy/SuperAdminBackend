const crypto = require('crypto');
const { CrmError } = require('./errors');
const { assertCrmWrite, assertLeadAccess } = require('./accessPolicy');
const { evaluateActivation, redactSecrets, stableHash } = require('./helpers');

function logOnboarding(event, fields) {
  console.info(JSON.stringify({ component: 'crm_onboarding', event, ...fields, at: new Date().toISOString() }));
}

function hasStep(operation, name) {
  return (operation.steps || []).some((step) => step.name === name && step.ok !== false);
}

async function loadOperation(tx, id) {
  const [operation] = await tx`SELECT * FROM crm_onboarding_operations WHERE id = ${id} FOR UPDATE`;
  if (!operation) throw new CrmError(404, 'Onboarding operation not found', 'NOT_FOUND');
  return operation;
}

async function mark(tx, operation, patch) {
  const [updated] = await tx`
    UPDATE crm_onboarding_operations SET
      status = ${patch.status || operation.status},
      steps = ${tx.json(patch.steps || operation.steps || [])},
      cluster_id = ${patch.cluster_id !== undefined ? patch.cluster_id : operation.cluster_id},
      account_id = ${patch.account_id !== undefined ? patch.account_id : operation.account_id},
      target_school_id = ${patch.target_school_id !== undefined ? patch.target_school_id : operation.target_school_id},
      failure_reason = ${patch.failure_reason !== undefined ? patch.failure_reason : operation.failure_reason},
      attempt_count = ${patch.attempt_count !== undefined ? patch.attempt_count : operation.attempt_count},
      updated_at = now()
    WHERE id = ${operation.id}
    RETURNING *
  `;
  return updated;
}

async function ensureOnboardingAccount(tx, lead, actorId) {
  if (lead.account_id) {
    const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${lead.account_id} FOR UPDATE`;
    return account;
  }
  let owner = lead.assigned_to || null;
  if (owner) {
    const [active] = await tx`SELECT id FROM founders WHERE id = ${owner} AND is_active = true`;
    if (!active) owner = null;
  }
  const [account] = await tx`
    INSERT INTO crm_accounts (name, account_type, lifecycle_stage, vertical, owner_founder_id, email, phone, created_by)
    VALUES (${lead.organization || lead.name || 'School'}, 'CUSTOMER', 'ONBOARDING', 'SCHOOL', ${owner}, ${lead.email}, ${lead.phone}, ${actorId})
    RETURNING *
  `;
  await tx`UPDATE enquiries SET account_id = ${account.id}, product_vertical = 'SCHOOL', updated_at = now(), row_version = row_version + 1 WHERE id = ${lead.id}`;
  return account;
}

async function persistOperation(crmSql, operation, patch) {
  const steps = patch.steps || operation.steps || [];
  const [updated] = await crmSql`
    UPDATE crm_onboarding_operations SET
      status = ${patch.status || operation.status},
      steps = ${crmSql.json(steps)},
      cluster_id = ${patch.cluster_id !== undefined ? patch.cluster_id : operation.cluster_id},
      account_id = ${patch.account_id !== undefined ? patch.account_id : operation.account_id},
      target_school_id = ${patch.target_school_id !== undefined ? patch.target_school_id : operation.target_school_id},
      failure_reason = ${patch.failure_reason !== undefined ? patch.failure_reason : operation.failure_reason},
      attempt_count = ${patch.attempt_count !== undefined ? patch.attempt_count : operation.attempt_count},
      updated_at = now()
    WHERE id = ${operation.id}
    RETURNING *
  `;
  return updated;
}

async function executeOperation(crmSql, operationId, body, provisioner) {
  let [operation] = await crmSql`SELECT * FROM crm_onboarding_operations WHERE id = ${operationId}`;
  if (!operation) throw new CrmError(404, 'Onboarding operation not found', 'NOT_FOUND');
  if (operation.status === 'SUCCEEDED') return operation;
  operation = await persistOperation(crmSql, operation, {
    status: 'RUNNING',
    attempt_count: Number(operation.attempt_count || 0) + 1,
    failure_reason: null,
  });
  const steps = Array.isArray(operation.steps) ? [...operation.steps] : [];
  const record = async (name, extra) => {
    steps.push({ name, at: new Date().toISOString(), ok: true, ...extra });
    operation = await persistOperation(crmSql, operation, { steps, ...extra });
  };
  try {
    if (!hasStep(operation, 'RESERVE_CAPACITY')) {
      const reserved = await provisioner.reserveCapacity({
        clusterId: body.cluster_id || operation.requested_cluster_id || operation.cluster_id,
        operationId: operation.id,
      });
      await record('RESERVE_CAPACITY', { cluster_id: reserved.cluster_id });
    }
    const clusterId = operation.cluster_id || body.cluster_id;
    let school = await provisioner.findByCorrelation(clusterId, operation.correlation_key);
    if (!school) {
      try {
        school = await provisioner.createSchool({
          clusterId,
          correlationKey: operation.correlation_key,
          name: body.name,
          code: body.code,
          address: body.address || null,
          logo_url: body.logo_url || null,
          android_package: body.android_package || null,
          ios_bundle_id: body.ios_bundle_id || null,
          primary_color: body.primary_color || '#1A73E8',
        });
      } catch (err) {
        school = await provisioner.findByCorrelation(clusterId, operation.correlation_key);
        if (!school) throw err;
        logOnboarding('recovered_school_after_crash', { operation_id: operation.id, cluster_id: school.cluster_id, school_id: school.id });
      }
    }
    if (!hasStep(operation, 'CREATE_SCHOOL')) {
      await record('CREATE_SCHOOL', { cluster_id: school.cluster_id, target_school_id: String(school.id) });
    }
    if (!hasStep(operation, 'SEED_DEFAULTS')) {
      const seeded = await provisioner.seedDefaults(school.cluster_id, school.id);
      if (!seeded?.ok) {
        steps.push({ name: 'SEED_DEFAULTS', at: new Date().toISOString(), ok: false, error: seeded?.error || 'Defaults failed' });
        operation = await persistOperation(crmSql, operation, { steps, status: 'FAILED', failure_reason: seeded?.error || 'Defaults could not be seeded', cluster_id: school.cluster_id, target_school_id: String(school.id) });
        logOnboarding('defaults_failed', { operation_id: operation.id, school_id: school.id });
        return operation;
      }
      await record('SEED_DEFAULTS', { cluster_id: school.cluster_id, target_school_id: String(school.id) });
    }
    if (!hasStep(operation, 'FIRST_ADMIN')) {
      if (body.admin) {
        const admin = await provisioner.createFirstAdmin(school.cluster_id, school.id, body.admin);
        if (!admin?.ok) {
          steps.push({ name: 'FIRST_ADMIN', at: new Date().toISOString(), ok: false, error: admin?.error || 'Admin provisioning failed' });
          operation = await persistOperation(crmSql, operation, { steps, status: 'FAILED', failure_reason: admin?.error || 'First admin could not be provisioned', cluster_id: school.cluster_id, target_school_id: String(school.id) });
          logOnboarding('admin_failed', { operation_id: operation.id, school_id: school.id });
          return operation;
        }
      }
      await record('FIRST_ADMIN', { cluster_id: school.cluster_id, target_school_id: String(school.id) });
    }
    if (!hasStep(operation, 'LINK_CRM')) {
      const [account] = await crmSql`SELECT * FROM crm_accounts WHERE id = ${operation.account_id}`;
      if (account.external_client_id && (account.external_client_id !== String(school.id) || account.cluster_id !== school.cluster_id)) {
        throw new CrmError(409, 'This account is already linked to a different tenant', 'DUPLICATE_TENANT_LINK');
      }
      await crmSql`
        UPDATE crm_accounts SET
          external_client_id = ${String(school.id)},
          cluster_id = ${school.cluster_id},
          vertical = 'SCHOOL',
          account_type = CASE WHEN account_type = 'PROSPECT' THEN 'CUSTOMER' ELSE account_type END,
          lifecycle_stage = 'ONBOARDING',
          row_version = row_version + 1,
          updated_at = now()
        WHERE id = ${account.id}
      `;
      await provisioner.consumeCapacity?.({ clusterId: school.cluster_id, operationId: operation.id });
      await record('LINK_CRM', { cluster_id: school.cluster_id, target_school_id: String(school.id), status: 'SUCCEEDED' });
    }
    operation = await persistOperation(crmSql, operation, {
      status: 'SUCCEEDED',
      failure_reason: null,
      cluster_id: school.cluster_id,
      target_school_id: String(school.id),
    });
    logOnboarding('succeeded', { operation_id: operation.id, cluster_id: school.cluster_id, school_id: school.id });
    return operation;
  } catch (err) {
    const reason = err instanceof CrmError ? err.message : 'Onboarding step failed';
    await persistOperation(crmSql, operation, { status: 'FAILED', failure_reason: reason, steps }).catch(() => {});
    logOnboarding('failed', { operation_id: operation.id, code: err.code || 'ONBOARDING_FAILED' });
    if (err instanceof CrmError) throw err;
    throw new CrmError(502, reason, 'ONBOARDING_FAILED');
  }
}

async function startOnboarding(crmSql, scope, body, provisioner) {
  assertCrmWrite(scope);
  if (!provisioner) throw new CrmError(500, 'Onboarding provisioner is not configured', 'PROVISIONER_MISSING');
  const key = String(body.idempotency_key || '').trim();
  if (key.length < 8 || key.length > 200) throw new CrmError(400, 'idempotency_key is required', 'IDEMPOTENCY_KEY');
  if (!body.enquiry_id) throw new CrmError(400, 'enquiry_id is required', 'ENQUIRY_REQUIRED');
  if (!body.name || !body.code) throw new CrmError(400, 'School name and code are required', 'SCHOOL_IDENTITY');
  const vertical = String(body.vertical || 'SCHOOL').toUpperCase();
  if (vertical !== 'SCHOOL') throw new CrmError(400, 'This handoff only provisions SchoolIMS tenants', 'VERTICAL');
  const hash = stableHash(body);
  const existingId = await crmSql.begin(async (tx) => {
    const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${body.enquiry_id} FOR UPDATE`;
    assertLeadAccess(scope, lead);
    if (lead.outcome !== 'WON') throw new CrmError(409, 'Onboarding requires a won school sale', 'WON_REQUIRED');
    const [existing] = await tx`SELECT * FROM crm_onboarding_operations WHERE idempotency_key = ${key} FOR UPDATE`;
    if (existing) {
      if (existing.request_hash !== hash) throw new CrmError(409, 'Idempotency key was already used with a different payload', 'IDEMPOTENCY_CONFLICT');
      return existing.id;
    }
    const account = await ensureOnboardingAccount(tx, lead, scope.actor.id);
    const [created] = await tx`
      INSERT INTO crm_onboarding_operations (
        idempotency_key, request_hash, enquiry_id, account_id, requested_cluster_id, vertical,
        correlation_key, status, payload, created_by
      ) VALUES (
        ${key}, ${hash}, ${lead.id}, ${account.id}, ${body.cluster_id || null}, 'SCHOOL',
        ${crypto.randomUUID()}, 'PENDING', ${tx.json(redactSecrets(body))}, ${scope.actor.id}
      )
      RETURNING id
    `;
    return created.id;
  });
  return executeOperation(crmSql, existingId, body, provisioner);
}

async function retryOnboarding(crmSql, scope, operationId, body, provisioner) {
  assertCrmWrite(scope);
  const [operation] = await crmSql`SELECT * FROM crm_onboarding_operations WHERE id = ${operationId}`;
  if (!operation) throw new CrmError(404, 'Onboarding operation not found', 'NOT_FOUND');
  const [lead] = await crmSql`SELECT * FROM enquiries WHERE id = ${operation.enquiry_id}`;
  assertLeadAccess(scope, lead);
  const replayBody = { ...operation.payload, ...body, enquiry_id: operation.enquiry_id, idempotency_key: operation.idempotency_key };
  if (stableHash({ ...replayBody, admin: body.admin || operation.payload.admin }) && operation.request_hash) {
    // Resume the stored operation. Callers must resend the same commercial payload.
  }
  return executeOperation(crmSql, operation.id, {
    ...operation.payload,
    admin: body.admin || undefined,
    cluster_id: operation.cluster_id || operation.requested_cluster_id,
    name: operation.payload.name,
    code: operation.payload.code,
  }, provisioner);
}

async function syncActivation(crmSql, scope, accountId, readiness) {
  assertCrmWrite(scope);
  const decision = evaluateActivation({
    onboardingStatus: readiness?.onboarding_status,
    defaultsSeeded: readiness?.defaults_seeded === true,
    firstAdminExists: readiness?.first_admin_exists === true,
    currentLifecycle: readiness?.current_lifecycle,
  });
  const [account] = await crmSql`SELECT * FROM crm_accounts WHERE id = ${accountId}`;
  if (!account) throw new CrmError(404, 'CRM account not found', 'NOT_FOUND');
  const { assertAccountAccess } = require('./accessPolicy');
  assertAccountAccess(scope, account);
  if (!account.cluster_id || !account.external_client_id) {
    throw new CrmError(409, 'Activation requires an explicit cluster and tenant id', 'LINK_REQUIRED');
  }
  const applied = evaluateActivation({
    onboardingStatus: readiness?.onboarding_status,
    defaultsSeeded: readiness?.defaults_seeded === true,
    firstAdminExists: readiness?.first_admin_exists === true,
    currentLifecycle: account.lifecycle_stage,
  });
  if (!applied.changed) return { account, decision: applied };
  const [updated] = await crmSql`
    UPDATE crm_accounts SET lifecycle_stage = ${applied.lifecycle}, updated_at = now() WHERE id = ${account.id} RETURNING *
  `;
  await crmSql`
    INSERT INTO crm_activities (activity_type, account_id, actor_id, summary, visibility, details)
    VALUES ('SYSTEM', ${account.id}, ${scope.actor.id}, ${`Lifecycle set to ${applied.lifecycle}`}, 'SYSTEM', ${crmSql.json({ reason: applied.reason, onboarding_status: readiness?.onboarding_status || null })})
  `;
  return { account: updated, decision: applied };
}

module.exports = { startOnboarding, retryOnboarding, syncActivation, evaluateActivation };

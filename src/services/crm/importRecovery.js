const { CrmError } = require('./errors');
const { assertCrmWrite, assertPlatform } = require('./accessPolicy');
const { writeAudit } = require('./contactService');

async function planCompensation(crmSql, scope, batchId) {
  assertCrmWrite(scope);
  assertPlatform(scope);
  const rows = await crmSql`
    SELECT id, row_number, result_status, result, target_account_id, provenance
    FROM crm_import_rows WHERE batch_id = ${batchId} AND result_status = 'APPLIED'
  `;
  const plan = [];
  for (const row of rows) {
    const accountId = row.result?.account_id || row.target_account_id;
    if (!accountId) {
      plan.push({ row_id: row.id, action: 'skip', reason: 'no_target' });
      continue;
    }
    const [account] = await crmSql`SELECT id, row_version, lifecycle_stage, external_client_id FROM crm_accounts WHERE id = ${accountId}`;
    const [activity] = await crmSql`
      SELECT COUNT(*)::int AS count FROM crm_activities
      WHERE account_id = ${accountId} AND summary NOT LIKE 'Research imported school%' AND occurred_at > (
        SELECT created_at FROM crm_import_batches WHERE id = ${batchId}
      )
    `;
    const [proposal] = await crmSql`SELECT COUNT(*)::int AS count FROM crm_proposals p JOIN enquiries e ON e.id = p.enquiry_id WHERE e.account_id = ${accountId}`;
    if (!account) plan.push({ row_id: row.id, action: 'skip', reason: 'missing_account' });
    else if (account.external_client_id || account.lifecycle_stage === 'ACTIVE' || activity.count || proposal.count) {
      plan.push({ row_id: row.id, account_id: account.id, action: 'escalate', reason: 'later_activity' });
    } else if (account.row_version !== Number(row.result?.applied_version || row.target_version || account.row_version)) {
      plan.push({ row_id: row.id, account_id: account.id, action: 'escalate', reason: 'version_moved' });
    } else plan.push({ row_id: row.id, account_id: account.id, action: 'archive', reason: 'unused_import' });
  }
  return { batch_id: batchId, dry_run: true, plan };
}

async function compensate(crmSql, scope, batchId, body = {}) {
  const planned = await planCompensation(crmSql, scope, batchId);
  if (body.apply !== true) return planned;
  const applied = [];
  for (const item of planned.plan) {
    if (item.action !== 'archive') {
      applied.push(item);
      continue;
    }
    await crmSql.begin(async (tx) => {
      const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${item.account_id} FOR UPDATE`;
      if (!account || account.external_client_id || account.archived_at) {
        applied.push({ ...item, action: 'escalate', reason: 'changed_before_archive' });
        return;
      }
      await tx`UPDATE crm_accounts SET archived_at = now() WHERE id = ${account.id}`;
      await writeAudit(tx, scope.actor, 'crm_account', 'COMPENSATE_ARCHIVE', account.id, { batch_id: batchId, row_id: item.row_id });
      applied.push({ ...item, action: 'archived' });
    });
  }
  return { batch_id: batchId, dry_run: false, plan: applied };
}

async function purgeExpiredFiles(crmSql) {
  const rows = await crmSql`
    DELETE FROM crm_import_files
    WHERE batch_id IN (SELECT id FROM crm_import_batches WHERE retention_expires_at < now())
    RETURNING batch_id
  `;
  return { purged: rows.length };
}

module.exports = { planCompensation, compensate, purgeExpiredFiles };

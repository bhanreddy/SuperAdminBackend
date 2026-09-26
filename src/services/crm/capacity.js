const { CrmError } = require('./errors');

async function reserveClusterCapacity(schoolSql, crmSql, { clusterId, operationId }) {
  const [existing] = await crmSql`SELECT * FROM crm_capacity_reservations WHERE operation_id = ${operationId}`;
  if (existing && existing.state !== 'RELEASED') return existing;
  if (!clusterId) throw new CrmError(400, 'cluster_id is required to reserve capacity', 'CLUSTER_REQUIRED');
  const [updated] = await schoolSql`
    UPDATE clusters
    SET school_count = school_count + 1
    WHERE cluster_id = ${clusterId}
      AND status = 'active'
      AND school_count < COALESCE(max_schools, 40)
    RETURNING cluster_id, school_count
  `;
  if (!updated) throw new CrmError(503, 'Selected cluster is at capacity', 'CLUSTER_CAPACITY');
  await crmSql`
    INSERT INTO crm_capacity_reservations (operation_id, cluster_id, state)
    VALUES (${operationId}, ${updated.cluster_id}, 'RESERVED')
    ON CONFLICT (operation_id) DO NOTHING
  `;
  const [row] = await crmSql`SELECT * FROM crm_capacity_reservations WHERE operation_id = ${operationId}`;
  return row;
}

async function consumeClusterCapacity(crmSql, operationId) {
  await crmSql`
    UPDATE crm_capacity_reservations
    SET state = 'CONSUMED', updated_at = now()
    WHERE operation_id = ${operationId} AND state = 'RESERVED'
  `;
}

async function releaseClusterCapacity(schoolSql, crmSql, { clusterId, operationId }) {
  const [existing] = await crmSql`SELECT * FROM crm_capacity_reservations WHERE operation_id = ${operationId}`;
  if (!existing || existing.state !== 'RESERVED') return existing || null;
  await schoolSql`
    UPDATE clusters
    SET school_count = GREATEST(school_count - 1, 0)
    WHERE cluster_id = ${clusterId || existing.cluster_id}
  `;
  const [row] = await crmSql`
    UPDATE crm_capacity_reservations
    SET state = 'RELEASED', updated_at = now()
    WHERE operation_id = ${operationId}
    RETURNING *
  `;
  return row;
}

module.exports = { reserveClusterCapacity, consumeClusterCapacity, releaseClusterCapacity };

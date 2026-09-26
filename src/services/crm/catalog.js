const { CrmError } = require('./errors');
const { assertPlatform } = require('./accessPolicy');

async function listCatalog(crmSql) {
  const [stages, edges, territories, channels, reasons] = await Promise.all([
    crmSql`SELECT * FROM crm_stage_definitions ORDER BY sort_order`,
    crmSql`SELECT * FROM crm_stage_edges WHERE archived_at IS NULL ORDER BY from_code, to_code`,
    crmSql`SELECT * FROM crm_territories ORDER BY name`,
    crmSql`SELECT * FROM crm_acquisition_channels ORDER BY label`,
    crmSql`SELECT * FROM crm_outcome_reasons ORDER BY outcome, code`,
  ]);
  return { stages, edges, territories, channels, reasons };
}

async function createTerritory(crmSql, scope, body) {
  assertPlatform(scope);
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  if (!/^[A-Z0-9_]{2,40}$/.test(code) || name.length < 2) throw new CrmError(400, 'Territory code and name are required', 'BAD_TERRITORY');
  const [row] = await crmSql`
    INSERT INTO crm_territories (code, name) VALUES (${code}, ${name}) RETURNING *
  `;
  return row;
}

async function addTerritoryMember(crmSql, scope, territoryId, founderId) {
  assertPlatform(scope);
  await crmSql`
    INSERT INTO crm_territory_members (territory_id, founder_id) VALUES (${territoryId}, ${founderId})
    ON CONFLICT DO NOTHING
  `;
  return { territory_id: territoryId, founder_id: founderId };
}

async function archiveDefinition(crmSql, scope, table, idColumn, id) {
  assertPlatform(scope);
  const allowed = {
    crm_territories: 'id',
    crm_acquisition_channels: 'id',
    crm_outcome_reasons: 'id',
    crm_stage_definitions: 'code',
  };
  if (allowed[table] !== idColumn) throw new CrmError(400, 'Unsupported catalog', 'BAD_CATALOG');
  const rows = await crmSql.unsafe(
    `UPDATE ${table} SET archived_at = now() WHERE ${idColumn} = $1 AND archived_at IS NULL RETURNING *`,
    [id],
  );
  if (!rows.length) throw new CrmError(404, 'Definition not found', 'NOT_FOUND');
  return rows[0];
}

module.exports = { listCatalog, createTerritory, addTerritoryMember, archiveDefinition };

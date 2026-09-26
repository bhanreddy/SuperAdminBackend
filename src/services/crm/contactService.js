const { CrmError } = require('./errors');
const { assertCrmWrite, assertAccountAccess } = require('./accessPolicy');
const { normalizePhone, normalizeEmail, normalizeContact, roleCode } = require('./normalization');
const { ROLE_CODES } = require('./limits');

async function writeAudit(tx, actor, entityType, action, entityId, metadata) {
  await tx`
    INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
    VALUES (${entityType}, ${action}, ${actor?.id || null}, ${tx.json({
      entity_id: entityId,
      ...(metadata || {}),
    })})
  `;
}

async function lockAccount(tx, accountId) {
  const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${accountId} FOR UPDATE`;
  return account;
}

async function projectMethods(tx, contactId) {
  const methods = await tx`
    SELECT * FROM crm_contact_methods
    WHERE contact_id = ${contactId} AND archived_at IS NULL
    ORDER BY is_primary_for_type DESC, created_at
  `;
  const phone = methods.find((item) => item.method_type === 'PHONE' && item.is_primary_for_type)
    || methods.find((item) => item.method_type === 'WHATSAPP' && item.is_primary_for_type)
    || methods.find((item) => item.method_type === 'PHONE');
  const email = methods.find((item) => item.method_type === 'EMAIL' && item.is_primary_for_type)
    || methods.find((item) => item.method_type === 'EMAIL');
  await tx`
    UPDATE crm_contacts SET phone = ${phone?.display_value || null}, email = ${email?.display_value || null}, updated_at = now()
    WHERE id = ${contactId}
  `;
  return methods;
}

async function replaceMethods(tx, contactId, channels, source) {
  await tx`UPDATE crm_contact_methods SET archived_at = now(), is_primary_for_type = false WHERE contact_id = ${contactId} AND archived_at IS NULL`;
  const grouped = new Map();
  for (const channel of channels) {
    const key = `${channel.method_type}:${channel.normalized}:${channel.extension || ''}`;
    if (grouped.has(key)) continue;
    grouped.set(key, channel);
  }
  const seenType = new Set();
  for (const channel of grouped.values()) {
    const primary = !seenType.has(channel.method_type);
    seenType.add(channel.method_type);
    await tx`
      INSERT INTO crm_contact_methods (
        contact_id, method_type, display_value, normalized_value, country_code, extension,
        is_primary_for_type, verification_state, source_type, source_ref
      ) VALUES (
        ${contactId}, ${channel.method_type}, ${channel.display}, ${channel.normalized},
        ${channel.country_code || null}, ${channel.extension || null}, ${primary}, 'UNVERIFIED',
        ${source?.type || null}, ${source?.ref || null}
      )
    `;
  }
  return projectMethods(tx, contactId);
}

function channelsFromContact(contact) {
  return [...(contact.phones || []), ...(contact.emails || []), ...(contact.whatsapp || [])];
}

async function createContact(crmSql, scope, accountId, body, source) {
  assertCrmWrite(scope);
  const normalized = normalizeContact(body, body.country_code || body.country);
  if (!normalized.valid) throw new CrmError(400, 'Contact could not be normalized', 'BAD_CONTACT', { errors: normalized.errors });
  if (normalized.role_code && !ROLE_CODES.includes(normalized.role_code)) {
    throw new CrmError(400, 'Unknown contact role', 'BAD_ROLE');
  }
  return crmSql.begin(async (tx) => {
    const account = await lockAccount(tx, accountId);
    assertAccountAccess(scope, account);
    if (body.is_primary) {
      await tx`UPDATE crm_contacts SET is_primary = false, updated_at = now() WHERE account_id = ${accountId} AND archived_at IS NULL AND is_primary = true`;
    }
    const [created] = await tx`
      INSERT INTO crm_contacts (
        account_id, full_name, name_status, contact_kind, role_title, role_code, is_decision_maker,
        department, preferred_language, notes, is_primary, preferred_channel, created_by, updated_by
      ) VALUES (
        ${accountId}, ${normalized.full_name}, ${normalized.name_status}, ${body.contact_kind === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON'},
        ${normalized.role_title}, ${normalized.role_code}, ${normalized.is_decision_maker}, ${normalized.department},
        ${normalized.preferred_language}, ${normalized.notes}, ${Boolean(body.is_primary)}, ${normalized.preferred_channel},
        ${scope.actor.id}, ${scope.actor.id}
      ) RETURNING *
    `;
    await replaceMethods(tx, created.id, channelsFromContact(normalized), source);
    const [row] = await tx`SELECT * FROM crm_contacts WHERE id = ${created.id}`;
    await writeAudit(tx, scope.actor, 'crm_contact', 'CREATE', row.id, {
      account_id: accountId,
      fields: ['full_name', 'role_code', 'is_primary', 'is_decision_maker'],
      source: source?.type || 'manual',
    });
    return row;
  });
}

async function updateContact(crmSql, scope, accountId, contactId, body) {
  assertCrmWrite(scope);
  const version = Number(body.expected_version);
  if (!Number.isInteger(version) || version < 1) throw new CrmError(400, 'expected_version is required', 'VERSION_REQUIRED');
  return crmSql.begin(async (tx) => {
    const account = await lockAccount(tx, accountId);
    assertAccountAccess(scope, account);
    const [existing] = await tx`SELECT * FROM crm_contacts WHERE id = ${contactId} AND account_id = ${accountId} FOR UPDATE`;
    if (!existing || existing.archived_at) throw new CrmError(404, 'Contact not found', 'NOT_FOUND');
    if (existing.row_version !== version) throw new CrmError(409, 'Contact was updated by someone else', 'VERSION_CONFLICT');
    if (existing.do_not_contact && body.do_not_contact === false && !body.preference_source) {
      throw new CrmError(400, 'Removing do-not-contact requires preference_source', 'PREFERENCE_SOURCE_REQUIRED');
    }
    const role = body.role_code || body.role_title ? roleCode(body.role_code || body.role_title) : null;
    if (body.is_primary) {
      await tx`UPDATE crm_contacts SET is_primary = false WHERE account_id = ${accountId} AND id <> ${contactId} AND archived_at IS NULL AND is_primary = true`;
    }
    const [updated] = await tx`
      UPDATE crm_contacts SET
        full_name = CASE WHEN ${body.full_name !== undefined} THEN ${body.full_name || null} ELSE full_name END,
        name_status = CASE WHEN ${body.name_status !== undefined} THEN ${body.name_status} ELSE name_status END,
        role_code = COALESCE(${role?.role_code || null}, role_code),
        role_title = COALESCE(${role?.role_title || null}, role_title),
        is_decision_maker = CASE WHEN ${body.is_decision_maker !== undefined} THEN ${Boolean(body.is_decision_maker)} ELSE is_decision_maker END,
        is_primary = CASE WHEN ${body.is_primary !== undefined} THEN ${Boolean(body.is_primary)} ELSE is_primary END,
        department = CASE WHEN ${body.department !== undefined} THEN ${body.department || null} ELSE department END,
        preferred_language = CASE WHEN ${body.preferred_language !== undefined} THEN ${body.preferred_language || null} ELSE preferred_language END,
        preferred_channel = CASE WHEN ${body.preferred_channel !== undefined} THEN ${body.preferred_channel || null} ELSE preferred_channel END,
        notes = CASE WHEN ${body.notes !== undefined} THEN ${body.notes || null} ELSE notes END,
        do_not_contact = CASE WHEN ${body.do_not_contact !== undefined} THEN ${Boolean(body.do_not_contact)} ELSE do_not_contact END,
        preference_source = CASE WHEN ${body.preference_source !== undefined} THEN ${body.preference_source || null} ELSE preference_source END,
        preference_at = CASE WHEN ${body.do_not_contact !== undefined} THEN now() ELSE preference_at END,
        updated_by = ${scope.actor.id}
      WHERE id = ${contactId}
      RETURNING *
    `;
    if (body.phone || body.email || body.whatsapp || body.phones || body.emails) {
      const normalized = normalizeContact({ ...existing, ...body, full_name: updated.full_name || 'Kept Name', name_status: 'VERIFIED' }, body.country_code);
      if (!normalized.valid) throw new CrmError(400, 'Contact channels could not be normalized', 'BAD_CONTACT', { errors: normalized.errors });
      await replaceMethods(tx, contactId, channelsFromContact(normalized), { type: 'manual' });
    }
    const [row] = await tx`SELECT * FROM crm_contacts WHERE id = ${contactId}`;
    await writeAudit(tx, scope.actor, 'crm_contact', 'UPDATE', contactId, {
      account_id: accountId,
      fields: Object.keys(body).filter((key) => key !== 'expected_version'),
    });
    return row;
  });
}

async function archiveContact(crmSql, scope, accountId, contactId, body = {}) {
  assertCrmWrite(scope);
  const version = Number(body.expected_version);
  if (!Number.isInteger(version)) throw new CrmError(400, 'expected_version is required', 'VERSION_REQUIRED');
  return crmSql.begin(async (tx) => {
    const account = await lockAccount(tx, accountId);
    assertAccountAccess(scope, account);
    const [existing] = await tx`SELECT * FROM crm_contacts WHERE id = ${contactId} AND account_id = ${accountId} FOR UPDATE`;
    if (!existing) throw new CrmError(404, 'Contact not found', 'NOT_FOUND');
    if (existing.row_version !== version) throw new CrmError(409, 'Contact was updated by someone else', 'VERSION_CONFLICT');
    const [row] = await tx`
      UPDATE crm_contacts SET archived_at = now(), is_primary = false, updated_by = ${scope.actor.id}
      WHERE id = ${contactId} RETURNING *
    `;
    await tx`UPDATE crm_contact_methods SET archived_at = now(), is_primary_for_type = false WHERE contact_id = ${contactId}`;
    await writeAudit(tx, scope.actor, 'crm_contact', 'ARCHIVE', contactId, { account_id: accountId });
    return row;
  });
}

function legacyChannels(body, country) {
  const channels = [];
  if (body.phone) {
    const phone = normalizePhone(body.phone, country);
    if (!phone.ok) throw new CrmError(400, 'Phone could not be normalized', phone.code || 'BAD_CONTACT');
    channels.push({ ...phone, method_type: 'PHONE' });
  }
  if (body.email) {
    const email = normalizeEmail(body.email);
    if (!email.ok) throw new CrmError(400, 'Email could not be normalized', email.code || 'BAD_CONTACT');
    channels.push({ ...email, method_type: 'EMAIL' });
  }
  return channels;
}

module.exports = {
  writeAudit,
  createContact,
  updateContact,
  archiveContact,
  replaceMethods,
  projectMethods,
  legacyChannels,
  channelsFromContact,
};

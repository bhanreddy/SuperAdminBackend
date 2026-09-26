const { CrmError } = require('./errors');
const { assertCrmWrite, assertAccountAccess, assertLeadAccess, assertPlatform } = require('./accessPolicy');
const { normalizeSchool, normalizeContact, strictSchoolName } = require('./normalization');
const { classifyRow } = require('./duplicateDetection');
const { createContact, writeAudit, channelsFromContact, replaceMethods } = require('./contactService');
const { coverage, listActiveClusterIds } = require('./customerDirectory');
const { stableHash } = require('./helpers');
const config = require('../../config/env');
const { enqueueAutomationEvent } = require('../crmAutomation');

function features() {
  return config.crmFeatures;
}

function assertProspectReads() {
  if (!features().prospectReads) throw new CrmError(403, 'School prospect reads are disabled', 'FEATURE_DISABLED');
}

function identityFromSchool(school, groupId) {
  return {
    valid: school.valid,
    invalidReason: school.errors?.[0]?.code || null,
    udise: school.udise_code,
    strict_name: school.school_name_normalized,
    loose_name: school.school_name_loose,
    location_key: school.location.location_key,
    phones: [...school.phones.map((item) => item.normalized), ...school.contacts.flatMap((contact) => contact.phones.map((item) => item.normalized)), ...school.contacts.flatMap((contact) => contact.whatsapp.map((item) => item.normalized))],
    emails: [...school.emails.map((item) => item.normalized), ...school.contacts.flatMap((contact) => contact.emails.map((item) => item.normalized))],
    group_id: groupId,
    forced_conflict: school.forced_conflict || null,
  };
}

async function lookupAccounts(tx, school) {
  const found = new Map();
  const take = (rows) => rows.forEach((row) => found.set(row.id, { ...(found.get(row.id) || {}), ...row, phones: [...new Set([...(found.get(row.id)?.phones || []), ...(row.phones || [])])], emails: [...new Set([...(found.get(row.id)?.emails || []), ...(row.emails || [])])] }));
  if (school.udise_code) {
    const rows = await tx`
      SELECT a.id, a.owner_founder_id, a.account_type, a.lifecycle_stage, a.cluster_id, a.external_client_id, a.row_version,
        p.udise_code AS udise, p.school_name_normalized AS strict_name, p.school_name_loose AS loose_name, p.location_key,
        p.organization_phone_normalized, p.organization_email_normalized
      FROM crm_accounts a
      JOIN crm_school_profiles p ON p.account_id = a.id
      WHERE a.archived_at IS NULL AND a.vertical = 'SCHOOL' AND p.udise_valid AND p.udise_code = ${school.udise_code}
    `;
    take(rows.map((row) => ({ ...row, phones: [row.organization_phone_normalized].filter(Boolean), emails: [row.organization_email_normalized].filter(Boolean) })));
  }
  if (school.school_name_normalized && school.location.location_key) {
    const rows = await tx`
      SELECT a.id, a.owner_founder_id, a.account_type, a.lifecycle_stage, a.cluster_id, a.external_client_id, a.row_version,
        p.udise_code AS udise, p.school_name_normalized AS strict_name, p.school_name_loose AS loose_name, p.location_key,
        p.organization_phone_normalized, p.organization_email_normalized
      FROM crm_accounts a
      JOIN crm_school_profiles p ON p.account_id = a.id
      WHERE a.archived_at IS NULL AND a.vertical = 'SCHOOL'
        AND p.school_name_normalized = ${school.school_name_normalized} AND p.location_key = ${school.location.location_key}
    `;
    take(rows.map((row) => ({ ...row, phones: [row.organization_phone_normalized].filter(Boolean), emails: [row.organization_email_normalized].filter(Boolean) })));
  }
  const phones = [...school.phones.map((item) => item.normalized), ...(school.contacts || []).flatMap((contact) => [...(contact.phones || []), ...(contact.whatsapp || [])].map((item) => item.normalized))];
  const emails = [...school.emails.map((item) => item.normalized), ...(school.contacts || []).flatMap((contact) => (contact.emails || []).map((item) => item.normalized))];
  if (phones.length) {
    const rows = await tx`
      SELECT a.id, a.owner_founder_id, a.row_version, p.udise_code AS udise, p.school_name_normalized AS strict_name,
        p.school_name_loose AS loose_name, p.location_key, m.normalized_value AS phone
      FROM crm_contact_methods m
      JOIN crm_contacts c ON c.id = m.contact_id AND c.archived_at IS NULL
      JOIN crm_accounts a ON a.id = c.account_id AND a.archived_at IS NULL AND a.vertical = 'SCHOOL'
      LEFT JOIN crm_school_profiles p ON p.account_id = a.id
      WHERE m.archived_at IS NULL AND m.method_type IN ('PHONE', 'WHATSAPP') AND m.normalized_value = ANY(${phones})
    `;
    take(rows.map((row) => ({ ...row, phones: [row.phone], emails: [] })));
  }
  if (emails.length) {
    const rows = await tx`
      SELECT a.id, a.owner_founder_id, a.row_version, p.udise_code AS udise, p.school_name_normalized AS strict_name,
        p.school_name_loose AS loose_name, p.location_key, m.normalized_value AS email
      FROM crm_contact_methods m
      JOIN crm_contacts c ON c.id = m.contact_id AND c.archived_at IS NULL
      JOIN crm_accounts a ON a.id = c.account_id AND a.archived_at IS NULL AND a.vertical = 'SCHOOL'
      LEFT JOIN crm_school_profiles p ON p.account_id = a.id
      WHERE m.archived_at IS NULL AND m.method_type = 'EMAIL' AND m.normalized_value = ANY(${emails})
    `;
    take(rows.map((row) => ({ ...row, phones: [], emails: [row.email] })));
  }
  return [...found.values()];
}

function scopeAccount(scope, account) {
  const restricted = scope.kind !== 'platform' && account.owner_founder_id !== scope.founderId;
  if (!restricted) return { ...account, restricted: false };
  return {
    id: account.id,
    restricted: true,
    udise: account.udise || null,
    strict_name: account.strict_name || null,
    loose_name: account.loose_name || null,
    location_key: account.location_key || null,
    phones: account.phones || [],
    emails: account.emails || [],
    row_version: null,
  };
}

async function directoryHits(tx, school) {
  const phones = school.phones.map((item) => item.normalized);
  const emails = school.emails.map((item) => item.normalized);
  const rows = await tx`
    SELECT cluster_id, school_id, school_name_normalized AS strict_name, location_key, phones, emails, onboarding_status, last_verified_at
    FROM crm_school_customer_directory
    WHERE (${school.school_name_normalized || null}::text IS NOT NULL AND school_name_normalized = ${school.school_name_normalized || null})
      OR (${phones.length}::int > 0 AND phones && ${phones.length ? phones : ['']}::text[])
      OR (${emails.length}::int > 0 AND emails && ${emails.length ? emails : ['']}::text[])
    LIMIT 20
  `;
  return rows.map((row) => ({ ...row, phones: row.phones || [], emails: row.emails || [] }));
}

async function enquiryHits(tx, school) {
  if (!school.school_name_normalized && !school.emails.length && !school.phones.length) return [];
  const email = school.emails[0]?.normalized || null;
  const rows = await tx`
    SELECT id, organization, email, phone
    FROM enquiries
    WHERE account_id IS NULL AND outcome = 'OPEN'
      AND (
        (${email}::text IS NOT NULL AND lower(email) = lower(${email}))
        OR (${school.school_name_normalized || null}::text IS NOT NULL AND lower(trim(organization)) = ${school.school_name_normalized || null})
      )
    LIMIT 20
  `;
  return rows.map((row) => ({
    id: row.id,
    organization_strict: strictSchoolName(row.organization || ''),
    emails: row.email ? [String(row.email).trim().toLowerCase()] : [],
    phones: [],
  }));
}

async function currentCoverage(crmSql, schoolSql) {
  const clusters = schoolSql ? await listActiveClusterIds(schoolSql) : [];
  if (!clusters.length) return { complete: false, clusters: [], checked_at: new Date().toISOString() };
  return coverage(crmSql, clusters, config.crmImport.directoryFreshnessHours);
}

async function classifySchool(tx, scope, school, extras = {}) {
  const accounts = (await lookupAccounts(tx, school)).map((account) => scopeAccount(scope, account));
  const classified = classifyRow({
    identity: identityFromSchool(school, extras.groupId),
    accounts,
    enquiries: extras.enquiries || await enquiryHits(tx, school),
    directory: extras.directory || await directoryHits(tx, school),
    peers: extras.peers || [],
    coverage: extras.coverage || { complete: false },
  });
  const target = accounts.find((account) => account.id === classified.target_account_id);
  return { ...classified, target_version: target?.row_version || null, accounts_considered: accounts.filter((account) => !account.restricted).length };
}

function ownerFor(scope, requested) {
  if (scope.kind !== 'platform') return scope.founderId;
  return requested || null;
}

async function insertSchoolAccount(tx, scope, school, options = {}) {
  if (school.udise_code) {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`udise:${school.udise_code}`})::bigint)`;
    const [clash] = await tx`SELECT account_id FROM crm_school_profiles WHERE udise_valid AND udise_code = ${school.udise_code}`;
    if (clash) throw new CrmError(409, 'A school with this UDISE already exists', 'IDENTITY_CONFLICT');
  }
  if (school.location.location_key && school.school_name_normalized) {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`name:${school.school_name_normalized}|${school.location.location_key}`})::bigint)`;
  }
  const owner = ownerFor(scope, options.owner_founder_id);
  const phone = school.phones[0]?.display || null;
  const email = school.emails[0]?.display || null;
  const [account] = await tx`
    INSERT INTO crm_accounts (
      name, account_type, vertical, lifecycle_stage, owner_founder_id, email, phone, website,
      created_by, source_import_batch_id
    ) VALUES (
      ${school.school_name}, 'PROSPECT', 'SCHOOL', 'LEAD', ${owner}, ${email}, ${phone}, ${school.website},
      ${scope.actor.id}, ${options.batch_id || null}
    ) RETURNING *
  `;
  await tx`
    INSERT INTO crm_school_profiles (
      account_id, udise_code, udise_valid, school_name_normalized, school_name_loose, country_code,
      state_raw, state_normalized, district_raw, district_normalized, city_raw, city_normalized,
      locality_raw, locality_normalized, mandal_raw, mandal_normalized, address_line_1, address_line_2, postal_code, location_key,
      organization_phone_normalized, organization_email_normalized, board, management_type, website,
      estimated_student_count, notes, normalization_version
    ) VALUES (
      ${account.id}, ${school.udise_code}, ${school.udise_valid}, ${school.school_name_normalized}, ${school.school_name_loose},
      ${school.location.country_code}, ${school.location.state_raw}, ${school.location.state_normalized},
      ${school.location.district_raw}, ${school.location.district_normalized}, ${school.location.city_raw}, ${school.location.city_normalized},
      ${school.location.locality_raw}, ${school.location.locality_normalized}, ${school.location.mandal_raw || null}, ${school.location.mandal_normalized || null}, ${school.location.address_line_1}, ${school.location.address_line_2},
      ${school.location.postal_code}, ${school.location.location_key}, ${school.phones[0]?.normalized || null}, ${school.emails[0]?.normalized || null},
      ${school.board}, ${school.management_type}, ${school.website}, ${school.estimated_student_count}, ${school.notes}, ${school.normalization_version}
    )
  `;
  await writeAudit(tx, scope.actor, 'crm_account', 'CREATE', account.id, {
    source: options.source || 'manual',
    batch_id: options.batch_id || null,
    fields: ['name', 'vertical', 'lifecycle_stage'],
    rule_version: options.rule_version || null,
  });
  return account;
}

async function addNormalizedContact(tx, scope, accountId, contact, source) {
  const [created] = await tx`
    INSERT INTO crm_contacts (
      account_id, full_name, name_status, contact_kind, role_title, role_code, is_decision_maker,
      department, preferred_language, notes, is_primary, preferred_channel, do_not_contact, created_by, updated_by
    ) VALUES (
      ${accountId}, ${contact.full_name}, ${contact.name_status}, 'PERSON', ${contact.role_title}, ${contact.role_code},
      ${contact.is_decision_maker}, ${contact.department}, ${contact.preferred_language}, ${contact.notes},
      ${Boolean(contact.is_primary)}, ${contact.preferred_channel}, false, ${scope.actor.id}, ${scope.actor.id}
    ) RETURNING *
  `;
  await replaceMethods(tx, created.id, channelsFromContact(contact), source);
  return created;
}

async function maybeEnquiry(tx, account, school, owner) {
  const email = school.emails[0]?.display || school.contacts.flatMap((contact) => contact.emails)[0]?.display || null;
  const phone = school.phones[0]?.display || school.contacts.flatMap((contact) => contact.phones)[0]?.display || null;
  if (!email && !phone) return { enquiry: null, pipeline: 'not_in_pipeline', channel: 'no_contact_channel' };
  const open = await tx`SELECT id FROM enquiries WHERE account_id = ${account.id} AND outcome = 'OPEN' ORDER BY created_at`;
  if (open.length > 1) throw new CrmError(409, 'Several open enquiries exist. Choose one explicitly.', 'ENQUIRY_SELECTION_REQUIRED');
  if (open.length === 1) return { enquiry: open[0], pipeline: 'linked', channel: 'existing' };
  const [enquiry] = await tx`
    INSERT INTO enquiries (
      name, email, phone, organization, status, assigned_to, account_id, pipeline_stage_code, outcome,
      sales_model_version, product_vertical
    ) VALUES (
      ${school.school_name}, ${email}, ${phone}, ${school.school_name}, 'NEW', ${owner}, ${account.id},
      'NEW', 'OPEN', 1, 'SCHOOL'
    ) RETURNING id
  `;
  return { enquiry, pipeline: 'created', channel: 'created' };
}

async function createProspect(crmSql, schoolSql, scope, body) {
  assertProspectReads();
  assertCrmWrite(scope);
  const school = normalizeSchool(body, { country_code: body.country_code });
  school.contacts = (body.contacts || []).map((contact) => normalizeContact(contact, school.location.country_code));
  if (!school.valid || school.contacts.some((contact) => !contact.valid)) {
    throw new CrmError(400, 'School identity could not be normalized', 'BAD_PROSPECT', { errors: [...school.errors, ...school.contacts.flatMap((contact) => contact.errors)] });
  }
  const report = await crmSql.begin(async (tx) => {
    const coverageReport = await currentCoverage(crmSql, schoolSql);
    const classified = await classifySchool(tx, scope, school, { coverage: coverageReport });
    if (!body.resolution) return { classified, created: null };
    if (!classified.permitted_actions.includes(body.resolution)) {
      throw new CrmError(409, 'That resolution is not allowed for this match', 'IDENTITY_CONFLICT', { classification: classified.classification });
    }
    if (body.resolution === 'IMPORT_NEW' && classified.classification === 'POSSIBLE_DUPLICATE' && !String(body.reason || '').trim()) {
      throw new CrmError(400, 'Importing a possible duplicate requires an explanation', 'REASON_REQUIRED');
    }
    if (body.resolution !== 'IMPORT_NEW') throw new CrmError(400, 'Manual creation only supports IMPORT_NEW. Use import review for other actions.', 'BAD_RESOLUTION');
    const account = await insertSchoolAccount(tx, scope, school, { owner_founder_id: body.owner_founder_id, source: 'manual' });
    if (account.owner_founder_id) {
      await enqueueAutomationEvent(tx, 'account.created', 'crm_account', account.id, {
        account_id: account.id,
        owner_founder_id: account.owner_founder_id,
      });
    }
    for (const contact of school.contacts) await addNormalizedContact(tx, scope, account.id, contact, { type: 'manual' });
    const linked = body.create_enquiry ? await maybeEnquiry(tx, account, school, account.owner_founder_id) : { pipeline: school.phones.length || school.emails.length || school.contacts.some((contact) => contact.phones.length || contact.emails.length) ? 'not_in_pipeline' : 'not_in_pipeline', channel: 'no_contact_channel' };
    return { classified, created: account, linked };
  });
  if (!report.created) {
    throw new CrmError(409, 'Review the duplicate result before creating this school', classifiedCode(report.classified), { classification: report.classified });
  }
  return report.created;
}

function classifiedCode(classified) {
  if (classified.classification === 'CONFLICT') return 'IDENTITY_CONFLICT';
  if (classified.customer_status === 'CHECK_INCOMPLETE') return 'CUSTOMER_CHECK_INCOMPLETE';
  return 'DUPLICATE_REVIEW';
}

function encodeCursor(row) {
  return Buffer.from(`${new Date(row.updated_at).toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const text = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const [updatedAt, id] = text.split('|');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(updatedAt || '') || !/^[0-9a-f-]{36}$/i.test(id || '')) {
    throw new CrmError(400, 'Invalid cursor', 'BAD_CURSOR');
  }
  return { updatedAt, id };
}

async function listProspects(crmSql, scope, query) {
  assertProspectReads();
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const cursor = decodeCursor(query.cursor);
  const requestedOwner = query.owner ? String(query.owner) : null;
  const unassigned = requestedOwner === 'unassigned';
  if (unassigned && scope.kind !== 'platform') throw new CrmError(403, 'Unassigned company intake is outside this scope', 'SCOPE_DENIED');
  if (requestedOwner && !unassigned && !/^[0-9a-f-]{36}$/i.test(requestedOwner)) {
    throw new CrmError(400, 'owner must be a UUID or unassigned', 'BAD_FILTER');
  }
  if (requestedOwner && !unassigned && scope.kind !== 'platform' && requestedOwner !== scope.founderId) {
    throw new CrmError(403, 'That owner is outside this scope', 'SCOPE_DENIED');
  }
  const founder = unassigned ? null : (scope.kind === 'platform' ? requestedOwner : scope.founderId);
  const rows = await crmSql`
    SELECT a.id, a.name, a.account_type, a.lifecycle_stage, a.owner_founder_id, a.phone, a.email, a.row_version,
      a.updated_at, a.cluster_id, a.external_client_id, p.udise_code, p.location_key, p.state_normalized, p.city_normalized,
      p.country_code, f.full_name AS owner_name,
      EXISTS (SELECT 1 FROM crm_contacts c WHERE c.account_id = a.id AND c.archived_at IS NULL) AS has_contact,
      EXISTS (SELECT 1 FROM crm_contacts c WHERE c.account_id = a.id AND c.archived_at IS NULL AND c.is_decision_maker) AS has_decision_maker,
      (SELECT e.pipeline_stage_code FROM enquiries e WHERE e.account_id = a.id ORDER BY e.updated_at DESC LIMIT 1) AS sales_stage,
      (SELECT e.outcome FROM enquiries e WHERE e.account_id = a.id ORDER BY e.updated_at DESC LIMIT 1) AS sales_outcome
    FROM crm_accounts a
    LEFT JOIN crm_school_profiles p ON p.account_id = a.id
    LEFT JOIN founders f ON f.id = a.owner_founder_id
    WHERE a.vertical = 'SCHOOL' AND a.archived_at IS NULL
      AND (${founder}::uuid IS NULL OR a.owner_founder_id = ${founder})
      AND (${unassigned} = false OR a.owner_founder_id IS NULL)
      AND (${query.lifecycle || null}::text IS NULL OR a.lifecycle_stage = ${query.lifecycle || null})
      AND (${query.udise || null}::text IS NULL OR p.udise_code = ${query.udise || null})
      AND (${query.state || null}::text IS NULL OR p.state_normalized = lower(${query.state || ''}))
      AND (${query.without_enquiry || null}::text IS DISTINCT FROM 'true' OR NOT EXISTS (
        SELECT 1 FROM enquiries e WHERE e.account_id = a.id
      ))
      AND (${query.missing_contact || null}::text IS DISTINCT FROM 'true' OR NOT EXISTS (
        SELECT 1 FROM crm_contacts c WHERE c.account_id = a.id AND c.archived_at IS NULL
      ))
      AND (${query.decision_maker || null}::text IS DISTINCT FROM 'true' OR EXISTS (
        SELECT 1 FROM crm_contacts c WHERE c.account_id = a.id AND c.archived_at IS NULL AND c.is_decision_maker
      ))
      AND (${query.search || null}::text IS NULL OR a.name ILIKE ${query.search ? `%${query.search}%` : null} OR p.udise_code = ${query.search || null}
        OR EXISTS (
          SELECT 1 FROM crm_contact_methods m
          JOIN crm_contacts c ON c.id = m.contact_id
          WHERE c.account_id = a.id AND c.archived_at IS NULL AND m.archived_at IS NULL
            AND m.normalized_value = ${query.search || null}
        ))
      AND (${cursor?.updatedAt || null}::timestamptz IS NULL OR (a.updated_at, a.id) < (${cursor?.updatedAt || null}::timestamptz, ${cursor?.id || null}::uuid))
    ORDER BY a.updated_at DESC, a.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  return { data: page, page: { limit, next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null } };
}

async function getProspect(crmSql, scope, accountId) {
  assertProspectReads();
  const [account] = await crmSql`
    SELECT a.*, f.full_name AS owner_name, p.udise_code, p.udise_valid, p.school_name_normalized, p.country_code,
      p.state_raw, p.state_normalized, p.district_raw, p.city_raw, p.city_normalized, p.locality_raw, p.postal_code,
      p.location_key, p.board, p.management_type, p.website AS profile_website, p.estimated_student_count, p.notes,
      p.organization_phone_normalized, p.organization_email_normalized, p.normalization_version, p.row_version AS profile_version
    FROM crm_accounts a
    LEFT JOIN crm_school_profiles p ON p.account_id = a.id
    LEFT JOIN founders f ON f.id = a.owner_founder_id
    WHERE a.id = ${accountId}
  `;
  assertAccountAccess(scope, account);
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  const [contacts, methods, enquiries, tasks, hidden] = await Promise.all([
    crmSql`SELECT * FROM crm_contacts WHERE account_id = ${accountId} AND archived_at IS NULL ORDER BY is_primary DESC, created_at`,
    crmSql`SELECT m.* FROM crm_contact_methods m JOIN crm_contacts c ON c.id = m.contact_id WHERE c.account_id = ${accountId} AND m.archived_at IS NULL`,
    crmSql`
      SELECT id, name, outcome, pipeline_stage_code, row_version, next_follow_up_at, assigned_to
      FROM enquiries
      WHERE account_id = ${accountId}
        AND (${founderId}::uuid IS NULL OR assigned_to = ${founderId})
      ORDER BY updated_at DESC
      LIMIT 50
    `,
    crmSql`
      SELECT t.id, t.title, t.status, t.due_at, t.owner_founder_id
      FROM crm_tasks t
      WHERE t.account_id = ${accountId}
        AND (
          t.enquiry_id IS NULL
          OR EXISTS (
            SELECT 1 FROM enquiries e
            WHERE e.id = t.enquiry_id AND (${founderId}::uuid IS NULL OR e.assigned_to = ${founderId})
          )
        )
      ORDER BY t.due_at NULLS LAST
      LIMIT 50
    `,
    crmSql`
      SELECT COUNT(*)::int AS count FROM enquiries
      WHERE account_id = ${accountId}
        AND (${founderId}::uuid IS NOT NULL AND assigned_to IS DISTINCT FROM ${founderId})
    `,
  ]);
  const channel = contacts.length || account.phone || account.email ? 'has_channel' : 'no_contact_channel';
  const pipeline = enquiries.length ? 'in_pipeline' : 'not_in_pipeline';
  return {
    account,
    profile_channel: channel,
    pipeline,
    contacts: contacts.map((contact) => ({ ...contact, methods: methods.filter((method) => method.contact_id === contact.id) })),
    enquiries,
    restricted_enquiries: hidden[0]?.count || 0,
    tasks,
    customer: account.external_client_id ? { cluster_id: account.cluster_id, school_id: account.external_client_id, lifecycle_stage: account.lifecycle_stage } : null,
  };
}

async function patchProspect(crmSql, scope, accountId, body) {
  assertProspectReads();
  assertCrmWrite(scope);
  const version = Number(body.expected_version);
  if (!Number.isInteger(version)) throw new CrmError(400, 'expected_version is required', 'VERSION_REQUIRED');
  const allowed = ['school_name', 'udise', 'state', 'district', 'city', 'locality', 'address_line_1', 'postal_code', 'board', 'website', 'notes', 'organization_phone', 'organization_email', 'country_code'];
  const unknown = Object.keys(body).filter((key) => !['expected_version', ...allowed].includes(key));
  if (unknown.length) throw new CrmError(400, 'Only school identity fields can be patched here', 'FIELD_NOT_ALLOWED', { fields: unknown });
  return crmSql.begin(async (tx) => {
    const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${accountId} FOR UPDATE`;
    assertAccountAccess(scope, account);
    if (account.row_version !== version) throw new CrmError(409, 'School was updated by someone else', 'VERSION_CONFLICT');
    const [profile] = await tx`SELECT * FROM crm_school_profiles WHERE account_id = ${accountId} FOR UPDATE`;
    if (!profile) throw new CrmError(404, 'School profile not found', 'NOT_FOUND');
    const school = normalizeSchool({
      school_name: body.school_name || account.name,
      udise: body.udise !== undefined ? body.udise : profile.udise_code,
      country: body.country_code || profile.country_code,
      state: body.state !== undefined ? body.state : profile.state_raw,
      district: body.district !== undefined ? body.district : profile.district_raw,
      city: body.city !== undefined ? body.city : profile.city_raw,
      locality: body.locality !== undefined ? body.locality : profile.locality_raw,
      mandal: body.mandal !== undefined ? body.mandal : profile.mandal_raw,
      address_line_1: body.address_line_1 !== undefined ? body.address_line_1 : profile.address_line_1,
      postal_code: body.postal_code !== undefined ? body.postal_code : profile.postal_code,
      phone: body.organization_phone,
      email: body.organization_email,
      board: body.board !== undefined ? body.board : profile.board,
      website: body.website !== undefined ? body.website : profile.website,
      notes: body.notes !== undefined ? body.notes : profile.notes,
    });
    if (!school.valid) throw new CrmError(400, 'School identity could not be normalized', 'BAD_PROSPECT', { errors: school.errors });
    if (school.udise_code && school.udise_code !== profile.udise_code) {
      const [clash] = await tx`SELECT account_id FROM crm_school_profiles WHERE udise_valid AND udise_code = ${school.udise_code} AND account_id <> ${accountId}`;
      if (clash) throw new CrmError(409, 'A school with this UDISE already exists', 'IDENTITY_CONFLICT');
    }
    await tx`
      UPDATE crm_accounts SET name = ${school.school_name}, website = ${school.website},
        phone = CASE WHEN ${body.organization_phone !== undefined} THEN ${school.phones[0]?.display || null} ELSE phone END,
        email = CASE WHEN ${body.organization_email !== undefined} THEN ${school.emails[0]?.display || null} ELSE email END
      WHERE id = ${accountId}
    `;
    await tx`
      UPDATE crm_school_profiles SET
        udise_code = ${school.udise_code}, udise_valid = ${school.udise_valid},
        school_name_normalized = ${school.school_name_normalized}, school_name_loose = ${school.school_name_loose},
        country_code = ${school.location.country_code}, state_raw = ${school.location.state_raw}, state_normalized = ${school.location.state_normalized},
        district_raw = ${school.location.district_raw}, district_normalized = ${school.location.district_normalized},
        city_raw = ${school.location.city_raw}, city_normalized = ${school.location.city_normalized},
        locality_raw = ${school.location.locality_raw}, locality_normalized = ${school.location.locality_normalized},
        mandal_raw = ${school.location.mandal_raw || null}, mandal_normalized = ${school.location.mandal_normalized || null},
        address_line_1 = ${school.location.address_line_1}, postal_code = ${school.location.postal_code}, location_key = ${school.location.location_key},
        organization_phone_normalized = CASE WHEN ${body.organization_phone !== undefined} THEN ${school.phones[0]?.normalized || null} ELSE organization_phone_normalized END,
        organization_email_normalized = CASE WHEN ${body.organization_email !== undefined} THEN ${school.emails[0]?.normalized || null} ELSE organization_email_normalized END,
        board = ${school.board}, website = ${school.website}, notes = ${school.notes}, normalization_version = ${school.normalization_version}
      WHERE account_id = ${accountId}
    `;
    await writeAudit(tx, scope.actor, 'crm_account', 'UPDATE', accountId, { fields: unknown.length ? allowed : Object.keys(body).filter((key) => key !== 'expected_version') });
    const [updated] = await tx`SELECT * FROM crm_accounts WHERE id = ${accountId}`;
    return updated;
  });
}

async function linkEnquiry(crmSql, scope, accountId, body) {
  assertProspectReads();
  assertCrmWrite(scope);
  return crmSql.begin(async (tx) => {
    const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${accountId} FOR UPDATE`;
    assertAccountAccess(scope, account);
    const [profile] = await tx`SELECT * FROM crm_school_profiles WHERE account_id = ${accountId}`;
    if (body.enquiry_id) {
      const [lead] = await tx`SELECT * FROM enquiries WHERE id = ${body.enquiry_id} FOR UPDATE`;
      assertLeadAccess(scope, lead);
      if (lead.account_id && lead.account_id !== account.id) throw new CrmError(409, 'Enquiry belongs to another school', 'CROSS_ACCOUNT');
      if (!lead.email && !lead.phone) throw new CrmError(400, 'Enquiry needs an email or phone', 'CHANNEL_REQUIRED');
      await tx`UPDATE enquiries SET account_id = ${account.id}, product_vertical = 'SCHOOL', updated_at = now() WHERE id = ${lead.id}`;
      await writeAudit(tx, scope.actor, 'enquiry', 'LINK', lead.id, { account_id: account.id });
      return { enquiry_id: lead.id, linked: true };
    }
    const school = {
      school_name: account.name,
      emails: account.email ? [{ display: account.email }] : [],
      phones: account.phone ? [{ display: account.phone }] : [],
      contacts: [],
    };
    if (!school.emails.length && !school.phones.length) {
      throw new CrmError(400, 'Add a phone or email before creating a sales enquiry', 'CHANNEL_REQUIRED');
    }
    const linked = await maybeEnquiry(tx, account, school, account.owner_founder_id);
    if (!linked.enquiry) throw new CrmError(400, 'Add a phone or email before creating a sales enquiry', 'CHANNEL_REQUIRED');
    await writeAudit(tx, scope.actor, 'enquiry', 'CREATE', linked.enquiry.id, { account_id: account.id });
    return { enquiry_id: linked.enquiry.id, linked: linked.pipeline === 'linked' };
  });
}

async function createLegacyAccount(crmSql, scope, body) {
  assertCrmWrite(scope);
  const name = String(body.name || '').trim();
  if (name.length < 2) throw new CrmError(400, 'name is required', 'BAD_ACCOUNT');
  if (body.lifecycle_stage === 'ACTIVE' && (body.vertical || 'OTHER') === 'SCHOOL') {
    throw new CrmError(409, 'A school account becomes ACTIVE only after live onboarding readiness', 'ACTIVATION_RULE');
  }
  if (scope.kind !== 'platform' && body.owner_founder_id && body.owner_founder_id !== scope.founderId) {
    throw new CrmError(403, 'Founders can only create accounts they own', 'WRITE_DENIED');
  }
  if (body.account_type === 'CUSTOMER' && scope.kind !== 'platform') {
    throw new CrmError(403, 'Customer accounts are created by onboarding', 'WRITE_DENIED');
  }
  const owner = scope.kind === 'platform' ? (body.owner_founder_id || scope.founderId || null) : scope.founderId;
  const lifecycle = body.lifecycle_stage || 'LEAD';
  if (!['LEAD', 'QUALIFIED', 'ONBOARDING', 'ACTIVE', 'AT_RISK', 'CHURNED'].includes(lifecycle)) {
    throw new CrmError(400, 'Invalid lifecycle', 'BAD_LIFECYCLE');
  }
  return crmSql.begin(async (tx) => {
    const [created] = await tx`
      INSERT INTO crm_accounts (name, account_type, vertical, lifecycle_stage, owner_founder_id, email, phone, website, tags, created_by)
      VALUES (
        ${name}, ${body.account_type || 'PROSPECT'}, ${body.vertical || 'OTHER'}, ${lifecycle}, ${owner},
        ${body.email || null}, ${body.phone || null}, ${body.website || null}, ${Array.isArray(body.tags) ? body.tags : []}, ${scope.actor.id}
      ) RETURNING *
    `;
    await writeAudit(tx, scope.actor, 'crm_account', 'CREATE', created.id, { fields: ['name', 'lifecycle_stage', 'owner_founder_id'] });
    await enqueueAutomationEvent(tx, 'account.created', 'crm_account', created.id, {
      account_id: created.id,
      owner_founder_id: created.owner_founder_id,
    });
    return created;
  });
}

module.exports = {
  features,
  assertProspectReads,
  identityFromSchool,
  classifySchool,
  insertSchoolAccount,
  addNormalizedContact,
  maybeEnquiry,
  createProspect,
  listProspects,
  getProspect,
  patchProspect,
  linkEnquiry,
  createLegacyAccount,
  currentCoverage,
  createContact,
  stableHash,
};

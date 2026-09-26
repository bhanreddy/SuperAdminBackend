const crypto = require('crypto');
const config = require('../../config/env');
const { CrmError } = require('./errors');
const { assertCrmWrite, assertAccountAccess } = require('./accessPolicy');
const { stableHash } = require('./helpers');
const { NORMALIZATION_VERSION, normalizeSchool, normalizeContact } = require('./normalization');
const { RULE_VERSION } = require('./duplicateDetection');
const parser = require('./importParser');
const { currentCoverage, classifySchool, insertSchoolAccount, addNormalizedContact, maybeEnquiry, identityFromSchool } = require('./prospects');
const { writeAudit } = require('./contactService');

function assertPreview() {
  if (!config.crmFeatures.importPreview) throw new CrmError(403, 'Import preview is disabled', 'FEATURE_DISABLED');
}

function assertExecute() {
  if (!config.crmFeatures.importExecute) throw new CrmError(403, 'Import execution is disabled', 'FEATURE_DISABLED');
}

function publicBatch(batch) {
  if (!batch) return null;
  const { lease_token, ...rest } = batch;
  return rest;
}

async function loadBatch(tx, scope, id, lock = false) {
  const [batch] = lock
    ? await tx`SELECT * FROM crm_import_batches WHERE id = ${id} FOR UPDATE`
    : await tx`SELECT * FROM crm_import_batches WHERE id = ${id}`;
  if (!batch) throw new CrmError(404, 'Import batch not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && batch.scope_founder_id !== scope.founderId) {
    throw new CrmError(404, 'Import batch not found', 'NOT_FOUND');
  }
  return batch;
}

function objectFromRow(row, mapping) {
  const obj = { contacts: [] };
  const buckets = new Map();
  for (const [index, field] of Object.entries(mapping.columns || {})) {
    const value = row.cells[Number(index)] ?? '';
    const meta = row.meta?.[Number(index)] || {};
    const contact = String(field).match(/^contact_(\d+)_(name|role|phone|email|whatsapp|decision_maker)$/);
    if (contact) {
      const bucket = buckets.get(contact[1]) || {};
      bucket[contact[2] === 'decision_maker' ? 'is_decision_maker' : contact[2] === 'name' ? 'full_name' : contact[2]] = value;
      if (meta.formula && (contact[2] === 'phone' || contact[2] === 'email')) bucket.formula = true;
      buckets.set(contact[1], bucket);
      continue;
    }
    if (field === 'udise') {
      obj.udise = value;
      obj.udise_numeric = Boolean(meta.numeric);
      obj.udise_formula = Boolean(meta.formula);
    } else obj[field] = value;
  }
  obj.contacts = [...buckets.values()].filter((item) => Object.values(item).some((value) => value !== '' && value != null));
  return obj;
}

function assignGroups(items) {
  for (const item of items) {
    if (!item.school.valid) item.group_id = `invalid:${item.row_number}`;
    else if (item.school.udise_code) item.group_id = `udise:${item.school.udise_code}`;
    else if (item.school.school_name_normalized && item.school.location.location_key) {
      item.group_id = `name:${item.school.school_name_normalized}|${item.school.location.location_key}`;
    } else item.group_id = `row:${item.row_number}`;
  }
  const byName = new Map();
  for (const item of items) {
    if (!item.school.valid || !item.school.school_name_normalized || !item.school.location?.location_key) continue;
    const key = `${item.school.school_name_normalized}|${item.school.location.location_key}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }
  for (const group of byName.values()) {
    const udises = [...new Set(group.map((item) => item.school.udise_code).filter(Boolean))];
    if (udises.length > 1) group.forEach((item) => { item.school.forced_conflict = 'multiple_udise_same_location'; });
    if (udises.length === 1) group.forEach((item) => { item.group_id = `udise:${udises[0]}`; });
  }
  return items;
}

async function createBatch(crmSql, scope, file) {
  assertPreview();
  assertCrmWrite(scope);
  const format = parser.inspectUpload(file.buffer, file.originalname);
  const max = format === 'csv' ? config.crmImport.csvMaxBytes : config.crmImport.xlsxMaxBytes;
  if (file.buffer.length > max) {
    throw new CrmError(413, `File exceeds the ${format === 'csv' ? '25 MiB CSV' : '10 MiB XLSX'} limit. Split the file and import the parts.`, 'FILE_TOO_LARGE');
  }
  const queued = await crmSql`SELECT COALESCE(SUM(byte_size), 0)::int AS bytes FROM crm_import_batches WHERE status IN ('PARSING','PREVIEW_QUEUED','PREVIEWING','CONFIRMED','PROCESSING')`;
  if (Number(queued[0]?.bytes || 0) + file.buffer.length > config.crmImport.maxQueuedBytes) {
    throw new CrmError(429, 'The import queue is full. Retry after the current files finish.', 'RATE_LIMITED');
  }
  const id = crypto.randomUUID();
  const retention = new Date(Date.now() + config.crmImport.retentionDays * 86400000).toISOString();
  await crmSql.begin(async (tx) => {
    await tx`
      INSERT INTO crm_import_batches (
        id, created_by, scope_kind, scope_founder_id, original_filename, content_type, byte_size, checksum_sha256,
        parser_version, normalization_version, rule_version, status, retention_expires_at
      ) VALUES (
        ${id}, ${scope.actor.id}, ${scope.kind}, ${scope.founderId}, ${String(file.originalname || 'upload').slice(0, 180)},
        ${file.mimetype || format}, ${file.buffer.length}, ${parser.checksum(file.buffer)}, ${parser.PARSER_VERSION},
        ${NORMALIZATION_VERSION}, ${RULE_VERSION}, 'PARSING', ${retention}
      )
    `;
    await tx`INSERT INTO crm_import_files (batch_id, body) VALUES (${id}, ${file.buffer})`;
    await writeAudit(tx, scope.actor, 'crm_import_batch', 'UPLOAD', id, { byte_size: file.buffer.length, format });
  });
  return { id, status: 'PARSING' };
}

async function readFile(crmSql, batchId) {
  const [file] = await crmSql`SELECT body FROM crm_import_files WHERE batch_id = ${batchId}`;
  if (!file) throw new CrmError(404, 'Import file expired', 'NOT_FOUND');
  return file.body;
}

async function parseStored(crmSql, batch) {
  const body = await readFile(crmSql, batch.id);
  const format = parser.inspectUpload(body, batch.original_filename);
  const parsed = format === 'csv' ? parser.parseCsv(body, { limits: config.crmImport }) : parser.parseXlsx(body, { limits: config.crmImport });
  await crmSql.begin(async (tx) => {
    await tx`DELETE FROM crm_import_rows WHERE batch_id = ${batch.id}`;
    for (const row of parsed.rows) {
      await tx`
        INSERT INTO crm_import_rows (batch_id, sheet_name, row_number, original_cells)
        VALUES (${batch.id}, ${row.sheet_name || ''}, ${row.row_number}, ${tx.json({ cells: row.cells, meta: row.meta || [] })})
      `;
    }
    await tx`
      UPDATE crm_import_batches SET status = 'AWAITING_MAPPING', structure = ${tx.json({ sheets: parsed.sheets, catalog: parsed.sheet_catalog || parsed.sheets.map((sheet) => sheet.name) })},
        counts = ${tx.json({ parsed_rows: parsed.rows.length })}, lease_token = NULL, lease_expires_at = NULL, lease_owner = NULL, updated_at = now()
      WHERE id = ${batch.id} AND lease_token IS NOT DISTINCT FROM ${batch.lease_token}
    `;
  });
}

function previewHash(rows, revision) {
  return stableHash(rows.map((row) => ({
    id: row.id,
    row_number: row.row_number,
    classification: row.classification,
    customer_status: row.customer_status,
    group: row.school_group_id,
    udise: row.normalized?.school?.udise_code || null,
    name: row.normalized?.school?.school_name_normalized || null,
  })).concat([{ revision }]));
}

async function previewStored(crmSql, schoolSql, scope, batch) {
  const mapping = batch.mapping || {};
  const errors = parser.assertMapping(mapping);
  if (errors.length) throw new CrmError(400, 'Column mapping is incomplete', 'BAD_MAPPING', { errors });
  const stored = await crmSql`SELECT * FROM crm_import_rows WHERE batch_id = ${batch.id} ORDER BY row_number`;
  const coverageReport = await currentCoverage(crmSql, schoolSql);
  const items = stored.map((row) => {
    const original = row.original_cells || {};
    const input = objectFromRow({ cells: original.cells || [], meta: original.meta || [] }, mapping);
    const school = normalizeSchool({ ...input, ...mapping.defaults, country_code: input.country || mapping.defaults?.country_code }, mapping.defaults || {});
    school.contacts = (input.contacts || []).map((contact) => normalizeContact(contact, school.location.country_code));
    if (school.contacts.some((contact) => !contact.valid)) school.errors.push(...school.contacts.flatMap((contact) => contact.errors));
    if (school.errors.length) school.valid = false;
    return { id: row.id, row_number: row.row_number, sheet_name: row.sheet_name, school };
  });
  assignGroups(items);
  const peers = items.map((item) => ({ ...identityFromSchool(item.school, item.group_id), group_id: item.group_id }));
  const classified = [];
  for (const item of items) {
    const result = await crmSql.begin((tx) => classifySchool(tx, scope, item.school, {
      groupId: item.group_id,
      coverage: coverageReport,
      peers: peers.filter((peer) => peer.group_id !== item.group_id),
    }));
    classified.push({ ...item, result });
  }
  const revision = Number(batch.preview_revision || 0) + 1;
  await crmSql.begin(async (tx) => {
    for (const item of classified) {
      await tx`
        UPDATE crm_import_rows SET
          normalized = ${tx.json({ school: item.school, permitted_actions: item.result.permitted_actions })},
          errors = ${tx.json(item.school.errors || [])},
          warnings = ${tx.json([])},
          candidates = ${tx.json(item.result.evidence || [])},
          classification = ${item.result.classification},
          customer_status = ${item.result.customer_status},
          school_group_id = ${item.group_id},
          target_account_id = ${item.result.target_account_id},
          target_version = ${item.result.target_version},
          selected_action = NULL,
          result_status = NULL,
          updated_at = now()
        WHERE id = ${item.id}
      `;
    }
    const hash = previewHash(classified.map((item) => ({
      id: item.id,
      row_number: item.row_number,
      classification: item.result.classification,
      customer_status: item.result.customer_status,
      school_group_id: item.group_id,
      normalized: { school: item.school },
    })), revision);
    const counts = countRows(classified.map((item) => ({ classification: item.result.classification, customer_status: item.result.customer_status, school_group_id: item.group_id })));
    await tx`
      UPDATE crm_import_batches SET status = 'PREVIEW_READY', preview_revision = ${revision}, preview_hash = ${hash},
        coverage = ${tx.json(coverageReport)}, counts = ${tx.json(counts)}, lease_token = NULL, lease_expires_at = NULL, lease_owner = NULL, updated_at = now()
      WHERE id = ${batch.id} AND lease_token IS NOT DISTINCT FROM ${batch.lease_token}
    `;
  });
}

function countRows(rows) {
  const schools = new Set(rows.map((row) => row.school_group_id).filter(Boolean));
  const tally = (key, value) => rows.filter((row) => row[key] === value).length;
  return {
    rows: rows.length,
    school_groups: schools.size,
    new: tally('classification', 'NEW'),
    exact_duplicate: tally('classification', 'EXACT_DUPLICATE'),
    possible_duplicate: tally('classification', 'POSSIBLE_DUPLICATE'),
    conflict: tally('classification', 'CONFLICT'),
    invalid: tally('classification', 'INVALID'),
    confirmed_customer: tally('customer_status', 'CONFIRMED_CUSTOMER'),
    possible_customer: tally('customer_status', 'POSSIBLE_CUSTOMER'),
    check_incomplete: tally('customer_status', 'CHECK_INCOMPLETE'),
  };
}

async function setMapping(crmSql, scope, batchId, body) {
  assertPreview();
  assertCrmWrite(scope);
  const errors = parser.assertMapping(body);
  if (body.defaults?.owner_founder_id && scope.kind !== 'platform' && body.defaults.owner_founder_id !== scope.founderId) {
    throw new CrmError(403, 'Founders cannot assign another owner', 'WRITE_DENIED');
  }
  return crmSql.begin(async (tx) => {
    const batch = await loadBatch(tx, scope, batchId, true);
    if (['PROCESSING', 'COMPLETED'].includes(batch.status)) throw new CrmError(409, 'This import can no longer be remapped', 'PREVIEW_STALE');
    const [updated] = await tx`
      UPDATE crm_import_batches SET mapping = ${tx.json({ columns: body.columns, sheet_name: body.sheet_name || null, header_row: body.header_row || 1 })},
        defaults = ${tx.json(body.defaults || {})}, sheet_name = ${body.sheet_name || null}, header_row_number = ${body.header_row || 1},
        preview_hash = NULL, status = 'AWAITING_MAPPING', row_version = row_version + 1, updated_at = now()
      WHERE id = ${batch.id} RETURNING *
    `;
    await writeAudit(tx, scope.actor, 'crm_import_batch', 'MAPPING', batch.id, { fields: Object.values(body.columns || {}) });
    return publicBatch(updated);
  });
}

async function queuePreview(crmSql, scope, batchId) {
  assertPreview();
  assertCrmWrite(scope);
  const [updated] = await crmSql`
    UPDATE crm_import_batches SET status = 'PREVIEW_QUEUED', preview_hash = NULL, updated_at = now()
    WHERE id = ${batchId} AND status IN ('AWAITING_MAPPING', 'PREVIEW_READY', 'FAILED')
      AND (${scope.kind === 'platform'} OR scope_founder_id = ${scope.founderId})
    RETURNING id, status, row_version
  `;
  if (!updated) throw new CrmError(409, 'Preview cannot be queued from the current batch state', 'PREVIEW_STALE');
  return updated;
}

async function setDecisions(crmSql, scope, batchId, body) {
  assertPreview();
  assertCrmWrite(scope);
  const version = Number(body.expected_version);
  return crmSql.begin(async (tx) => {
    const batch = await loadBatch(tx, scope, batchId, true);
    if (batch.status !== 'PREVIEW_READY') throw new CrmError(409, 'Decide after the preview is ready', 'PREVIEW_STALE');
    if (batch.row_version !== version) throw new CrmError(409, 'The preview changed', 'VERSION_CONFLICT');
    for (const decision of body.decisions || []) {
      const [row] = await tx`SELECT * FROM crm_import_rows WHERE id = ${decision.row_id} AND batch_id = ${batch.id} FOR UPDATE`;
      if (!row) throw new CrmError(404, 'Import row not found', 'NOT_FOUND');
      const permitted = row.normalized?.permitted_actions || [];
      if (!permitted.includes(decision.action)) throw new CrmError(409, 'That action is not allowed for this row', 'IDENTITY_CONFLICT');
      if (decision.action === 'IMPORT_NEW' && row.classification === 'POSSIBLE_DUPLICATE' && !String(decision.reason || '').trim()) {
        throw new CrmError(400, 'Importing a possible duplicate requires an explanation', 'REASON_REQUIRED');
      }
      await tx`
        UPDATE crm_import_rows SET selected_action = ${decision.action}, action_reason = ${decision.reason || null},
          target_account_id = COALESCE(${decision.target_account_id || null}, target_account_id),
          field_changes = ${tx.json(decision.fields || null)}, updated_at = now()
        WHERE id = ${row.id}
      `;
    }
    const [updated] = await tx`
      UPDATE crm_import_batches SET row_version = row_version + 1, updated_at = now() WHERE id = ${batch.id} RETURNING *
    `;
    await writeAudit(tx, scope.actor, 'crm_import_batch', 'DECISIONS', batch.id, { rows: (body.decisions || []).length });
    return publicBatch(updated);
  });
}

async function confirmBatch(crmSql, scope, batchId, body) {
  assertExecute();
  assertCrmWrite(scope);
  const key = String(body.idempotency_key || '').trim();
  if (key.length < 8) throw new CrmError(400, 'idempotency_key is required', 'IDEMPOTENCY_KEY');
  const payloadHash = stableHash({ batchId, preview: body.preview_hash, revision: body.preview_revision, version: body.expected_version, accept_new: Boolean(body.accept_new), import_valid_only: Boolean(body.import_valid_only) });
  const receiptScope = `import_confirm:${scope.actor.id}:${batchId}`;
  const [existing] = await crmSql`SELECT response, request_hash FROM crm_command_receipts WHERE scope = ${receiptScope} AND idempotency_key = ${key}`;
  if (existing) {
    if (existing.request_hash !== payloadHash) throw new CrmError(409, 'This idempotency key was already used for a different confirmation', 'IDEMPOTENCY_CONFLICT');
    return existing.response;
  }
  const response = await crmSql.begin(async (tx) => {
    const batch = await loadBatch(tx, scope, batchId, true);
    if (batch.row_version !== Number(body.expected_version) || batch.preview_revision !== Number(body.preview_revision) || batch.preview_hash !== body.preview_hash) {
      throw new CrmError(409, 'The preview is stale. Refresh the review before confirming.', 'PREVIEW_STALE');
    }
    if (batch.status !== 'PREVIEW_READY') throw new CrmError(409, 'This batch is not ready to confirm', 'PREVIEW_STALE');
    if (!batch.coverage?.complete && body.accept_new) {
      throw new CrmError(409, 'Customer coverage is incomplete. Confirmed-new rows stay blocked.', 'CUSTOMER_CHECK_INCOMPLETE');
    }
    const rows = await tx`SELECT * FROM crm_import_rows WHERE batch_id = ${batch.id}`;
    if (body.accept_new) {
      await tx`
        UPDATE crm_import_rows SET selected_action = 'IMPORT_NEW'
        WHERE batch_id = ${batch.id} AND classification = 'NEW' AND customer_status = 'NO_MATCH' AND selected_action IS NULL
      `;
    }
    const fresh = await tx`SELECT * FROM crm_import_rows WHERE batch_id = ${batch.id}`;
    const excluded = [];
    for (const row of fresh) {
      const blocked = !row.selected_action || (row.selected_action === 'IMPORT_NEW' && (row.classification === 'CONFLICT' || row.classification === 'INVALID' || row.customer_status === 'CHECK_INCOMPLETE' || row.customer_status === 'CONFIRMED_CUSTOMER'));
      if (blocked) {
        if (!body.import_valid_only) throw new CrmError(409, 'Every row needs a decision, or confirm with import_valid_only', 'DECISIONS_REQUIRED', { row_id: row.id, row_number: row.row_number });
        excluded.push({ row_id: row.id, row_number: row.row_number, classification: row.classification });
        await tx`UPDATE crm_import_rows SET result_status = 'EXCLUDED', selected_action = COALESCE(selected_action, 'SKIP') WHERE id = ${row.id}`;
      }
    }
    const [updated] = await tx`
      UPDATE crm_import_batches SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = ${scope.actor.id},
        idempotency_key = ${key}, confirm_payload_hash = ${payloadHash}, updated_at = now()
      WHERE id = ${batch.id} RETURNING id, status, row_version, preview_revision
    `;
    const bodyOut = { ...updated, excluded };
    await tx`
      INSERT INTO crm_command_receipts (scope, idempotency_key, request_hash, status_code, response)
      VALUES (${receiptScope}, ${key}, ${payloadHash}, 202, ${tx.json(bodyOut)})
    `;
    await writeAudit(tx, scope.actor, 'crm_import_batch', 'CONFIRM', batch.id, { excluded: excluded.length, rule_version: RULE_VERSION });
    return bodyOut;
  });
  return response;
}

async function applyGroup(tx, scope, batch, rows) {
  const pending = rows.filter((row) => row.result_status !== 'APPLIED' && row.result_status !== 'EXCLUDED' && row.result_status !== 'SKIPPED');
  if (!pending.length) return { schools_created: 0, contacts_added: 0 };
  const action = pending[0].selected_action;
  if (pending.some((row) => row.selected_action !== action)) {
    for (const row of pending) await tx`UPDATE crm_import_rows SET result_status = 'BLOCKED', result = ${tx.json({ code: 'MIXED_ACTIONS' })} WHERE id = ${row.id}`;
    return { schools_created: 0, contacts_added: 0, blocked: pending.length };
  }
  if (action === 'SKIP' || action === 'ALREADY_CUSTOMER') {
    for (const row of pending) await tx`UPDATE crm_import_rows SET result_status = 'SKIPPED', result = ${tx.json({ action })} WHERE id = ${row.id}`;
    return { schools_created: 0, contacts_added: 0, skipped: pending.length };
  }
  const first = pending[0].normalized.school;
  if (action === 'MERGE' || action === 'UPDATE' || action === 'ADD_CONTACT') {
    const accountId = pending.find((row) => row.target_account_id)?.target_account_id;
    if (!accountId) throw new CrmError(409, 'Choose the school to update', 'TARGET_REQUIRED');
    const [account] = await tx`SELECT * FROM crm_accounts WHERE id = ${accountId} FOR UPDATE`;
    if (!account) throw new CrmError(404, 'CRM account not found', 'NOT_FOUND');
    assertAccountAccess(scope, account);
    const expected = pending.find((row) => row.target_version)?.target_version;
    if (expected && account.row_version !== expected) {
      for (const row of pending) await tx`UPDATE crm_import_rows SET result_status = 'BLOCKED', result = ${tx.json({ code: 'VERSION_CONFLICT' })} WHERE id = ${row.id}`;
      return { blocked: pending.length };
    }
    let contacts = 0;
    if (action !== 'UPDATE') {
      for (const row of pending) {
        for (const contact of row.normalized.school.contacts || []) {
          if (!contact.valid) continue;
          await addNormalizedContact(tx, scope, account.id, contact, { type: 'school_import', ref: batch.id });
          contacts += 1;
        }
      }
    }
    if (action === 'UPDATE') {
      const fields = pending[0].field_changes || {};
      if (Object.prototype.hasOwnProperty.call(fields, 'notes')) await tx`UPDATE crm_school_profiles SET notes = ${fields.notes || null} WHERE account_id = ${account.id}`;
      if (Object.prototype.hasOwnProperty.call(fields, 'board')) await tx`UPDATE crm_school_profiles SET board = ${fields.board || null} WHERE account_id = ${account.id}`;
      if (Object.prototype.hasOwnProperty.call(fields, 'website')) {
        await tx`UPDATE crm_school_profiles SET website = ${fields.website || null} WHERE account_id = ${account.id}`;
        await tx`UPDATE crm_accounts SET website = ${fields.website || null} WHERE id = ${account.id}`;
      }
    }
    if (action === 'MERGE') {
      const school = first;
      await tx`
        UPDATE crm_school_profiles SET
          udise_code = COALESCE(udise_code, ${school.udise_code}),
          udise_valid = CASE WHEN udise_code IS NULL AND ${school.udise_valid} THEN true ELSE udise_valid END,
          board = COALESCE(board, ${school.board}),
          website = COALESCE(website, ${school.website}),
          notes = COALESCE(notes, ${school.notes}),
          organization_phone_normalized = COALESCE(organization_phone_normalized, ${school.phones[0]?.normalized || null}),
          organization_email_normalized = COALESCE(organization_email_normalized, ${school.emails[0]?.normalized || null})
        WHERE account_id = ${account.id}
      `;
    }
    for (const row of pending) {
      await tx`UPDATE crm_import_rows SET result_status = 'APPLIED', target_account_id = ${account.id}, result = ${tx.json({ action, account_id: account.id, applied_version: account.row_version })} WHERE id = ${row.id}`;
    }
    await writeAudit(tx, scope.actor, 'crm_account', action, account.id, { batch_id: batch.id, fields: action === 'ADD_CONTACT' ? ['contacts'] : ['profile', 'contacts'] });
    return { schools_created: 0, schools_updated: action === 'ADD_CONTACT' ? 0 : 1, contacts_added: contacts };
  }
  if (action === 'IMPORT_NEW') {
    if (pending.some((row) => row.customer_status === 'CONFIRMED_CUSTOMER' || row.customer_status === 'CHECK_INCOMPLETE')) {
      for (const row of pending) await tx`UPDATE crm_import_rows SET result_status = 'BLOCKED', result = ${tx.json({ code: 'CUSTOMER_CHECK_INCOMPLETE' })} WHERE id = ${row.id}`;
      return { blocked: pending.length };
    }
    const again = await classifySchool(tx, scope, first, { coverage: batch.coverage, groupId: pending[0].school_group_id });
    if (again.classification === 'EXACT_DUPLICATE' || again.classification === 'CONFLICT' || again.restricted) {
      for (const row of pending) await tx`UPDATE crm_import_rows SET result_status = 'BLOCKED', result = ${tx.json({ code: 'IDENTITY_CHANGED' })} WHERE id = ${row.id}`;
      return { blocked: pending.length };
    }
    const account = await insertSchoolAccount(tx, scope, first, { owner_founder_id: batch.defaults?.owner_founder_id, batch_id: batch.id, source: 'school_import', rule_version: RULE_VERSION });
    let contacts = 0;
    for (const row of pending) {
      for (const contact of row.normalized.school.contacts || []) {
        if (!contact.valid) continue;
        const created = await addNormalizedContact(tx, scope, account.id, contact, { type: 'school_import', ref: batch.id });
        contacts += 1;
        await tx`UPDATE crm_import_rows SET provenance = provenance || ${tx.json({ contact_id: created.id })} WHERE id = ${row.id}`;
      }
    }
    let enquiryId = null;
    if (batch.defaults?.create_enquiry !== false) {
      const linked = await maybeEnquiry(tx, account, { ...first, contacts: pending.flatMap((row) => row.normalized.school.contacts || []) }, account.owner_founder_id);
      enquiryId = linked.enquiry?.id || null;
    }
    if (batch.defaults?.follow_up_due_at && account.owner_founder_id) {
      const [task] = await tx`
        INSERT INTO crm_tasks (title, task_type, owner_founder_id, account_id, enquiry_id, due_at, created_by, metadata)
        VALUES ('Research imported school', 'FOLLOW_UP', ${account.owner_founder_id}, ${account.id}, ${enquiryId}, ${batch.defaults.follow_up_due_at}, ${scope.actor.id}, ${tx.json({ batch_id: batch.id, source: 'school_import' })})
        RETURNING id
      `;
      if (enquiryId) {
        await tx`
          UPDATE enquiries
          SET next_action_task_id = ${task.id}, updated_at = now()
          WHERE id = ${enquiryId} AND next_action_task_id IS NULL
        `;
      }
    }
    for (const row of pending) {
      await tx`UPDATE crm_import_rows SET result_status = 'APPLIED', target_account_id = ${account.id}, target_version = ${account.row_version}, result = ${tx.json({ action, account_id: account.id, enquiry_id: enquiryId, applied_version: account.row_version })} WHERE id = ${row.id}`;
    }
    return { schools_created: 1, contacts_added: contacts };
  }
  for (const row of pending) await tx`UPDATE crm_import_rows SET result_status = 'BLOCKED', result = ${tx.json({ code: 'ACTION_UNAVAILABLE' })} WHERE id = ${row.id}`;
  return { blocked: pending.length };
}

async function executeStored(crmSql, schoolSql, scope, batch) {
  assertExecute();
  const groups = await crmSql`
    SELECT school_group_id FROM crm_import_rows
    WHERE batch_id = ${batch.id} AND result_status IS DISTINCT FROM 'APPLIED' AND result_status IS DISTINCT FROM 'EXCLUDED'
    GROUP BY school_group_id ORDER BY min(row_number)
  `;
  const totals = { schools_created: 0, contacts_added: 0, skipped: 0, failed: 0, blocked: 0, rows_processed: 0 };
  for (const group of groups) {
    const [live] = await crmSql`SELECT cancel_requested_at, lease_token, status FROM crm_import_batches WHERE id = ${batch.id}`;
    if (!live || live.lease_token !== batch.lease_token) return { ...totals, fenced: true };
    if (live.cancel_requested_at) break;
    try {
      const delta = await crmSql.begin(async (tx) => {
        const rows = await tx`SELECT * FROM crm_import_rows WHERE batch_id = ${batch.id} AND school_group_id = ${group.school_group_id} ORDER BY row_number FOR UPDATE`;
        return applyGroup(tx, scope, batch, rows);
      });
      totals.schools_created += delta.schools_created || 0;
      totals.contacts_added += delta.contacts_added || 0;
      totals.skipped += delta.skipped || 0;
      totals.blocked += delta.blocked || 0;
      totals.rows_processed += 1;
      await crmSql`UPDATE crm_import_batches SET lease_expires_at = now() + interval '45 seconds', counts = counts || ${crmSql.json(totals)} WHERE id = ${batch.id} AND lease_token = ${batch.lease_token}`;
    } catch (err) {
      totals.failed += 1;
      await crmSql`UPDATE crm_import_rows SET result_status = 'FAILED', retryable = true, result = ${crmSql.json({ code: err.code || 'PROCESSING_RETRYABLE' })} WHERE batch_id = ${batch.id} AND school_group_id = ${group.school_group_id} AND result_status IS DISTINCT FROM 'APPLIED'`;
    }
  }
  const [remaining] = await crmSql`
    SELECT COUNT(*)::int AS count FROM crm_import_rows
    WHERE batch_id = ${batch.id} AND result_status IN ('FAILED', 'BLOCKED')
  `;
  const status = remaining.count ? 'PARTIAL' : 'COMPLETED';
  await crmSql`
    UPDATE crm_import_batches SET status = ${status}, counts = counts || ${crmSql.json(totals)}, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = ${batch.id} AND lease_token = ${batch.lease_token}
  `;
  return totals;
}

async function listBatches(crmSql, scope, query) {
  const limit = Math.min(Number(query.limit) || 25, 100);
  const rows = await crmSql`
    SELECT id, original_filename, status, counts, preview_revision, byte_size, created_at, updated_at, coverage, last_error
    FROM crm_import_batches
    WHERE (${scope.kind === 'platform'} OR scope_founder_id = ${scope.founderId})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return { data: rows, page: { limit, next_cursor: null } };
}

async function listRows(crmSql, scope, batchId, query) {
  await loadBatch(crmSql, scope, batchId);
  const limit = Math.min(Number(query.limit) || 50, 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const rows = await crmSql`
    SELECT id, sheet_name, row_number, errors, warnings, candidates, classification, customer_status, school_group_id,
      selected_action, action_reason, target_account_id, result_status, result, normalized
    FROM crm_import_rows
    WHERE batch_id = ${batchId}
      AND (${query.classification || null}::text IS NULL OR classification = ${query.classification || null})
    ORDER BY row_number
    LIMIT ${limit} OFFSET ${offset}
  `;
  return { data: rows.map(presentRow), page: { limit, offset } };
}

function presentRow(row) {
  const school = row.normalized?.school;
  return {
    ...row,
    normalized: school ? {
      school_name: school.school_name,
      school_name_normalized: school.school_name_normalized,
      udise_code: school.udise_code,
      location_key: school.location?.location_key || null,
      phones: (school.phones || []).map((item) => item.normalized),
      emails: (school.emails || []).map((item) => item.normalized),
      contacts: (school.contacts || []).map((contact) => ({ display_name: contact.display_name, role_code: contact.role_code })),
      permitted_actions: row.normalized.permitted_actions || [],
    } : null,
  };
}

async function errorCsv(crmSql, scope, batchId) {
  await loadBatch(crmSql, scope, batchId);
  const rows = await crmSql`
    SELECT row_number, classification, customer_status, result_status, errors, result
    FROM crm_import_rows
    WHERE batch_id = ${batchId} AND (jsonb_array_length(errors) > 0 OR result_status IN ('FAILED', 'BLOCKED', 'EXCLUDED'))
    ORDER BY row_number
  `;
  const lines = ['row_number,classification,customer_status,result_status,code'];
  for (const row of rows) {
    const code = row.errors?.[0]?.code || row.result?.code || '';
    lines.push([row.row_number, row.classification, row.customer_status, row.result_status, code].map(parser.formulaSafe).join(','));
  }
  return lines.join('\n');
}

async function patchRow(crmSql, scope, batchId, rowId, body) {
  assertPreview();
  assertCrmWrite(scope);
  return crmSql.begin(async (tx) => {
    const batch = await loadBatch(tx, scope, batchId, true);
    const [row] = await tx`SELECT * FROM crm_import_rows WHERE id = ${rowId} AND batch_id = ${batch.id} FOR UPDATE`;
    if (!row) throw new CrmError(404, 'Import row not found', 'NOT_FOUND');
    const cells = [...(row.original_cells?.cells || [])];
    const index = Number(body.column_index);
    if (!Number.isInteger(index) || index < 0 || index > 99) throw new CrmError(400, 'column_index is invalid', 'BAD_CELL');
    cells[index] = String(body.value ?? '');
    await tx`
      UPDATE crm_import_rows SET original_cells = ${tx.json({ cells, meta: row.original_cells?.meta || [] })},
        provenance = provenance || ${tx.json({ corrected: true })}, normalized = NULL, classification = NULL
      WHERE id = ${row.id}
    `;
    const [updated] = await tx`
      UPDATE crm_import_batches SET preview_hash = NULL, status = 'AWAITING_MAPPING', row_version = row_version + 1 WHERE id = ${batch.id} RETURNING *
    `;
    await writeAudit(tx, scope.actor, 'crm_import_row', 'CORRECT', row.id, { batch_id: batch.id, column_index: index });
    return publicBatch(updated);
  });
}

async function cancelBatch(crmSql, scope, batchId) {
  assertCrmWrite(scope);
  const [updated] = await crmSql`
    UPDATE crm_import_batches SET cancel_requested_at = now(),
      status = CASE WHEN status IN ('PARSING', 'PREVIEW_QUEUED', 'AWAITING_MAPPING', 'PREVIEW_READY', 'CONFIRMED') THEN 'CANCELLED' ELSE status END,
      updated_at = now()
    WHERE id = ${batchId} AND (${scope.kind === 'platform'} OR scope_founder_id = ${scope.founderId})
    RETURNING id, status, cancel_requested_at
  `;
  if (!updated) throw new CrmError(404, 'Import batch not found', 'NOT_FOUND');
  await writeAudit(crmSql, scope.actor, 'crm_import_batch', 'CANCEL', batchId, {});
  return updated;
}

async function retryBatch(crmSql, scope, batchId) {
  assertExecute();
  assertCrmWrite(scope);
  const [updated] = await crmSql`
    UPDATE crm_import_batches SET status = 'CONFIRMED', lease_token = NULL, lease_expires_at = NULL, cancel_requested_at = NULL, updated_at = now()
    WHERE id = ${batchId} AND status IN ('PARTIAL', 'FAILED', 'CANCELLED')
      AND (${scope.kind === 'platform'} OR scope_founder_id = ${scope.founderId})
    RETURNING id, status
  `;
  if (!updated) throw new CrmError(409, 'Only incomplete batches can be retried', 'NOT_RETRYABLE');
  await crmSql`UPDATE crm_import_rows SET result_status = NULL, retryable = false WHERE batch_id = ${batchId} AND result_status IN ('FAILED', 'BLOCKED')`;
  await writeAudit(crmSql, scope.actor, 'crm_import_batch', 'RETRY', batchId, {});
  return updated;
}

module.exports = {
  publicBatch,
  loadBatch,
  createBatch,
  parseStored,
  previewStored,
  setMapping,
  queuePreview,
  setDecisions,
  confirmBatch,
  executeStored,
  listBatches,
  listRows,
  errorCsv,
  patchRow,
  cancelBatch,
  retryBatch,
  assignGroups,
  objectFromRow,
  suggestMapping: parser.suggestMapping,
  templateFields: () => Object.keys(parser.FIELD_ALIASES),
};

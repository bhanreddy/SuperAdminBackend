const { CrmError } = require('./errors');
const { assertCrmWrite, assertAccountAccess, assertLeadAccess } = require('./accessPolicy');
const rules = require('./feedbackRules');

let failureBudget = 0;
let routingAdapter = null;

function setRoutingFailureCount(count) {
  failureBudget = Number(count) || 0;
}

function setRoutingAdapter(adapter) {
  routingAdapter = adapter || null;
}

function escapeLike(value) {
  return String(value).trim().slice(0, 80).replace(/[\\%_]/g, '\\$&');
}

function sourceHref(row) {
  if (row.source_type === 'enquiry' && row.source_id) return `/(app)/console/lead/${row.source_id}`;
  if ((row.source_type === 'account' || row.source_type === 'school') && (row.account_id || row.source_id)) {
    return `/(app)/console/school-prospects/${row.account_id || row.source_id}`;
  }
  return `/(app)/console/field-feedback?item=${row.id}`;
}

function presentItem(row, { triage = false } = {}) {
  return {
    id: row.id,
    submission_id: row.submission_id,
    sequence_no: row.sequence_no,
    category: row.category,
    category_label: rules.CATEGORY_LABELS[row.category] || row.category,
    title: row.title,
    source_observation: row.source_observation,
    focus_note: row.focus_note,
    context_kind: row.context_kind,
    context_label: rules.CONTEXT_LABELS[row.context_kind] || row.context_kind,
    context_note: row.context_note,
    source_type: row.source_type,
    source_id: row.source_id,
    source_href: sourceHref(row),
    account_id: row.account_id,
    customer_label: row.customer_label,
    product_area: row.product_area,
    course_name: row.course_name,
    module_name: row.module_name,
    lesson_name: row.lesson_name,
    impact: row.impact,
    evidence: row.evidence,
    reported_urgency: row.reported_urgency,
    triage_priority: row.triage_priority,
    submitter_name: row.submitter_name,
    submitter_user_id: row.submitter_user_id,
    captured_at: row.captured_at,
    destination_key: row.destination_key,
    destination_label: row.destination_label || row.destination_key,
    accountable_team: row.accountable_team,
    owner_founder_id: row.owner_founder_id,
    owner_name: row.owner_name || null,
    status: row.status,
    status_label: rules.STATUS_LABELS[row.status] || row.status,
    status_reason: row.status_reason,
    resolution_note: row.resolution_note,
    duplicate_of_id: row.duplicate_of_id,
    routing_state: row.routing_state,
    routing_error: triage ? row.routing_error : null,
    external_ref: triage ? row.external_ref : null,
    row_version: row.row_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    delivery_commitment: false,
  };
}

async function isTriager(sql, scope) {
  if (scope?.kind === 'platform') return true;
  if (!scope?.founderId) return false;
  const [row] = await sql`
    SELECT 1 FROM field_feedback_triagers
    WHERE founder_id = ${scope.founderId} AND active = true
  `;
  return Boolean(row);
}

async function assertTriage(sql, scope) {
  if (!(await isTriager(sql, scope))) throw new CrmError(403, 'Triage access is required', 'TRIAGE_DENIED');
}

async function reloadItem(sql, id) {
  const [row] = await sql`
    SELECT i.*, d.label AS destination_label, o.full_name AS owner_name
    FROM field_feedback_items i
    JOIN field_feedback_destinations d ON d.key = i.destination_key
    LEFT JOIN founders o ON o.id = i.owner_founder_id
    WHERE i.id = ${id}
  `;
  return row || null;
}

async function canRead(sql, scope, item) {
  if (await isTriager(sql, scope)) return true;
  if (item.submitter_user_id === scope.actor.id) return true;
  if (scope.founderId && item.submitter_founder_id === scope.founderId) return true;
  if (scope.founderId && item.owner_founder_id === scope.founderId) return true;
  if (scope.founderId && item.account_id) {
    const [account] = await sql`SELECT owner_founder_id FROM crm_accounts WHERE id = ${item.account_id}`;
    if (account?.owner_founder_id === scope.founderId) return true;
  }
  if (scope.founderId) {
    const [destination] = await sql`
      SELECT default_owner_founder_id FROM field_feedback_destinations WHERE key = ${item.destination_key}
    `;
    if (destination?.default_owner_founder_id === scope.founderId) return true;
  }
  return false;
}

async function loadVisibleItem(sql, scope, id) {
  rules.uuidOrNull(id, 'feedback item');
  const item = await reloadItem(sql, id);
  if (!item || !(await canRead(sql, scope, item))) throw new CrmError(404, 'Feedback item not found', 'NOT_FOUND');
  return item;
}

async function audit(tx, { submissionId, itemId, action, actorId, reason, before, after }) {
  await tx`
    INSERT INTO field_feedback_events (submission_id, item_id, action, actor_id, reason, before_state, after_state)
    VALUES (
      ${submissionId || null}, ${itemId || null}, ${action}, ${actorId || null}, ${reason || null},
      ${tx.json(before || {})}, ${tx.json(after || {})}
    )
  `;
  await tx`
    INSERT INTO activity_logs (entity_type, action, actor_id, metadata)
    VALUES ('field_feedback', ${action}, ${actorId || null}, ${tx.json({
      submission_id: submissionId || null,
      item_id: itemId || null,
      reason: reason || null,
      before: before || null,
      after: after || null,
    })})
  `;
}

async function destinationByKey(sql, key) {
  const [row] = await sql`SELECT * FROM field_feedback_destinations WHERE key = ${key} AND active = true`;
  if (!row) throw new CrmError(500, 'Feedback destination is not configured', 'DESTINATION_MISSING');
  return row;
}

async function decide(sql, category) {
  const active = await sql`
    SELECT id, category, destination_key, priority, active
    FROM field_feedback_routing_rules
    WHERE active = true
  `;
  return rules.resolveDestination(active, category);
}

async function founderUserId(schoolSql, founderId) {
  if (!schoolSql || !founderId) return null;
  try {
    const [row] = await schoolSql`SELECT user_id FROM founders WHERE id = ${founderId} LIMIT 1`;
    return row?.user_id || null;
  } catch {
    return null;
  }
}

async function recordNotice(sql, schoolSql, notice) {
  const userId = notice.recipient_user_id || await founderUserId(schoolSql, notice.recipient_founder_id);
  let row;
  try {
    [row] = await sql`
      INSERT INTO field_feedback_notifications (
        item_id, submission_id, event_kind, dedupe_key, recipient_user_id, recipient_founder_id, title, body
      ) VALUES (
        ${notice.item_id}, ${notice.submission_id}, ${notice.event_kind}, ${notice.dedupe_key},
        ${userId}, ${notice.recipient_founder_id || null}, ${notice.title}, ${notice.body}
      )
      ON CONFLICT (item_id, dedupe_key) DO NOTHING
      RETURNING *
    `;
  } catch (err) {
    console.error(JSON.stringify({ component: 'field_feedback', event: 'notice_failed', error: err.message }));
    return;
  }
  if (!row) return;
  if (!schoolSql || !userId) {
    await sql`UPDATE field_feedback_notifications SET channel_state = 'skipped' WHERE id = ${row.id}`;
    return;
  }
  try {
    await schoolSql`
      INSERT INTO notifications (id, user_id, founder_id, title, body, type, created_at)
      VALUES (${row.id}, ${userId}, ${notice.recipient_founder_id || null}, ${notice.title}, ${notice.body}, 'field_feedback', now())
    `;
    await sql`UPDATE field_feedback_notifications SET channel_state = 'delivered' WHERE id = ${row.id}`;
  } catch (err) {
    await sql`
      UPDATE field_feedback_notifications
      SET channel_state = 'unavailable', channel_error = ${String(err.message || 'channel unavailable').slice(0, 200)}
      WHERE id = ${row.id}
    `;
  }
}

async function notifyEntered(sql, schoolSql, item) {
  const destination = await destinationByKey(sql, item.destination_key);
  const recipients = [];
  if (item.owner_founder_id) recipients.push(item.owner_founder_id);
  else if (destination.default_owner_founder_id) recipients.push(destination.default_owner_founder_id);
  else {
    const triagers = await sql`SELECT founder_id FROM field_feedback_triagers WHERE active = true`;
    for (const triager of triagers) recipients.push(triager.founder_id);
  }
  for (const founderId of recipients) {
    await recordNotice(sql, schoolSql, {
      item_id: item.id,
      submission_id: item.submission_id,
      event_kind: 'entered_queue',
      dedupe_key: `entered_queue:${item.destination_key}:${founderId}`,
      recipient_founder_id: founderId,
      title: `Feedback entered ${destination.label}`,
      body: `${item.title} is in the ${destination.label} for ${item.accountable_team}. This is not a delivery commitment.`,
    });
  }
}

async function notifySubmitter(sql, schoolSql, item, eventKind, title, body, dedupe) {
  await recordNotice(sql, schoolSql, {
    item_id: item.id,
    submission_id: item.submission_id,
    event_kind: eventKind,
    dedupe_key: dedupe || `${eventKind}:${item.id}:${item.row_version}`,
    recipient_user_id: item.submitter_user_id,
    recipient_founder_id: item.submitter_founder_id,
    title,
    body,
  });
}

async function defaultAdapter(tx, item) {
  if (failureBudget > 0) {
    failureBudget -= 1;
    throw new Error('Destination queue did not accept the item');
  }
  const [created] = await tx`
    INSERT INTO field_feedback_queue_entries (item_id, destination_key)
    VALUES (${item.id}, ${item.destination_key})
    ON CONFLICT (item_id) DO NOTHING
    RETURNING id
  `;
  if (created) return created.id;
  const [existing] = await tx`SELECT id FROM field_feedback_queue_entries WHERE item_id = ${item.id}`;
  if (!existing) throw new Error('Destination queue did not accept the item');
  return existing.id;
}

async function routeItem(sql, item, actorId, reason) {
  try {
    return await sql.begin(async (tx) => {
      const [locked] = await tx`SELECT * FROM field_feedback_items WHERE id = ${item.id} FOR UPDATE`;
      if (!locked) throw new CrmError(404, 'Feedback item not found', 'NOT_FOUND');
      const [existing] = await tx`SELECT id FROM field_feedback_queue_entries WHERE item_id = ${locked.id}`;
      if (existing) {
        if (locked.routing_state !== 'routed') {
          await tx`
            UPDATE field_feedback_items
            SET routing_state = 'routed', external_ref = ${String(existing.id)}, routing_error = NULL,
                routed_at = COALESCE(routed_at, now()), row_version = row_version + 1, updated_at = now()
            WHERE id = ${locked.id}
          `;
        }
        return { created: false, routing_state: 'routed', queue_id: existing.id };
      }
      const queueId = await (routingAdapter || defaultAdapter)(tx, locked);
      await tx`
        UPDATE field_feedback_items
        SET routing_state = 'routed', external_ref = ${String(queueId)}, routing_error = NULL,
            routing_attempts = routing_attempts + 1, routed_at = now(),
            row_version = row_version + 1, updated_at = now()
        WHERE id = ${locked.id}
      `;
      await tx`
        INSERT INTO field_feedback_routing_history
          (item_id, from_category, to_category, from_destination, to_destination, reason, actor_id)
        VALUES (
          ${locked.id}, ${null}, ${locked.category}, ${null}, ${locked.destination_key},
          ${reason || 'Initial routing rule'}, ${actorId}
        )
      `;
      await audit(tx, {
        submissionId: locked.submission_id,
        itemId: locked.id,
        action: 'route',
        actorId,
        reason: reason || 'Initial routing rule',
        before: { routing_state: locked.routing_state, destination_key: locked.destination_key },
        after: { routing_state: 'routed', destination_key: locked.destination_key, external_ref: String(queueId) },
      });
      return { created: true, routing_state: 'routed', queue_id: queueId };
    });
  } catch (err) {
    if (err instanceof CrmError) throw err;
    const message = String(err.message || 'routing failed').slice(0, 300);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE field_feedback_items
        SET routing_state = 'failed', routing_error = ${message},
            routing_attempts = routing_attempts + 1, row_version = row_version + 1, updated_at = now()
        WHERE id = ${item.id}
      `;
      await tx`
        INSERT INTO field_feedback_routing_history
          (item_id, from_category, to_category, from_destination, to_destination, reason, actor_id)
        VALUES (
          ${item.id}, ${item.category}, ${item.category}, ${item.destination_key}, ${item.destination_key},
          ${message}, ${actorId}
        )
      `;
      await audit(tx, {
        submissionId: item.submission_id,
        itemId: item.id,
        action: 'route_failed',
        actorId,
        reason: message,
        before: { routing_state: item.routing_state },
        after: { routing_state: 'failed', destination_key: item.destination_key },
      });
    });
    return { created: false, routing_state: 'failed', error: message };
  }
}

const ROUTE_REASONS = {
  rule: 'Initial routing rule',
  conflict: 'Conflicting routing rules',
  no_rule: 'No routing rule',
  triage: 'Triager selected destination',
};

async function resolveSource(sql, scope, input) {
  let accountId = input.account_id;
  let customerLabel = input.customer_label;
  const prefill = {};
  if (input.source_type === 'enquiry' || input.source_type === 'account' || input.source_type === 'school') {
    rules.uuidOrNull(input.source_id, 'source id');
  }
  if (input.source_type === 'enquiry') {
    const [lead] = await sql`
      SELECT id, name, organization, account_id, assigned_to
      FROM enquiries WHERE id = ${input.source_id}
    `;
    assertLeadAccess(scope, lead);
    if (accountId && lead.account_id && accountId !== lead.account_id) {
      throw new CrmError(400, 'Account does not match the source enquiry', 'VALIDATION', { field: 'account_id' });
    }
    accountId = accountId || lead.account_id || null;
    customerLabel = customerLabel || lead.organization || lead.name || null;
    prefill.enquiry_id = lead.id;
    prefill.organization = lead.organization || null;
  }
  if (input.source_type === 'account' || input.source_type === 'school') {
    if (accountId && accountId !== input.source_id) {
      throw new CrmError(400, 'Account does not match the source record', 'VALIDATION', { field: 'account_id' });
    }
    accountId = input.source_id;
  }
  if (accountId) {
    const [account] = await sql`SELECT id, name, owner_founder_id FROM crm_accounts WHERE id = ${accountId}`;
    assertAccountAccess(scope, account);
    customerLabel = customerLabel || account.name;
    prefill.account_name = account.name;
  }
  return { accountId, customerLabel, prefill };
}

function itemSnapshot(input, source, destination, decision, scope, capturedAt) {
  return {
    category: input.feedback_type,
    title: input.title,
    source_observation: input.observation,
    focus_note: null,
    context_kind: input.context_kind,
    context_note: input.context_note,
    source_type: input.source_type,
    source_id: input.source_id,
    account_id: source.accountId,
    customer_label: source.customerLabel,
    product_area: input.product_area,
    course_name: input.course_name,
    module_name: input.module_name,
    lesson_name: input.lesson_name,
    impact: input.impact,
    evidence: input.evidence,
    reported_urgency: input.reported_urgency,
    submitter_user_id: scope.actor.id,
    submitter_founder_id: scope.founderId,
    submitter_name: scope.actor.fullName || scope.actor.email || null,
    captured_at: capturedAt,
    destination_key: decision.destination_key,
    accountable_team: destination.accountable_team,
  };
}

async function insertItem(tx, submissionId, sequenceNo, snapshot) {
  const [row] = await tx`
    INSERT INTO field_feedback_items (
      submission_id, sequence_no, category, title, source_observation, focus_note,
      context_kind, context_note, source_type, source_id, account_id, customer_label,
      product_area, course_name, module_name, lesson_name, impact, evidence, reported_urgency,
      submitter_user_id, submitter_founder_id, submitter_name, captured_at,
      destination_key, accountable_team, status, routing_state
    ) VALUES (
      ${submissionId}, ${sequenceNo}, ${snapshot.category}, ${snapshot.title}, ${snapshot.source_observation}, ${snapshot.focus_note},
      ${snapshot.context_kind}, ${snapshot.context_note}, ${snapshot.source_type}, ${snapshot.source_id},
      ${snapshot.account_id}, ${snapshot.customer_label}, ${snapshot.product_area}, ${snapshot.course_name},
      ${snapshot.module_name}, ${snapshot.lesson_name}, ${snapshot.impact}, ${snapshot.evidence}, ${snapshot.reported_urgency},
      ${snapshot.submitter_user_id}, ${snapshot.submitter_founder_id}, ${snapshot.submitter_name}, ${snapshot.captured_at},
      ${snapshot.destination_key}, ${snapshot.accountable_team}, 'new', 'pending'
    )
    RETURNING id
  `;
  return row.id;
}

async function createSubmission(sql, scope, body, schoolSql) {
  assertCrmWrite(scope);
  const input = rules.validateSubmission(body);
  const [existing] = await sql`SELECT * FROM field_feedback_submissions WHERE client_key = ${input.client_key}`;
  if (existing) {
    if (existing.payload_hash !== input.payload_hash) {
      throw new CrmError(409, 'This draft was already submitted with different details.', 'IDEMPOTENCY_CONFLICT');
    }
    const [primary] = await sql`
      SELECT id FROM field_feedback_items
      WHERE submission_id = ${existing.id} AND sequence_no = 0
    `;
    const item = await reloadItem(sql, primary.id);
    if (!(await canRead(sql, scope, item))) throw new CrmError(404, 'Feedback item not found', 'NOT_FOUND');
    const triage = await isTriager(sql, scope);
    return {
      replay: true,
      delivery_commitment: false,
      hint: rules.mixedIssueHint(existing.observation),
      destination: {
        key: item.destination_key,
        label: item.destination_label,
        accountable_team: item.accountable_team,
        routing_reason: 'replay',
      },
      submission: { id: existing.id, created_at: existing.created_at, title: existing.title, feedback_type: existing.feedback_type },
      item: presentItem(item, { triage }),
    };
  }

  const source = await resolveSource(sql, scope, input);
  const decision = await decide(sql, input.feedback_type);
  const destination = await destinationByKey(sql, decision.destination_key);
  const capturedAt = new Date().toISOString();
  const snapshot = itemSnapshot(input, source, destination, decision, scope, capturedAt);
  let itemId;
  let submissionId;
  await sql.begin(async (tx) => {
    const [submission] = await tx`
      INSERT INTO field_feedback_submissions (
        client_key, payload_hash, feedback_type, title, observation, context_kind, context_note,
        source_type, source_id, account_id, customer_label, product_area, course_name, module_name, lesson_name,
        impact, reported_urgency, evidence, submitter_user_id, submitter_founder_id, submitter_name, submitter_email, prefill
      ) VALUES (
        ${input.client_key}, ${input.payload_hash}, ${input.feedback_type}, ${input.title}, ${input.observation},
        ${input.context_kind}, ${input.context_note}, ${input.source_type}, ${input.source_id}, ${source.accountId},
        ${source.customerLabel}, ${input.product_area}, ${input.course_name}, ${input.module_name}, ${input.lesson_name},
        ${input.impact}, ${input.reported_urgency}, ${input.evidence}, ${scope.actor.id}, ${scope.founderId},
        ${snapshot.submitter_name}, ${scope.actor.email || null}, ${tx.json(source.prefill)}
      )
      RETURNING id, created_at
    `;
    submissionId = submission.id;
    for (const file of input.attachments) {
      await tx`
        INSERT INTO field_feedback_attachments (submission_id, file_name, content_type, byte_size, checksum, content)
        VALUES (${submission.id}, ${file.file_name}, ${file.content_type}, ${file.byte_size}, ${file.checksum}, ${file.content})
      `;
    }
    itemId = await insertItem(tx, submission.id, 0, snapshot);
    await audit(tx, {
      submissionId: submission.id,
      itemId,
      action: 'capture',
      actorId: scope.actor.id,
      reason: null,
      before: null,
      after: { category: input.feedback_type, destination_key: decision.destination_key, routing_reason: decision.routing_reason },
    });
  });

  const pending = await reloadItem(sql, itemId);
  const outcome = await routeItem(sql, pending, scope.actor.id, ROUTE_REASONS[decision.routing_reason] || 'Initial routing rule');
  const item = await reloadItem(sql, itemId);
  if (outcome.created) await notifyEntered(sql, schoolSql, item);
  const triage = await isTriager(sql, scope);
  return {
    replay: false,
    delivery_commitment: false,
    hint: rules.mixedIssueHint(input.observation),
    destination: {
      key: destination.key,
      label: destination.label,
      accountable_team: destination.accountable_team,
      routing_reason: decision.routing_reason,
    },
    submission: { id: submissionId, created_at: item.captured_at, title: input.title, feedback_type: input.feedback_type },
    item: presentItem(item, { triage }),
  };
}

async function preview(sql, scope, body) {
  if (!scope?.actor?.id) throw new CrmError(401, 'Authentication required', 'UNAUTHENTICATED');
  const category = rules.enumValue(body?.feedback_type, rules.CATEGORIES, 'feedback type', { required: true });
  const decision = await decide(sql, category);
  const destination = await destinationByKey(sql, decision.destination_key);
  return {
    destination_key: destination.key,
    destination_label: destination.label,
    accountable_team: destination.accountable_team,
    routing_reason: decision.routing_reason,
    delivery_commitment: false,
    hint: rules.mixedIssueHint(body?.observation),
  };
}

function parseFilters(query) {
  const view = query.view || 'mine';
  if (!rules.VIEWS.includes(view)) throw new CrmError(400, 'Unknown feedback view', 'BAD_VIEW');
  const category = rules.enumValue(query.category, rules.CATEGORIES, 'category');
  const status = rules.enumValue(query.status, rules.STATUSES, 'status');
  const owner = rules.uuidOrNull(query.owner, 'owner');
  const account = rules.uuidOrNull(query.account, 'account');
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && Number.isNaN(from.getTime())) throw new CrmError(400, 'from is not a valid date', 'VALIDATION', { field: 'from' });
  if (to && Number.isNaN(to.getTime())) throw new CrmError(400, 'to is not a valid date', 'VALIDATION', { field: 'to' });
  return { view, category, status, owner, account, from, to, area: query.area || '', q: query.q || '' };
}

function whereFor(sql, scope, parsed, triage) {
  const founderId = scope.kind === 'platform' ? null : scope.founderId;
  const actorId = scope.actor.id;
  const conditions = [];
  if (!triage) {
    conditions.push(sql`(
      s.submitter_user_id = ${actorId}
      OR (${founderId}::uuid IS NOT NULL AND s.submitter_founder_id = ${founderId})
      OR (${founderId}::uuid IS NOT NULL AND i.owner_founder_id = ${founderId})
      OR (
        ${founderId}::uuid IS NOT NULL AND i.account_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM crm_accounts a WHERE a.id = i.account_id AND a.owner_founder_id = ${founderId}
        )
      )
      OR EXISTS (
        SELECT 1 FROM field_feedback_destinations d
        WHERE d.key = i.destination_key AND d.default_owner_founder_id = ${founderId}
      )
    )`);
  }
  if (parsed.view === 'mine') {
    conditions.push(sql`(
      s.submitter_user_id = ${actorId}
      OR (${founderId}::uuid IS NOT NULL AND s.submitter_founder_id = ${founderId})
    )`);
  } else if (parsed.view === 'triage') {
    conditions.push(sql`(i.destination_key = 'triage' OR i.routing_state IN ('failed', 'pending'))`);
  } else {
    conditions.push(sql`i.destination_key = ${parsed.view}`);
  }
  if (parsed.category) conditions.push(sql`i.category = ${parsed.category}`);
  if (parsed.status) conditions.push(sql`i.status = ${parsed.status}`);
  if (parsed.owner) conditions.push(sql`i.owner_founder_id = ${parsed.owner}`);
  if (parsed.account) conditions.push(sql`i.account_id = ${parsed.account}`);
  if (parsed.from) conditions.push(sql`s.created_at >= ${parsed.from.toISOString()}`);
  if (parsed.to) conditions.push(sql`s.created_at <= ${parsed.to.toISOString()}`);
  if (String(parsed.area).trim()) {
    const area = `%${escapeLike(parsed.area)}%`;
    conditions.push(sql`(
      COALESCE(i.product_area, '') ILIKE ${area} ESCAPE '\\'
      OR COALESCE(i.course_name, '') ILIKE ${area} ESCAPE '\\'
      OR COALESCE(i.module_name, '') ILIKE ${area} ESCAPE '\\'
      OR COALESCE(i.lesson_name, '') ILIKE ${area} ESCAPE '\\'
    )`);
  }
  if (String(parsed.q).trim()) {
    const term = `%${escapeLike(parsed.q)}%`;
    conditions.push(sql`(
      i.title ILIKE ${term} ESCAPE '\\'
      OR i.source_observation ILIKE ${term} ESCAPE '\\'
      OR COALESCE(i.customer_label, '') ILIKE ${term} ESCAPE '\\'
    )`);
  }
  return conditions.map((condition, index) => (index === 0 ? condition : sql`AND ${condition}`));
}

async function listItems(sql, scope, query) {
  const triage = await isTriager(sql, scope);
  const parsed = parseFilters(query);
  if (parsed.view === 'triage' && !triage) throw new CrmError(403, 'Triage access is required', 'TRIAGE_DENIED');
  const items = await sql`
    SELECT i.*, d.label AS destination_label, o.full_name AS owner_name
    FROM field_feedback_items i
    JOIN field_feedback_submissions s ON s.id = i.submission_id
    JOIN field_feedback_destinations d ON d.key = i.destination_key
    LEFT JOIN founders o ON o.id = i.owner_founder_id
    WHERE ${whereFor(sql, scope, parsed, triage)}
    ORDER BY i.updated_at DESC
    LIMIT 100
  `;
  const [counts] = await sql`
    SELECT COUNT(DISTINCT s.id)::int AS total_reports,
           COUNT(DISTINCT i.account_id)::int AS distinct_accounts
    FROM field_feedback_items i
    JOIN field_feedback_submissions s ON s.id = i.submission_id
    WHERE ${whereFor(sql, scope, parsed, triage)}
  `;
  return {
    view: parsed.view,
    items: items.map((item) => presentItem(item, { triage })),
    counts: {
      total_reports: counts?.total_reports || 0,
      distinct_accounts: counts?.distinct_accounts || 0,
    },
    permissions: { triage, write: Boolean(scope.canWrite) },
    delivery_commitment: false,
  };
}

async function findSuggestions(sql, item) {
  const candidates = await sql`
    SELECT i.id, i.title, i.category, i.status, i.submission_id, i.customer_label, i.account_id
    FROM field_feedback_items i
    WHERE i.id <> ${item.id}
      AND i.status NOT IN ('duplicate', 'declined')
      AND (
        i.category = ${item.category}
        OR (${item.account_id}::uuid IS NOT NULL AND i.account_id = ${item.account_id})
        OR lower(i.title) = lower(${item.title})
      )
    ORDER BY i.created_at DESC
    LIMIT 50
  `;
  const tokens = rules.titleTokens(item.title);
  return candidates.filter((candidate) => {
    if (candidate.title.trim().toLowerCase() === item.title.trim().toLowerCase()) return true;
    if (candidate.account_id && candidate.account_id === item.account_id && candidate.category === item.category) return true;
    const overlap = [...rules.titleTokens(candidate.title)].filter((token) => tokens.has(token));
    return overlap.length >= 2;
  }).slice(0, 5).map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    category: candidate.category,
    status: candidate.status,
    submission_id: candidate.submission_id,
    customer_label: candidate.customer_label,
    auto_merge: false,
  }));
}

async function getItem(sql, scope, id) {
  const triage = await isTriager(sql, scope);
  const item = await loadVisibleItem(sql, scope, id);
  const [submission] = await sql`SELECT * FROM field_feedback_submissions WHERE id = ${item.submission_id}`;
  const attachments = await sql`
    SELECT id, file_name, content_type, byte_size, created_at
    FROM field_feedback_attachments
    WHERE submission_id = ${item.submission_id}
    ORDER BY created_at
  `;
  const seeInternal = triage || (scope.founderId && item.owner_founder_id === scope.founderId);
  const comments = seeInternal
    ? await sql`
      SELECT id, author_user_id, author_name, body, kind, visibility, created_at
      FROM field_feedback_comments WHERE item_id = ${item.id} ORDER BY created_at
    `
    : await sql`
      SELECT id, author_user_id, author_name, body, kind, visibility, created_at
      FROM field_feedback_comments WHERE item_id = ${item.id} AND visibility = 'shared' ORDER BY created_at
    `;
  const history = await sql`
    SELECT id, from_category, to_category, from_destination, to_destination, reason, actor_id, created_at
    FROM field_feedback_routing_history
    WHERE item_id = ${item.id}
    ORDER BY created_at
  `;
  const links = await sql`
    SELECT id, item_id, related_item_id, link_type, created_at
    FROM field_feedback_item_links
    WHERE item_id = ${item.id} OR related_item_id = ${item.id}
    ORDER BY created_at
  `;
  const owners = triage
    ? await sql`SELECT id, full_name FROM founders WHERE is_active = true ORDER BY full_name LIMIT 100`
    : [];
  return {
    item: presentItem(item, { triage }),
    submission: {
      id: submission.id,
      feedback_type: submission.feedback_type,
      title: submission.title,
      observation: submission.observation,
      context_kind: submission.context_kind,
      customer_label: submission.customer_label,
      created_at: submission.created_at,
      submitter_name: submission.submitter_name,
    },
    attachments,
    comments,
    history,
    links,
    suggestions: triage ? await findSuggestions(sql, item) : [],
    owners,
    permissions: {
      triage,
      write: Boolean(scope.canWrite),
      submitter: submission.submitter_user_id === scope.actor.id,
    },
    delivery_commitment: false,
  };
}

function expectedVersion(body) {
  const version = Number(body?.expected_version);
  if (!Number.isInteger(version) || version < 1) {
    throw new CrmError(400, 'expected_version is required', 'VALIDATION', { field: 'expected_version' });
  }
  return version;
}

async function reroute(sql, scope, id, body, schoolSql) {
  await assertTriage(sql, scope);
  const reason = rules.reasonText(body?.reason);
  const version = expectedVersion(body);
  const current = await loadVisibleItem(sql, scope, id);
  if (current.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
  const nextCategory = body?.category ? rules.enumValue(body.category, rules.CATEGORIES, 'category', { required: true }) : current.category;
  let nextDestination = body?.destination_key
    ? rules.enumValue(body.destination_key, rules.DESTINATIONS, 'destination', { required: true })
    : null;
  let routingReason = 'triage';
  if (!nextDestination) {
    const decision = await decide(sql, nextCategory);
    nextDestination = decision.destination_key;
    routingReason = decision.routing_reason;
  }
  if (nextCategory === current.category && nextDestination === current.destination_key) {
    throw new CrmError(400, 'Choose a different category or destination', 'VALIDATION');
  }
  const destination = await destinationByKey(sql, nextDestination);
  const [updated] = await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE field_feedback_items
      SET category = ${nextCategory},
          destination_key = ${nextDestination},
          accountable_team = ${destination.accountable_team},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${id} AND row_version = ${version}
      RETURNING *
    `;
    if (!row) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
    const [queue] = await tx`SELECT id FROM field_feedback_queue_entries WHERE item_id = ${id}`;
    if (queue) {
      await tx`UPDATE field_feedback_queue_entries SET destination_key = ${nextDestination} WHERE item_id = ${id}`;
    }
    await tx`
      INSERT INTO field_feedback_routing_history
        (item_id, from_category, to_category, from_destination, to_destination, reason, actor_id)
      VALUES (${id}, ${current.category}, ${nextCategory}, ${current.destination_key}, ${nextDestination}, ${reason}, ${scope.actor.id})
    `;
    if (nextCategory !== current.category) {
      await audit(tx, {
        submissionId: current.submission_id,
        itemId: id,
        action: 'reclassify',
        actorId: scope.actor.id,
        reason,
        before: { category: current.category },
        after: { category: nextCategory },
      });
    }
    if (nextDestination !== current.destination_key) {
      await audit(tx, {
        submissionId: current.submission_id,
        itemId: id,
        action: 'reroute',
        actorId: scope.actor.id,
        reason,
        before: { destination_key: current.destination_key },
        after: { destination_key: nextDestination },
      });
    }
    return [row];
  });
  let outcome = { created: false };
  if (updated.routing_state !== 'routed') {
    outcome = await routeItem(sql, await reloadItem(sql, id), scope.actor.id, ROUTE_REASONS[routingReason] || reason);
  }
  const item = await reloadItem(sql, id);
  if (outcome.created || nextDestination !== current.destination_key) await notifyEntered(sql, schoolSql, item);
  return { item: presentItem(item, { triage: true }), delivery_commitment: false };
}

async function splitItem(sql, scope, id, body, schoolSql) {
  await assertTriage(sql, scope);
  const reason = rules.reasonText(body?.reason);
  const version = expectedVersion(body);
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  if (!parts.length || parts.length > 5) throw new CrmError(400, 'Split into 1 to 5 linked items', 'VALIDATION', { field: 'parts' });
  const current = await loadVisibleItem(sql, scope, id);
  if (current.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
  const [submission] = await sql`SELECT * FROM field_feedback_submissions WHERE id = ${current.submission_id}`;
  const prepared = [];
  for (const part of parts) {
    const category = rules.enumValue(part?.category, rules.CATEGORIES, 'category', { required: true });
    const title = rules.cleanText(part?.title, 140, 'title', { required: true, min: 3 });
    const focus = rules.cleanText(part?.observation, 4000, 'issue note');
    const decision = part?.destination_key
      ? { destination_key: rules.enumValue(part.destination_key, rules.DESTINATIONS, 'destination', { required: true }), routing_reason: 'triage' }
      : await decide(sql, category);
    const destination = await destinationByKey(sql, decision.destination_key);
    prepared.push({ category, title, focus, decision, destination });
  }
  const createdIds = [];
  await sql.begin(async (tx) => {
    const [locked] = await tx`SELECT * FROM field_feedback_items WHERE id = ${id} FOR UPDATE`;
    if (!locked || locked.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
    const [maxRow] = await tx`SELECT COALESCE(MAX(sequence_no), 0)::int AS max_seq FROM field_feedback_items WHERE submission_id = ${locked.submission_id}`;
    let sequence = maxRow.max_seq;
    await tx`UPDATE field_feedback_items SET row_version = row_version + 1, updated_at = now() WHERE id = ${id}`;
    for (const part of prepared) {
      sequence += 1;
      const snapshot = {
        category: part.category,
        title: part.title,
        source_observation: submission.observation,
        focus_note: part.focus,
        context_kind: submission.context_kind,
        context_note: submission.context_note,
        source_type: submission.source_type,
        source_id: submission.source_id,
        account_id: submission.account_id,
        customer_label: submission.customer_label,
        product_area: submission.product_area,
        course_name: submission.course_name,
        module_name: submission.module_name,
        lesson_name: submission.lesson_name,
        impact: submission.impact,
        evidence: submission.evidence,
        reported_urgency: submission.reported_urgency,
        submitter_user_id: submission.submitter_user_id,
        submitter_founder_id: submission.submitter_founder_id,
        submitter_name: submission.submitter_name,
        captured_at: submission.created_at,
        destination_key: part.destination.key,
        accountable_team: part.destination.accountable_team,
      };
      const newId = await insertItem(tx, submission.id, sequence, snapshot);
      createdIds.push(newId);
      await tx`
        INSERT INTO field_feedback_item_links (submission_id, item_id, related_item_id, link_type)
        VALUES (${submission.id}, ${id}, ${newId}, 'split')
      `;
      await audit(tx, {
        submissionId: submission.id,
        itemId: newId,
        action: 'split',
        actorId: scope.actor.id,
        reason,
        before: { original_item_id: id },
        after: { category: part.category, destination_key: part.destination.key },
      });
    }
  });
  const items = [];
  for (const newId of createdIds) {
    const pending = await reloadItem(sql, newId);
    const outcome = await routeItem(sql, pending, scope.actor.id, 'Split from the original submission');
    const fresh = await reloadItem(sql, newId);
    if (outcome.created) await notifyEntered(sql, schoolSql, fresh);
    items.push(presentItem(fresh, { triage: true }));
  }
  const [original] = await sql`SELECT observation, title, feedback_type FROM field_feedback_submissions WHERE id = ${submission.id}`;
  return {
    original_submission: original,
    original_item: presentItem(await reloadItem(sql, id), { triage: true }),
    items,
    delivery_commitment: false,
  };
}

async function linkDuplicate(sql, scope, id, body, schoolSql) {
  await assertTriage(sql, scope);
  const reason = rules.reasonText(body?.reason);
  const version = expectedVersion(body);
  const duplicateOf = rules.uuidOrNull(body?.duplicate_of_id, 'duplicate of');
  if (!duplicateOf) throw new CrmError(400, 'duplicate of is required', 'VALIDATION', { field: 'duplicate_of_id' });
  if (duplicateOf === id) throw new CrmError(400, 'An item cannot be a duplicate of itself', 'VALIDATION');
  const current = await loadVisibleItem(sql, scope, id);
  const related = await reloadItem(sql, duplicateOf);
  if (!related) throw new CrmError(404, 'The related feedback item was not found', 'NOT_FOUND');
  if (current.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
  await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE field_feedback_items
      SET status = 'duplicate', duplicate_of_id = ${duplicateOf}, status_reason = ${reason}, resolution_note = ${reason},
          row_version = row_version + 1, updated_at = now()
      WHERE id = ${id} AND row_version = ${version}
      RETURNING id
    `;
    if (!row) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
    await tx`
      INSERT INTO field_feedback_item_links (submission_id, item_id, related_item_id, link_type)
      VALUES (${current.submission_id}, ${id}, ${duplicateOf}, 'duplicate')
      ON CONFLICT (item_id, related_item_id, link_type) DO NOTHING
    `;
    await audit(tx, {
      submissionId: current.submission_id,
      itemId: id,
      action: 'duplicate_link',
      actorId: scope.actor.id,
      reason,
      before: { status: current.status },
      after: { status: 'duplicate', duplicate_of_id: duplicateOf },
    });
  });
  const item = await reloadItem(sql, id);
  await notifySubmitter(
    sql,
    schoolSql,
    item,
    'resolved',
    'Feedback marked as duplicate',
    `${item.title} was linked as a duplicate. ${reason} This is not a delivery commitment.`,
    `duplicate:${id}:${duplicateOf}`,
  );
  return { item: presentItem(item, { triage: true }), preserved_submission_id: current.submission_id, related_submission_id: related.submission_id };
}

async function setStatus(sql, scope, id, body, schoolSql) {
  await assertTriage(sql, scope);
  if (body?.status === 'duplicate') return linkDuplicate(sql, scope, id, body, schoolSql);
  const version = expectedVersion(body);
  const current = await loadVisibleItem(sql, scope, id);
  if (current.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
  const status = body?.status ? rules.enumValue(body.status, rules.STATUSES, 'status', { required: true }) : current.status;
  const priority = Object.prototype.hasOwnProperty.call(body || {}, 'triage_priority')
    ? rules.enumValue(body.triage_priority, rules.PRIORITIES, 'priority')
    : current.triage_priority;
  if (status === current.status && priority === current.triage_priority) {
    throw new CrmError(400, 'No status or priority change was provided', 'VALIDATION');
  }
  const reason = rules.REASON_STATUSES.has(status) || status !== current.status || priority !== current.triage_priority
    ? rules.reasonText(body?.reason)
    : null;
  await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE field_feedback_items
      SET status = ${status},
          triage_priority = ${priority},
          status_reason = ${reason || current.status_reason},
          resolution_note = ${status === 'resolved' || status === 'declined' ? reason : current.resolution_note},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${id} AND row_version = ${version}
      RETURNING id
    `;
    if (!row) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
    await audit(tx, {
      submissionId: current.submission_id,
      itemId: id,
      action: 'status',
      actorId: scope.actor.id,
      reason,
      before: { status: current.status, triage_priority: current.triage_priority },
      after: { status, triage_priority: priority },
    });
  });
  const item = await reloadItem(sql, id);
  if (status === 'needs_clarification') {
    await notifySubmitter(sql, schoolSql, item, 'clarification', 'Clarification requested on your feedback', `${item.title}: ${reason}`);
  }
  if (status === 'resolved' || status === 'declined') {
    await notifySubmitter(
      sql,
      schoolSql,
      item,
      'resolved',
      status === 'resolved' ? 'Feedback resolved' : 'Feedback declined',
      `${item.title}: ${reason} This is not a delivery commitment.`,
    );
  }
  return { item: presentItem(item, { triage: true }), delivery_commitment: false };
}

async function setOwner(sql, scope, id, body, schoolSql) {
  await assertTriage(sql, scope);
  const reason = rules.reasonText(body?.reason);
  const version = expectedVersion(body);
  const ownerId = rules.uuidOrNull(body?.owner_founder_id, 'owner');
  const current = await loadVisibleItem(sql, scope, id);
  if (current.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
  if (ownerId) {
    const [founder] = await sql`SELECT id FROM founders WHERE id = ${ownerId} AND is_active = true`;
    if (!founder) throw new CrmError(400, 'Owner is not an active founder', 'VALIDATION', { field: 'owner_founder_id' });
  }
  await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE field_feedback_items
      SET owner_founder_id = ${ownerId}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${id} AND row_version = ${version}
      RETURNING id
    `;
    if (!row) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
    await audit(tx, {
      submissionId: current.submission_id,
      itemId: id,
      action: 'owner',
      actorId: scope.actor.id,
      reason,
      before: { owner_founder_id: current.owner_founder_id },
      after: { owner_founder_id: ownerId },
    });
  });
  const item = await reloadItem(sql, id);
  if (ownerId) {
    await recordNotice(sql, schoolSql, {
      item_id: item.id,
      submission_id: item.submission_id,
      event_kind: 'owner_assigned',
      dedupe_key: `owner_assigned:${ownerId}:${item.row_version}`,
      recipient_founder_id: ownerId,
      title: `You own a ${item.destination_label} item`,
      body: `${item.title} was assigned to you. This is not a delivery commitment.`,
    });
  }
  return { item: presentItem(item, { triage: true }) };
}

async function addComment(sql, scope, id, body, schoolSql) {
  const item = await loadVisibleItem(sql, scope, id);
  const text = rules.cleanText(body?.body, 2000, 'comment', { required: true, min: 2 });
  const requested = body?.kind === 'clarification_request';
  if (requested) await assertTriage(sql, scope);
  const kind = requested ? 'clarification_request' : 'comment';
  const triage = await isTriager(sql, scope);
  const isSubmitter = item.submitter_user_id === scope.actor.id;
  const visibility = requested || isSubmitter || !triage ? 'shared' : 'internal';
  const [comment] = await sql.begin(async (tx) => {
    const [created] = await tx`
      INSERT INTO field_feedback_comments (item_id, author_user_id, author_name, body, kind, visibility)
      VALUES (${item.id}, ${scope.actor.id}, ${scope.actor.fullName || scope.actor.email || null}, ${text}, ${kind}, ${visibility})
      RETURNING id, author_user_id, author_name, body, kind, visibility, created_at
    `;
    await audit(tx, {
      submissionId: item.submission_id,
      itemId: item.id,
      action: kind,
      actorId: scope.actor.id,
      reason: text.slice(0, 500),
      before: null,
      after: { comment_id: created.id, visibility },
    });
    return [created];
  });
  if (requested) {
    if (!['resolved', 'duplicate', 'declined'].includes(item.status)) {
      await sql`
        UPDATE field_feedback_items
        SET status = 'needs_clarification', status_reason = ${text.slice(0, 500)},
            row_version = row_version + 1, updated_at = now()
        WHERE id = ${item.id}
      `;
    }
    const fresh = await reloadItem(sql, item.id);
    await notifySubmitter(
      sql,
      schoolSql,
      fresh,
      'clarification',
      'Clarification requested on your feedback',
      `${fresh.title}: ${text}`,
      `clarification:${comment.id}`,
    );
  }
  return { comment, item: presentItem(await reloadItem(sql, item.id), { triage }) };
}

async function retryRouting(sql, scope, id, body, schoolSql) {
  await assertTriage(sql, scope);
  const version = expectedVersion(body);
  const current = await loadVisibleItem(sql, scope, id);
  if (current.row_version !== version) throw new CrmError(409, 'This feedback item changed. Reload it and try again.', 'VERSION_CONFLICT');
  const outcome = await routeItem(sql, current, scope.actor.id, 'Retry routing');
  const item = await reloadItem(sql, id);
  if (outcome.created) await notifyEntered(sql, schoolSql, item);
  const [queueCount] = await sql`SELECT COUNT(*)::int AS count FROM field_feedback_queue_entries WHERE item_id = ${id}`;
  return { item: presentItem(item, { triage: true }), queue_entries: queueCount.count, created_queue_entry: outcome.created };
}

async function readAttachment(sql, scope, id) {
  rules.uuidOrNull(id, 'attachment');
  const [file] = await sql`
    SELECT a.*, i.id AS item_id
    FROM field_feedback_attachments a
    JOIN field_feedback_items i ON i.submission_id = a.submission_id AND i.sequence_no = 0
    WHERE a.id = ${id}
  `;
  if (!file) throw new CrmError(404, 'Attachment not found', 'NOT_FOUND');
  const item = await reloadItem(sql, file.item_id);
  if (!item || !(await canRead(sql, scope, item))) throw new CrmError(404, 'Attachment not found', 'NOT_FOUND');
  return {
    id: file.id,
    file_name: file.file_name,
    content_type: file.content_type,
    byte_size: file.byte_size,
    content_base64: attachmentBytes(file.content).toString('base64'),
  };
}

function attachmentBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/, ''), 'hex');
  return Buffer.from(value || []);
}

async function listRules(sql) {
  return sql`
    SELECT r.id, r.category, r.destination_key, r.priority, r.active, d.label AS destination_label, d.accountable_team
    FROM field_feedback_routing_rules r
    JOIN field_feedback_destinations d ON d.key = r.destination_key
    ORDER BY r.category, r.priority, r.created_at
  `;
}

async function addRule(sql, scope, body) {
  await assertTriage(sql, scope);
  const category = rules.enumValue(body?.category, rules.CATEGORIES, 'category', { required: true });
  const destinationKey = rules.enumValue(body?.destination_key, rules.DESTINATIONS, 'destination', { required: true });
  const priority = Number(body?.priority ?? 10);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    throw new CrmError(400, 'priority must be an integer from 0 to 1000', 'VALIDATION', { field: 'priority' });
  }
  await destinationByKey(sql, destinationKey);
  const [row] = await sql`
    INSERT INTO field_feedback_routing_rules (category, destination_key, priority, active)
    VALUES (${category}, ${destinationKey}, ${priority}, ${body?.active !== false})
    RETURNING *
  `;
  await sql.begin((tx) => audit(tx, {
    action: 'routing_rule',
    actorId: scope.actor.id,
    reason: rules.cleanText(body?.reason, 500, 'reason') || 'Routing rule added',
    after: { id: row.id, category, destination_key: destinationKey, active: row.active },
  }));
  return row;
}

async function updateRule(sql, scope, id, body) {
  await assertTriage(sql, scope);
  rules.uuidOrNull(id, 'rule');
  const reason = rules.reasonText(body?.reason);
  const [existing] = await sql`SELECT * FROM field_feedback_routing_rules WHERE id = ${id}`;
  if (!existing) throw new CrmError(404, 'Routing rule not found', 'NOT_FOUND');
  const destinationKey = body?.destination_key
    ? rules.enumValue(body.destination_key, rules.DESTINATIONS, 'destination', { required: true })
    : existing.destination_key;
  const priority = body?.priority == null ? existing.priority : Number(body.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    throw new CrmError(400, 'priority must be an integer from 0 to 1000', 'VALIDATION', { field: 'priority' });
  }
  const active = body?.active == null ? existing.active : Boolean(body.active);
  const [row] = await sql`
    UPDATE field_feedback_routing_rules
    SET destination_key = ${destinationKey}, priority = ${priority}, active = ${active}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  await sql.begin((tx) => audit(tx, {
    action: 'routing_rule',
    actorId: scope.actor.id,
    reason,
    before: { destination_key: existing.destination_key, active: existing.active },
    after: { destination_key: row.destination_key, active: row.active },
  }));
  return row;
}

async function listDestinations(sql) {
  return sql`
    SELECT key, label, accountable_team, default_owner_founder_id, active
    FROM field_feedback_destinations
    ORDER BY key
  `;
}

async function updateDestination(sql, scope, key, body) {
  await assertTriage(sql, scope);
  if (!rules.DESTINATIONS.includes(key)) throw new CrmError(404, 'Destination not found', 'NOT_FOUND');
  const reason = rules.reasonText(body?.reason);
  const ownerId = rules.uuidOrNull(body?.default_owner_founder_id, 'default owner');
  if (ownerId) {
    const [founder] = await sql`SELECT id FROM founders WHERE id = ${ownerId} AND is_active = true`;
    if (!founder) throw new CrmError(400, 'Owner is not an active founder', 'VALIDATION');
  }
  const [row] = await sql`
    UPDATE field_feedback_destinations
    SET default_owner_founder_id = ${ownerId}, updated_at = now()
    WHERE key = ${key}
    RETURNING *
  `;
  await sql.begin((tx) => audit(tx, {
    action: 'destination_owner',
    actorId: scope.actor.id,
    reason,
    after: { destination_key: key, default_owner_founder_id: ownerId },
  }));
  return row;
}

async function access(sql, scope) {
  return {
    triage: await isTriager(sql, scope),
    write: Boolean(scope.canWrite),
    delivery_commitment: false,
  };
}

module.exports = {
  setRoutingFailureCount,
  setRoutingAdapter,
  createSubmission,
  preview,
  listItems,
  getItem,
  reroute,
  splitItem,
  linkDuplicate,
  setStatus,
  setOwner,
  addComment,
  retryRouting,
  readAttachment,
  listRules,
  addRule,
  updateRule,
  listDestinations,
  updateDestination,
  access,
};

const { CrmError } = require('./errors');
const { computeTravelDistance, proximityMeters, verifyProximity, selectOrigin } = require('./distanceEngine');
const { assertLeadAccess } = require('./accessPolicy');

const OUTCOME_STAGE = {
  INTERESTED: 'CONTACTED',
  DEMO_COMPLETED: 'DEMO',
  FOLLOW_UP_REQUIRED: 'CONTACTED',
  PROPOSAL_REQUESTED: 'PROPOSAL',
  PILOT_REQUESTED: 'PILOT',
  NEGOTIATION: 'NEGOTIATION',
  NOT_INTERESTED: null,
  DM_UNAVAILABLE: 'CONTACTED',
  REVISIT_REQUIRED: 'VISITED_FOLLOWUP',
  CLOSED_WON: 'WON',
  CLOSED_LOST: 'LOST',
};

function kolkataDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  if (!offsetDays) return today;
  const [year, month, day] = today.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function scoreQualification(q = {}, profile = {}) {
  const reasons = [];
  let score = 0;
  if (q.need === 'HIGH') { score += 30; reasons.push('High stated need'); }
  else if (q.need === 'MEDIUM') { score += 15; }
  if (q.authority === 'DECISION_MAKER') { score += 25; reasons.push('Decision maker engaged'); }
  else if (q.authority === 'INFLUENCER') { score += 10; }
  if (q.budget === 'AVAILABLE') { score += 20; reasons.push('Budget available'); }
  if (q.timeline === 'IMMEDIATE' || q.timeline === '<30_DAYS') { score += 15; reasons.push('Near-term timeline'); }
  if (q.engagement === 'HIGH') { score += 10; reasons.push('High engagement'); }
  if ((profile.total_students || 0) >= 1000) { score += 10; reasons.push(`${profile.total_students} students`); }
  if (profile.erp_satisfaction === 'LOW') { score += 10; reasons.push('High dissatisfaction with existing ERP'); }
  const priority = score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW';
  return { score, priority, reasons };
}

async function getHomeBase(sql, executiveId) {
  const [row] = await sql`SELECT * FROM crm_executive_home_base WHERE founder_id = ${executiveId}`;
  return row || null;
}

async function setHomeBase(sql, executiveId, { lat, lng, locality }) {
  if (lat == null || lng == null) throw new CrmError(400, 'lat/lng required', 'VALIDATION');
  const [row] = await sql`
    INSERT INTO crm_executive_home_base (founder_id, lat, lng, locality, last_updated_at)
    VALUES (${executiveId}, ${lat}, ${lng}, ${locality || null}, now())
    ON CONFLICT (founder_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng,
      locality = EXCLUDED.locality, last_updated_at = now()
    RETURNING *`;
  return row;
}

async function startDay(sql, scope, body = {}) {
  const executiveId = scope.founderId || scope.actor?.founderId || scope.actor?.id;
  if (!executiveId) throw new CrmError(403, 'Executive scope required', 'SCOPE_REQUIRED');
  const today = kolkataDate(0);
  const clientKey = body.client_key || `${executiveId}:${today}`;
  const [existing] = await sql`SELECT * FROM sales_field_days WHERE executive_id = ${executiveId} AND date = ${today}`;
  if (existing?.status === 'PLANNED') {
    const [activated] = await sql`
      UPDATE sales_field_days
      SET status = 'ACTIVE', started_at = now(),
        start_lat = COALESCE(${body.lat || null}, start_lat),
        start_lng = COALESCE(${body.lng || null}, start_lng),
        start_locality = COALESCE(${body.locality || null}, start_locality),
        updated_at = now()
      WHERE id = ${existing.id} AND status = 'PLANNED'
      RETURNING *`;
    return activated || existing;
  }
  if (existing?.status === 'COMPLETED') {
    const [reopened] = await sql`
      UPDATE sales_field_days
      SET status = 'ACTIVE', ended_at = null,
        start_lat = COALESCE(${body.lat || null}, start_lat),
        start_lng = COALESCE(${body.lng || null}, start_lng),
        updated_at = now()
      WHERE id = ${existing.id}
      RETURNING *`;
    return reopened || existing;
  }
  if (existing) {
    if (body.lat && !existing.start_lat) {
      await sql`
        UPDATE sales_field_days
        SET start_lat = ${body.lat}, start_lng = ${body.lng},
          start_locality = COALESCE(${body.locality || null}, start_locality),
          updated_at = now()
        WHERE id = ${existing.id}
      `;
    }
    return existing;
  }
  const [row] = await sql`
    INSERT INTO sales_field_days (executive_id, executive_name, date, started_at, start_lat, start_lng, start_locality, status, client_key)
    VALUES (${executiveId}, ${scope.actor?.fullName || scope.actor?.email || null}, ${today}, now(), ${body.lat || null}, ${body.lng || null}, ${body.locality || null}, 'ACTIVE', ${clientKey})
    RETURNING *`;
  return row;
}

async function endDay(sql, scope, body = {}) {
  const executiveId = scope.founderId || scope.actor?.founderId || scope.actor?.id;
  if (!executiveId) throw new CrmError(403, 'Executive scope required', 'SCOPE_REQUIRED');
  const today = kolkataDate(0);
  const [existing] = await sql`SELECT * FROM sales_field_days WHERE executive_id = ${executiveId} AND date = ${today}`;
  if (!existing) throw new CrmError(404, 'No active day found to end', 'NOT_FOUND');
  if (existing.status === 'COMPLETED') return existing;
  const [completed] = await sql`
    UPDATE sales_field_days
    SET status = 'COMPLETED', ended_at = now(),
      updated_at = now()
    WHERE id = ${existing.id}
    RETURNING *`;
  return completed || existing;
}

async function reopenDay(sql, scope) {
  const executiveId = scope.founderId || scope.actor?.founderId || scope.actor?.id;
  if (!executiveId) throw new CrmError(403, 'Executive scope required', 'SCOPE_REQUIRED');
  const today = kolkataDate(0);
  const [existing] = await sql`SELECT * FROM sales_field_days WHERE executive_id = ${executiveId} AND date = ${today}`;
  if (!existing) throw new CrmError(404, 'No day found to reopen', 'NOT_FOUND');
  const [reopened] = await sql`
    UPDATE sales_field_days
    SET status = 'ACTIVE', ended_at = null, updated_at = now()
    WHERE id = ${existing.id}
    RETURNING *`;
  return reopened || existing;
}

async function resolveOrigin(sql, executiveId, fieldDayId) {
  const completed = await sql`
    SELECT v.id, v.checkout_lat, v.checkin_lat, p.lat AS school_lat, v.checkout_lng, v.checkin_lng, p.lng AS school_lng
    FROM sales_visits v LEFT JOIN school_sales_profiles p ON p.account_id = v.school_account_id
    WHERE v.executive_id = ${executiveId} AND v.field_day_id = ${fieldDayId} AND v.status = 'COMPLETED'
    ORDER BY v.sequence_number DESC LIMIT 1`;
  const home = await getHomeBase(sql, executiveId);
  const [day] = await sql`SELECT start_lat, start_lng FROM sales_field_days WHERE id = ${fieldDayId}`;
  const last = completed[0];
  return selectOrigin({
    completedCount: completed.length,
    home,
    dayStart: day ? { lat: day.start_lat, lng: day.start_lng } : null,
    previous: last ? {
      id: last.id,
      lat: last.checkout_lat ?? last.checkin_lat ?? last.school_lat,
      lng: last.checkout_lng ?? last.checkin_lng ?? last.school_lng,
    } : null,
  });
}

async function checkIn(sql, scope, body = {}) {
  const executiveId = scope.founderId;
  if (!executiveId) throw new CrmError(403, 'Executive scope required', 'SCOPE_REQUIRED');
  if (!body.school_account_id && !body.lead_id) throw new CrmError(400, 'school_account_id or lead_id required', 'VALIDATION');
  if (body.checkin_lat == null || body.checkin_lng == null) throw new CrmError(400, 'GPS required for check-in', 'VALIDATION');
  // Ownership: executive can only check in to own leads (platform bypasses)
  let lead = null;
  if (body.lead_id && scope.kind !== 'platform') {
    const [l] = await sql`SELECT * FROM enquiries WHERE id = ${body.lead_id}`;
    assertLeadAccess(scope, l);
    lead = l;
  }
  const day = await startDay(sql, scope, { lat: body.checkin_lat, lng: body.checkin_lng });
  const origin = await resolveOrigin(sql, executiveId, day.id);
  const [profile] = body.school_account_id
    ? await sql`SELECT * FROM school_sales_profiles WHERE account_id = ${body.school_account_id}`
    : [];
  const dest = { lat: profile?.lat ?? body.school_lat ?? null, lng: profile?.lng ?? body.school_lng ?? null };
  const dist = origin.lat != null && dest.lat != null
    ? await computeTravelDistance(origin, dest)
    : { straight_distance_km: null, route_distance_km: null, distance_source: 'haversine', travel_km: null };
  const proxM = dest.lat != null ? proximityMeters(body.checkin_lat, body.checkin_lng, dest.lat, dest.lng) : null;
  const verification = verifyProximity(proxM);
  if (verification === 'OUTSIDE' && !body.remote_reason) {
    throw new CrmError(400, 'Remote check-in reason required outside 500m', 'REMOTE_REASON_REQUIRED');
  }
  const clientKey = body.client_key;
  if (!clientKey) throw new CrmError(400, 'client_key required (idempotent offline sync)', 'VALIDATION');
  const [existing] = await sql`SELECT * FROM sales_visits WHERE client_key = ${clientKey}`;
  if (existing) return existing;
  const [planned] = body.visit_id
    ? await sql`SELECT * FROM sales_visits WHERE id = ${body.visit_id} AND executive_id = ${executiveId} AND field_day_id = ${day.id}`
    : await sql`SELECT * FROM sales_visits WHERE field_day_id = ${day.id} AND school_account_id = ${body.school_account_id || null} AND status = 'PLANNED' LIMIT 1`;
  if (planned?.status === 'PLANNED') {
    const [visit] = await sql`
      UPDATE sales_visits SET status = 'CHECKED_IN', checkin_at = now(),
        checkin_lat = ${body.checkin_lat}, checkin_lng = ${body.checkin_lng},
        gps_accuracy = ${body.gps_accuracy || null}, verification_status = ${verification},
        proximity_distance_m = ${proxM}, remote_reason = ${body.remote_reason || null},
        previous_visit_id = ${origin.previous_visit_id || null}, origin_type = ${origin.type},
        origin_lat = ${origin.lat}, origin_lng = ${origin.lng},
        route_distance_km = ${dist.route_distance_km}, straight_distance_km = ${dist.straight_distance_km},
        distance_source = ${dist.distance_source}, distance_calculated_at = now(), updated_at = now()
      WHERE id = ${planned.id} AND status = 'PLANNED'
      RETURNING *`;
    if (visit) {
      await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id, metadata)
        VALUES (${visit.id}, 'CHECKED_IN', 'Checked in', ${executiveId}, ${JSON.stringify({ verification, proxM })}::jsonb)`;
      if (dist.travel_km != null) {
        await sql`UPDATE sales_field_days SET total_distance_km = total_distance_km + ${dist.travel_km}, updated_at = now() WHERE id = ${day.id}`;
      }
      return visit;
    }
  }
  if (planned && planned.status !== 'PLANNED') return planned;
  const [count] = await sql`SELECT COUNT(*)::int AS c FROM sales_visits WHERE field_day_id = ${day.id}`;
  const [visit] = await sql`
    INSERT INTO sales_visits (executive_id, field_day_id, school_account_id, lead_id, planned, unplanned,
      sequence_number, checkin_lat, checkin_lng, gps_accuracy, verification_status, proximity_distance_m,
      remote_reason, previous_visit_id, origin_type, origin_lat, origin_lng,
      route_distance_km, straight_distance_km, distance_source, distance_calculated_at, client_key)
    VALUES (${executiveId}, ${day.id}, ${body.school_account_id || null}, ${body.lead_id || null},
      ${body.planned ?? true}, ${body.unplanned ?? false}, ${count.c + 1},
      ${body.checkin_lat}, ${body.checkin_lng}, ${body.gps_accuracy || null},
      ${verification}, ${proxM}, ${body.remote_reason || null},
      ${origin.previous_visit_id || null}, ${origin.type}, ${origin.lat}, ${origin.lng},
      ${dist.route_distance_km}, ${dist.straight_distance_km}, ${dist.distance_source}, now(), ${clientKey})
    RETURNING *`;
  await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id, metadata)
    VALUES (${visit.id}, 'CHECKED_IN', 'Checked in', ${executiveId}, ${JSON.stringify({ verification, proxM })}::jsonb)`;
  if (dist.travel_km != null) {
    await sql`UPDATE sales_field_days SET total_distance_km = total_distance_km + ${dist.travel_km},
      visited_count = visited_count + 1, updated_at = now() WHERE id = ${day.id}`;
  }
  return visit;
}

async function updateVisit(sql, scope, visitId, body = {}) {
  const [visit] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  if (!visit) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && visit.executive_id !== scope.founderId) {
    throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  }
  if (visit.status === 'COMPLETED') throw new CrmError(400, 'Visit already completed', 'IMMUTABLE');
  // Never allow GPS edit: strip lat/lng updates
  const { checkin_lat, checkin_lng, checkout_lat, checkout_lng, ...safe } = body;
  const patch = {};
  if (safe.notes != null) patch.notes = safe.notes;
  if (safe.visit_outcome != null) patch.visit_outcome = safe.visit_outcome;
  if (safe.lost_reason != null) patch.lost_reason = safe.lost_reason;
  if (safe.qualification != null) patch.qualification = JSON.stringify(safe.qualification);
  if (Object.keys(patch).length) {
    if (patch.notes != null) await sql`UPDATE sales_visits SET notes = ${patch.notes}, updated_at = now() WHERE id = ${visitId}`;
    if (patch.visit_outcome != null) await sql`UPDATE sales_visits SET visit_outcome = ${patch.visit_outcome}, updated_at = now() WHERE id = ${visitId}`;
    if (patch.lost_reason != null) await sql`UPDATE sales_visits SET lost_reason = ${patch.lost_reason}, updated_at = now() WHERE id = ${visitId}`;
    if (patch.qualification != null) await sql`UPDATE sales_visits SET qualification = ${patch.qualification}::jsonb, updated_at = now() WHERE id = ${visitId}`;
  }
  if (safe.event) {
    await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id, metadata)
      VALUES (${visitId}, ${safe.event}, ${safe.event_label || safe.event}, ${visit.executive_id}, ${JSON.stringify(safe.event_meta || {})}::jsonb)`;
  }
  const [updated] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  return updated;
}

async function completeVisit(sql, scope, visitId, body = {}) {
  const [visit] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  if (!visit) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && visit.executive_id !== scope.founderId) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (visit.status === 'PLANNED') throw new CrmError(400, 'Check in before completing this visit', 'NOT_CHECKED_IN');
  if (visit.status === 'COMPLETED') return visit;
  if (!body.visit_outcome && !visit.visit_outcome) throw new CrmError(400, 'visit_outcome required', 'VALIDATION');
  const outcome = body.visit_outcome || visit.visit_outcome;
  if (outcome === 'CLOSED_LOST' && !body.lost_reason && !visit.lost_reason) {
    throw new CrmError(400, 'lost_reason required', 'VALIDATION');
  }
  const needsAction = ['INTERESTED', 'DEMO_COMPLETED', 'FOLLOW_UP_REQUIRED', 'PROPOSAL_REQUESTED', 'PILOT_REQUESTED', 'NEGOTIATION', 'REVISIT_REQUIRED'];
  if (needsAction.includes(outcome) && (!body.next_action?.action || !body.next_action?.due_at)) {
    throw new CrmError(400, 'next_action (action + due_at) required for this outcome', 'NEXT_ACTION_REQUIRED');
  }
  const duration = Math.max(1, Math.round((Date.now() - new Date(visit.checkin_at).getTime()) / 60000));
  const [profile] = visit.school_account_id ? await sql`SELECT * FROM school_sales_profiles WHERE account_id = ${visit.school_account_id}` : [];
  const qual = body.qualification || visit.qualification || {};
  const { priority, reasons } = scoreQualification(qual, profile || {});
  await sql`UPDATE sales_visits SET status = 'COMPLETED', checkout_at = now(),
    checkout_lat = ${body.checkout_lat || null}, checkout_lng = ${body.checkout_lng || null},
    visit_outcome = ${outcome}, lost_reason = ${body.lost_reason || visit.lost_reason || null},
    visit_duration_minutes = ${duration}, qualification = ${JSON.stringify(qual)}::jsonb,
    priority = ${priority}, priority_reasons = ${JSON.stringify(reasons)}::jsonb,
    notes = COALESCE(${body.notes || null}, notes), updated_at = now() WHERE id = ${visitId}`;
  await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id, metadata)
    VALUES (${visitId}, 'COMPLETED', ${'Visit completed: ' + outcome}, ${visit.executive_id}, ${JSON.stringify({ priority, reasons })}::jsonb)`;
  if (needsAction.includes(outcome)) {
    await sql`INSERT INTO sales_followups (visit_id, account_id, lead_id, executive_id, action, due_at, contact_name, notes)
      VALUES (${visitId}, ${visit.school_account_id}, ${visit.lead_id}, ${visit.executive_id},
        ${body.next_action.action}, ${body.next_action.due_at}, ${body.next_action.contact_name || null}, ${body.next_action.notes || null})`;
  }
  // CRM pipeline sync (lead stage advance) — append-only stage history via salesCrm
  if (visit.lead_id) {
    try {
      const salesCrm = require('./salesCrm');
      const stage = OUTCOME_STAGE[outcome];
      if (stage === 'WON') await salesCrm.closeLead(sql, scope, visit.lead_id, { outcome: 'WON', notes: 'Field visit won' });
      else if (stage === 'LOST') await salesCrm.closeLead(sql, scope, visit.lead_id, { outcome: 'LOST', reason_code: 'OTHER', notes: body.lost_reason || 'Field visit lost' });
      else if (stage && stage !== 'VISITED_FOLLOWUP') await salesCrm.moveStage(sql, scope, visit.lead_id, { to_code: stage });
      await salesCrm.logActivity(sql, scope, visit.lead_id, { activity_type: 'VISIT', notes: `Field visit ${outcome} (${duration} min)`, contact_outcome: 'CONNECTED' });
    } catch (e) { /* pipeline sync must not destroy visit record */ }
  }
  if (visit.school_account_id) {
    await sql`INSERT INTO school_sales_profiles (account_id, visit_count, last_visit_at)
      VALUES (${visit.school_account_id}, 1, now())
      ON CONFLICT (account_id) DO UPDATE SET visit_count = school_sales_profiles.visit_count + 1, last_visit_at = now(), updated_at = now()`;
  }
  const [done] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  return done;
}

async function todaySummary(sql, scope) {
  const executiveId = scope.kind === 'platform' ? scope.actor?.founderId || null : scope.founderId;
  const today = kolkataDate(0);
  const filter = executiveId ? sql`WHERE v.executive_id = ${executiveId} AND d.date = ${today}` : sql`WHERE d.date = ${today}`;
  const [day] = executiveId
    ? await sql`SELECT * FROM sales_field_days WHERE executive_id = ${executiveId} AND date = ${today}`
    : [];
  const visits = await sql`
    SELECT v.*, a.name AS school_name, a.phone AS school_phone,
      p.lat AS school_lat, p.lng AS school_lng, sp.locality_raw AS school_locality,
      sp.board AS school_board, p.total_students,
      sp.district_raw, sp.city_raw
    FROM sales_visits v
    LEFT JOIN sales_field_days d ON d.id = v.field_day_id
    LEFT JOIN crm_accounts a ON a.id = v.school_account_id
    LEFT JOIN school_sales_profiles p ON p.account_id = v.school_account_id
    LEFT JOIN crm_school_profiles sp ON sp.account_id = v.school_account_id
    ${filter}
    ORDER BY v.sequence_number`;
  const followups = executiveId ? await sql`
    SELECT COUNT(*)::int AS c FROM sales_followups
    WHERE executive_id = ${executiveId} AND status = 'OPEN' AND due_at < now()` : [{ c: 0 }];
  return {
    day,
    visits,
    totals: {
      planned: visits.filter((v) => v.planned && v.status !== 'SKIPPED').length,
      visited: visits.filter((v) => v.status === 'COMPLETED').length,
      qualified: visits.filter((v) => v.priority === 'HIGH').length,
      demos: day?.demo_count || 0,
      distance_km: Number(day?.total_distance_km || 0),
      followups_breached: followups[0]?.c || 0,
    },
  };
}

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function findDuplicateSchools(sql, { name, phone, lat, lng, udise }) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2 && !phone && !udise) return [];
  const needle = `%${trimmed.slice(0, 24)}%`;
  const phoneDigits = digits(phone);
  const rows = await sql`
    SELECT a.id, a.name, a.phone,
      p.lat, p.lng, sp.udise_code,
      sp.district_raw, sp.city_raw
    FROM crm_accounts a
    LEFT JOIN school_sales_profiles p ON p.account_id = a.id
    LEFT JOIN crm_school_profiles sp ON sp.account_id = a.id
    WHERE a.vertical = 'SCHOOL'
      AND a.archived_at IS NULL
      AND (
        (${trimmed}::text <> '' AND a.name ILIKE ${needle})
        OR (${phoneDigits || null}::text IS NOT NULL AND regexp_replace(COALESCE(a.phone, ''), '\\D', '', 'g') = ${phoneDigits || ''})
        OR (${udise || null}::text IS NOT NULL AND sp.udise_code = ${udise || null})
      )
    ORDER BY a.updated_at DESC
    LIMIT 12`;
  return rows.filter((row) => {
    const nameHit = trimmed && row.name && row.name.toLowerCase().includes(trimmed.toLowerCase().slice(0, 8));
    const phoneHit = phoneDigits && digits(row.phone) === phoneDigits;
    const udiseHit = udise && row.udise_code === udise;
    const near = lat != null && row.lat != null && (proximityMeters(lat, lng, row.lat, row.lng) || 99999) < 200;
    return nameHit || phoneHit || udiseHit || near;
  }).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    district: row.district_raw,
    city: row.city_raw,
    reasons: [
      trimmed && row.name && row.name.toLowerCase().includes(trimmed.toLowerCase().slice(0, 8)) ? 'name' : null,
      phoneDigits && digits(row.phone) === phoneDigits ? 'phone' : null,
      udise && row.udise_code === udise ? 'udise' : null,
      lat != null && row.lat != null && (proximityMeters(lat, lng, row.lat, row.lng) || 99999) < 200 ? 'nearby_gps' : null,
    ].filter(Boolean),
  }));
}

async function createUnplannedSchool(sql, scope, body = {}) {
  const name = String(body.name || '').trim();
  if (name.length < 2) throw new CrmError(400, 'School name is required', 'VALIDATION');
  const phone = body.phone ? digits(body.phone) : '';
  if (phone && phone.length < 10) throw new CrmError(400, 'Enter a valid phone number', 'VALIDATION');
  const matches = await findDuplicateSchools(sql, body);
  if (matches.length && !String(body.create_anyway_reason || '').trim()) {
    throw new CrmError(409, 'Possible existing school found', 'POSSIBLE_DUPLICATE', { matches });
  }
  const [account] = await sql`
    INSERT INTO crm_accounts (name, account_type, vertical, lifecycle_stage, owner_founder_id, phone, created_by, metadata)
    VALUES (${name}, 'PROSPECT', 'SCHOOL', 'LEAD', ${null}, ${phone || null}, ${scope.actor.id},
      ${JSON.stringify({ unplanned: true, field_executive_id: scope.founderId, create_anyway_reason: body.create_anyway_reason || null })}::jsonb)
    RETURNING id, name, phone`;
  await sql`
    INSERT INTO school_sales_profiles (account_id, lat, lng, total_students, student_range)
    VALUES (${account.id}, ${body.lat || null}, ${body.lng || null}, ${body.total_students || null}, ${body.student_range || null})
    ON CONFLICT (account_id) DO UPDATE SET lat = COALESCE(EXCLUDED.lat, school_sales_profiles.lat),
      lng = COALESCE(EXCLUDED.lng, school_sales_profiles.lng), updated_at = now()`;
  if (body.area || body.district) {
    await sql`
      INSERT INTO crm_school_profiles (account_id, school_name_normalized, school_name_loose, locality_raw, district_raw, normalization_version)
      VALUES (${account.id}, ${name.toLowerCase()}, ${name.toLowerCase()}, ${body.area || null}, ${body.district || null}, 1)
      ON CONFLICT (account_id) DO NOTHING`;
  }
  return { account, matches_ignored: matches.length ? matches.map((m) => m.id) : [] };
}

async function upsertSalesProfile(sql, scope, accountId, body = {}) {
  const [account] = await sql`SELECT id, owner_founder_id, metadata FROM crm_accounts WHERE id = ${accountId}`;
  if (!account) throw new CrmError(404, 'School not found', 'NOT_FOUND');
  const owned = account.owner_founder_id === scope.founderId
    || account.metadata?.field_executive_id === scope.founderId;
  if (scope.kind !== 'platform' && !owned) {
    const [visit] = await sql`SELECT 1 AS ok FROM sales_visits WHERE school_account_id = ${accountId} AND executive_id = ${scope.founderId} LIMIT 1`;
    if (!visit) throw new CrmError(404, 'School not found', 'NOT_FOUND');
  }
  const [row] = await sql`
    INSERT INTO school_sales_profiles (
      account_id, total_students, student_range, teaching_staff, non_teaching_staff, bus_count,
      branch_count, fee_range, growth_trend, uses_erp, erp_vendor, erp_yearly_cost, erp_modules,
      erp_satisfaction, erp_renewal_month, erp_problems, erp_switch_reason, product_interests, lat, lng
    ) VALUES (
      ${accountId}, ${body.total_students ?? null}, ${body.student_range ?? null}, ${body.teaching_staff ?? null},
      ${body.non_teaching_staff ?? null}, ${body.bus_count ?? null}, ${body.branch_count ?? null},
      ${body.fee_range ?? null}, ${body.growth_trend ?? null}, ${body.uses_erp ?? null},
      ${body.uses_erp ? body.erp_vendor || null : null}, ${body.uses_erp ? body.erp_yearly_cost ?? null : null},
      ${body.uses_erp ? (body.erp_modules || []) : []}, ${body.uses_erp ? body.erp_satisfaction || null : null},
      ${body.uses_erp ? body.erp_renewal_month ?? null : null}, ${body.uses_erp ? body.erp_problems || null : null},
      ${body.uses_erp ? body.erp_switch_reason || null : null}, ${body.product_interests || []},
      ${body.lat ?? null}, ${body.lng ?? null}
    )
    ON CONFLICT (account_id) DO UPDATE SET
      total_students = COALESCE(EXCLUDED.total_students, school_sales_profiles.total_students),
      student_range = COALESCE(EXCLUDED.student_range, school_sales_profiles.student_range),
      uses_erp = COALESCE(EXCLUDED.uses_erp, school_sales_profiles.uses_erp),
      erp_vendor = CASE WHEN EXCLUDED.uses_erp = false THEN NULL ELSE COALESCE(EXCLUDED.erp_vendor, school_sales_profiles.erp_vendor) END,
      product_interests = CASE WHEN cardinality(EXCLUDED.product_interests) > 0 THEN EXCLUDED.product_interests ELSE school_sales_profiles.product_interests END,
      lat = COALESCE(school_sales_profiles.lat, EXCLUDED.lat),
      lng = COALESCE(school_sales_profiles.lng, EXCLUDED.lng),
      updated_at = now()
    RETURNING *`;
  return row;
}

async function addDecisionMaker(sql, scope, accountId, body = {}) {
  const name = String(body.full_name || '').trim();
  if (name.length < 2) throw new CrmError(400, 'Contact name is required', 'VALIDATION');
  const phone = body.phone ? digits(body.phone) : '';
  if (phone && phone.length < 10) throw new CrmError(400, 'Enter a valid mobile number', 'VALIDATION');
  const [existing] = phone
    ? await sql`SELECT id FROM crm_contacts WHERE account_id = ${accountId} AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = ${phone} AND archived_at IS NULL LIMIT 1`
    : [];
  if (existing) throw new CrmError(409, 'This mobile is already on the school', 'DUPLICATE_CONTACT');
  const channel = ['PHONE', 'EMAIL', 'WHATSAPP', 'IN_APP'].includes(body.preferred_contact_method)
    ? body.preferred_contact_method : null;
  const [row] = await sql`
    INSERT INTO crm_contacts (account_id, full_name, role_title, phone, email, preferred_channel, influence_level, decision_authority, preferred_contact_method, preferred_followup_time, created_by)
    VALUES (${accountId}, ${name}, ${body.role_title || null}, ${phone || null}, ${body.email || null},
      ${channel}, ${body.influence_level || null}, ${body.decision_authority || null},
      ${body.preferred_contact_method || null}, ${body.preferred_followup_time || null}, ${scope.actor.id})
    RETURNING id, full_name, role_title, phone, influence_level`;
  return row;
}

async function recordDemo(sql, scope, visitId, body = {}) {
  const [visit] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  if (!visit) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && visit.executive_id !== scope.founderId) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (body.given === false) return { given: false };
  const [demo] = await sql`
    INSERT INTO sales_demo_sessions (visit_id, lead_id, demo_type, duration_minutes, attendees_count, features_shown, questions, objections, requested_features)
    VALUES (${visitId}, ${visit.lead_id}, ${body.demo_type || 'QUICK_DEMO'}, ${body.duration_minutes || null},
      ${body.attendees_count || null}, ${body.features_shown || []}, ${body.questions || null}, ${body.objections || null}, ${body.requested_features || null})
    RETURNING *`;
  await sql`UPDATE sales_field_days SET demo_count = demo_count + 1, updated_at = now() WHERE id = ${visit.field_day_id}`;
  await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id) VALUES (${visitId}, 'DEMO_COMPLETED', 'Demo completed', ${visit.executive_id})`;
  return demo;
}

async function skipVisit(sql, scope, visitId, body = {}) {
  const reason = String(body.reason || '').trim();
  if (reason.length < 3) throw new CrmError(400, 'A skip reason is required', 'VALIDATION');
  const [visit] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  if (!visit) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && visit.executive_id !== scope.founderId) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (visit.status === 'COMPLETED') throw new CrmError(400, 'Completed visits cannot be skipped', 'IMMUTABLE');
  await sql`UPDATE sales_visits SET status = 'SKIPPED', notes = ${reason}, updated_at = now() WHERE id = ${visitId}`;
  await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id, metadata)
    VALUES (${visitId}, 'SKIPPED', 'Skipped', ${visit.executive_id}, ${JSON.stringify({ reason })}::jsonb)`;
  const [row] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  return row;
}

async function listFollowups(sql, scope) {
  const executiveId = scope.kind === 'platform' ? null : scope.founderId;
  return sql`
    SELECT f.*, a.name AS school_name
    FROM sales_followups f
    LEFT JOIN crm_accounts a ON a.id = f.account_id
    WHERE (${executiveId}::uuid IS NULL OR f.executive_id = ${executiveId})
      AND f.status = 'OPEN'
    ORDER BY f.due_at
    LIMIT 100`;
}

async function teamBoard(sql, scope, teamIds = null) {
  if (scope.actor?.role === 'SALES_EXECUTIVE') {
    throw new CrmError(403, 'Team board requires a manager or founder', 'PLATFORM_REQUIRED');
  }
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql`
    SELECT d.executive_id, d.executive_name,
      d.planned_count, d.visited_count, d.qualified_count, d.demo_count,
      d.total_distance_km, d.status, d.started_at
    FROM sales_field_days d
    WHERE d.date = ${today}
      AND (${teamIds}::uuid[] IS NULL OR d.executive_id = ANY(${teamIds}::uuid[]))
    ORDER BY d.visited_count DESC, d.executive_name`;
  return rows.map((row) => ({
    executive_id: row.executive_id,
    executive: row.executive_name,
    planned: row.planned_count,
    visited: row.visited_count,
    qualified: row.qualified_count,
    demos: row.demo_count,
    distance_km: Number(row.total_distance_km || 0),
    status: row.status,
    started_at: row.started_at,
  }));
}

function publicHomeBase(row, { revealCoordinates }) {
  if (!row) return null;
  if (revealCoordinates) return row;
  return { founder_id: row.founder_id, locality: row.locality, last_updated_at: row.last_updated_at, configured: true };
}

async function ensurePlanDay(sql, scope, date) {
  const executiveId = scope.founderId;
  const today = kolkataDate(0);
  const latest = kolkataDate(14);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > latest) {
    throw new CrmError(400, 'Plan a date from today through the next 14 days', 'VALIDATION');
  }
  const [existing] = await sql`SELECT * FROM sales_field_days WHERE executive_id = ${executiveId} AND date = ${date}`;
  if (existing) return existing;
  const [row] = await sql`
    INSERT INTO sales_field_days (executive_id, executive_name, date, status, started_at, client_key)
    VALUES (${executiveId}, ${scope.actor?.fullName || scope.actor?.email || null}, ${date}, 'PLANNED', NULL, ${`plan:${executiveId}:${date}`})
    RETURNING *`;
  return row;
}

async function searchSchoolsForPlan(sql, query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const term = `%${q}%`;
  return sql`
    SELECT a.id, a.name, a.phone,
      p.locality_raw, p.city_raw, p.district_raw, p.state_raw,
      sp.total_students, sp.student_range,
      c.full_name AS contact_name, c.phone AS contact_phone, c.role_title,
      (SELECT e.pipeline_stage_code FROM enquiries e WHERE e.account_id = a.id ORDER BY e.updated_at DESC LIMIT 1) AS sales_stage
    FROM crm_accounts a
    LEFT JOIN crm_school_profiles p ON p.account_id = a.id
    LEFT JOIN school_sales_profiles sp ON sp.account_id = a.id
    LEFT JOIN LATERAL (
      SELECT full_name, phone, role_title FROM crm_contacts
      WHERE account_id = a.id AND archived_at IS NULL
      ORDER BY is_primary DESC NULLS LAST, created_at
      LIMIT 1
    ) c ON true
    WHERE a.vertical = 'SCHOOL' AND a.archived_at IS NULL
      AND (
        a.name ILIKE ${term}
        OR COALESCE(p.district_raw, '') ILIKE ${term}
        OR COALESCE(p.city_raw, '') ILIKE ${term}
        OR COALESCE(p.locality_raw, '') ILIKE ${term}
        OR COALESCE(a.phone, '') ILIKE ${term}
      )
    ORDER BY a.name
    LIMIT 20`;
}

async function getPlan(sql, scope, date) {
  const planDate = date || kolkataDate(1);
  const executiveId = scope.kind === 'platform' && scope.actor?.role !== 'SALES_EXECUTIVE'
    ? scope.founderId
    : scope.founderId;
  const [day] = await sql`SELECT * FROM sales_field_days WHERE executive_id = ${executiveId} AND date = ${planDate}`;
  if (!day) return { date: planDate, day: null, stops: [] };
  const stops = await sql`
    SELECT v.*, a.name AS school_name, a.phone AS school_phone,
      COALESCE(v.area_label, p.locality_raw, p.city_raw) AS area,
      p.district_raw AS district
    FROM sales_visits v
    LEFT JOIN crm_accounts a ON a.id = v.school_account_id
    LEFT JOIN crm_school_profiles p ON p.account_id = v.school_account_id
    WHERE v.field_day_id = ${day.id} AND v.status <> 'SKIPPED'
    ORDER BY v.sequence_number`;
  return { date: planDate, day, stops };
}

async function addPlanStop(sql, scope, body = {}) {
  const date = body.date || kolkataDate(1);
  const day = await ensurePlanDay(sql, scope, date);
  if (day.status === 'COMPLETED') throw new CrmError(400, 'That day is already closed', 'IMMUTABLE');
  if (!body.school_account_id) throw new CrmError(400, 'Choose a school from search', 'VALIDATION');
  const [school] = await sql`
    SELECT a.id, a.name, a.phone, p.locality_raw, p.city_raw, p.district_raw
    FROM crm_accounts a
    LEFT JOIN crm_school_profiles p ON p.account_id = a.id
    WHERE a.id = ${body.school_account_id} AND a.vertical = 'SCHOOL' AND a.archived_at IS NULL`;
  if (!school) throw new CrmError(404, 'School not found', 'NOT_FOUND');
  const [dup] = await sql`
    SELECT id FROM sales_visits
    WHERE field_day_id = ${day.id} AND school_account_id = ${school.id} AND status <> 'SKIPPED'
    LIMIT 1`;
  if (dup) throw new CrmError(409, 'This school is already on that day', 'ALREADY_PLANNED');
  const priority = ['HIGH', 'MEDIUM', 'LOW'].includes(body.priority) ? body.priority : 'MEDIUM';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(body.appointment_time || '') ? body.appointment_time : null;
  const appointmentAt = time ? new Date(`${date}T${time}:00+05:30`).toISOString() : null;
  const [count] = await sql`SELECT COUNT(*)::int AS c FROM sales_visits WHERE field_day_id = ${day.id}`;
  const [stop] = await sql`
    INSERT INTO sales_visits (
      executive_id, field_day_id, school_account_id, planned, unplanned, sequence_number,
      status, checkin_at, priority, research_note, area_label, contact_name, contact_phone,
      appointment_at, client_key
    ) VALUES (
      ${scope.founderId}, ${day.id}, ${school.id}, true, false, ${count.c + 1},
      'PLANNED', NULL, ${priority}, ${String(body.research_note || '').slice(0, 500) || null},
      ${[school.locality_raw, school.city_raw, school.district_raw].filter(Boolean).join(', ') || null},
      ${body.contact_name || null}, ${body.contact_phone || school.phone || null},
      ${appointmentAt}, ${`plan:${day.id}:${school.id}:${count.c + 1}`}
    ) RETURNING *`;
  await sql`UPDATE sales_field_days SET planned_count = planned_count + 1, updated_at = now() WHERE id = ${day.id}`;
  await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id, metadata)
    VALUES (${stop.id}, 'PLANNED', 'Added to day plan', ${scope.founderId}, ${JSON.stringify({ date, priority })}::jsonb)`;
  return { ...stop, school_name: school.name };
}

async function removePlanStop(sql, scope, visitId) {
  const [visit] = await sql`SELECT * FROM sales_visits WHERE id = ${visitId}`;
  if (!visit || (scope.kind !== 'platform' && visit.executive_id !== scope.founderId)) {
    throw new CrmError(404, 'Planned stop not found', 'NOT_FOUND');
  }
  if (visit.status !== 'PLANNED') throw new CrmError(400, 'Only an unvisited stop can be removed', 'IMMUTABLE');
  await sql`UPDATE sales_visits SET status = 'SKIPPED', notes = 'Removed from plan', updated_at = now() WHERE id = ${visitId} AND status = 'PLANNED'`;
  await sql`INSERT INTO sales_visit_events (visit_id, event_type, label, actor_id) VALUES (${visitId}, 'SKIPPED', 'Removed from plan', ${scope.founderId})`;
  await sql`UPDATE sales_field_days SET planned_count = GREATEST(planned_count - 1, 0), updated_at = now() WHERE id = ${visit.field_day_id}`;
  return { removed: true };
}

async function getVisit(sql, scope, visitId) {
  const [visit] = await sql`
    SELECT v.*, a.name AS school_name, a.phone AS school_phone,
      p.lat AS school_lat, p.lng AS school_lng, sp.locality_raw AS school_locality,
      sp.board AS school_board, p.total_students,
      sp.district_raw, sp.city_raw
    FROM sales_visits v
    LEFT JOIN crm_accounts a ON a.id = v.school_account_id
    LEFT JOIN school_sales_profiles p ON p.account_id = v.school_account_id
    LEFT JOIN crm_school_profiles sp ON sp.account_id = v.school_account_id
    WHERE v.id = ${visitId}
  `;
  if (!visit) throw new CrmError(404, 'Visit not found', 'NOT_FOUND');
  if (scope.kind !== 'platform' && visit.executive_id !== scope.founderId) {
    throw new CrmError(403, 'Access denied', 'FORBIDDEN');
  }
  return visit;
}

module.exports = {
  getHomeBase, setHomeBase, startDay, endDay, reopenDay, checkIn, updateVisit, completeVisit,
  getVisit, todaySummary, scoreQualification, OUTCOME_STAGE, findDuplicateSchools,
  createUnplannedSchool, upsertSalesProfile, addDecisionMaker, recordDemo,
  skipVisit, listFollowups, teamBoard, publicHomeBase,
  searchSchoolsForPlan, getPlan, addPlanStop, removePlanStop, kolkataDate,
};

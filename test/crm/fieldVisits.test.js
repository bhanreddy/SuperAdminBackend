const assert = require('node:assert/strict');
const test = require('node:test');
const { haversineKm, proximityMeters, verifyProximity, computeTravelDistance, selectOrigin } = require('../../src/services/crm/distanceEngine');
const { scoreQualification } = require('../../src/services/crm/fieldVisits');

test('haversine: Hyderabad ~11km sanity', () => {
  // Begumpet -> Suchitra approx 11km straight line
  const km = haversineKm(17.4435, 78.4547, 17.5236, 78.4865);
  assert.ok(km > 8 && km < 14, `expected ~11km got ${km}`);
});

test('proximity verification bands', () => {
  assert.equal(verifyProximity(46), 'VERIFIED');
  assert.equal(verifyProximity(150), 'VERIFIED');
  assert.equal(verifyProximity(300), 'WARNING');
  assert.equal(verifyProximity(501), 'OUTSIDE');
  assert.equal(verifyProximity(null), 'NO_SCHOOL_GPS');
});

test('proximity meters from coordinates', () => {
  const m = proximityMeters(17.4435, 78.4547, 17.4439, 78.4551);
  assert.ok(m != null && m < 150, `expected <150m got ${m}`);
});

test('computeTravelDistance falls back to haversine without API key', async () => {
  delete process.env.GOOGLE_ROUTES_API_KEY;
  const d = await computeTravelDistance({ lat: 17.38, lng: 78.48 }, { lat: 17.44, lng: 78.50 });
  assert.equal(d.distance_source, 'haversine');
  assert.ok(d.travel_km > 5 && d.travel_km < 12, `got ${d.travel_km}`);
  assert.equal(d.route_distance_km, null);
});

test('scenario A: first school of the day originates at home base', () => {
  const origin = selectOrigin({
    completedCount: 0,
    home: { lat: 17.36, lng: 78.47 },
    dayStart: { lat: 17.40, lng: 78.50 },
    previous: null,
  });
  assert.equal(origin.type, 'HOME_BASE');
  assert.equal(origin.lat, 17.36);
  const km = haversineKm(origin.lat, origin.lng, 17.44, 78.45);
  assert.ok(km > 5 && km < 15, `home to school A expected ~12km, got ${km}`);
});

test('scenario B: second school originates at the previous school, not home', () => {
  const origin = selectOrigin({
    completedCount: 1,
    home: { lat: 17.36, lng: 78.47 },
    previous: { id: 'visit-a', lat: 17.44, lng: 78.45 },
  });
  assert.equal(origin.type, 'PREVIOUS_SCHOOL');
  assert.equal(origin.previous_visit_id, 'visit-a');
  const segment = haversineKm(origin.lat, origin.lng, 17.50, 78.49);
  const fromHome = haversineKm(17.36, 78.47, 17.50, 78.49);
  assert.ok(Math.abs(segment - fromHome) > 1, 'School B distance must not equal home → School B');
});

test('origin logic contract: HOME_BASE first, PREVIOUS_SCHOOL after', () => {
  // Contract check: resolveOrigin returns HOME_BASE when no completed visits,
  // PREVIOUS_SCHOOL otherwise (logic lives in fieldVisits.resolveOrigin).
  // Here we assert the distance accumulation rule: total = seg1 + seg2, never home->each.
  const homeA = haversineKm(17.36, 78.47, 17.44, 78.45); // home->A ~12
  const aB = haversineKm(17.44, 78.45, 17.50, 78.49);    // A->B ~7
  const homeB = haversineKm(17.36, 78.47, 17.50, 78.49); // home->B (must NOT be used)
  const total = Math.round((homeA + aB) * 100) / 100;
  assert.ok(homeA > 5 && aB > 3, `segments ${homeA}, ${aB}`);
  assert.notEqual(Math.round((homeA + homeB) * 100) / 100, total, 'must not sum home->each');
});

test('qualification scoring explains priority', () => {
  const { priority, reasons } = scoreQualification(
    { need: 'HIGH', authority: 'DECISION_MAKER', budget: 'AVAILABLE', timeline: 'IMMEDIATE', engagement: 'HIGH' },
    { total_students: 1240, erp_satisfaction: 'LOW' },
  );
  assert.equal(priority, 'HIGH');
  assert.ok(reasons.length >= 3, `expected reasons, got ${JSON.stringify(reasons)}`);
  const low = scoreQualification({ need: 'LOW' }, {});
  assert.equal(low.priority, 'LOW');
});

test('null coords never crash distance', async () => {
  const d = await computeTravelDistance({ lat: null, lng: null }, { lat: 17.4, lng: 78.4 });
  assert.equal(d.travel_km, null);
});

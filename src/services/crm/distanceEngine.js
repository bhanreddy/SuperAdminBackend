/**
 * Distance engine: Haversine fallback + optional route API.
 * Never overwrites GPS after calculation. Prefers route distance.
 */

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => v == null || Number.isNaN(Number(v)))) return null;
  const R = 6371;
  const dLat = toRad(Number(bLat) - Number(aLat));
  const dLng = toRad(Number(bLng) - Number(aLng));
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(aLat))) * Math.cos(toRad(Number(bLat))) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 100) / 100;
}

function proximityMeters(aLat, aLng, bLat, bLng) {
  const km = haversineKm(aLat, aLng, bLat, bLng);
  return km == null ? null : Math.round(km * 1000);
}

function verifyProximity(distanceM) {
  if (distanceM == null) return 'NO_SCHOOL_GPS';
  if (distanceM <= 150) return 'VERIFIED';
  if (distanceM <= 500) return 'WARNING';
  return 'OUTSIDE';
}

async function fetchRouteKm(origin, dest) {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key || origin.lat == null || dest.lat == null) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
        travelMode: 'DRIVE',
      }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const meters = data?.routes?.[0]?.distanceMeters;
    if (!meters) return null;
    return { km: Math.round((meters / 1000) * 100) / 100, source: 'google_routes' };
  } catch {
    return null;
  }
}

/**
 * First completed visit of the day starts at home/base (or the day-start pin).
 * Every later visit starts at the previous completed school. Never home → every school.
 */
function selectOrigin({ completedCount, home, dayStart, previous }) {
  if (!completedCount) {
    if (home && home.lat != null && home.lng != null) {
      return { type: 'HOME_BASE', lat: Number(home.lat), lng: Number(home.lng) };
    }
    if (dayStart && dayStart.lat != null && dayStart.lng != null) {
      return { type: 'DAY_START_LOCATION', lat: Number(dayStart.lat), lng: Number(dayStart.lng) };
    }
    return { type: 'UNKNOWN', lat: null, lng: null };
  }
  return {
    type: 'PREVIOUS_SCHOOL',
    lat: previous?.lat ?? null,
    lng: previous?.lng ?? null,
    previous_visit_id: previous?.id || null,
  };
}

async function computeTravelDistance(origin, dest) {
  const straight = haversineKm(origin.lat, origin.lng, dest.lat, dest.lng);
  const route = await fetchRouteKm(origin, dest);
  if (route) {
    return {
      straight_distance_km: straight,
      route_distance_km: route.km,
      distance_source: route.source,
      travel_km: route.km,
    };
  }
  return {
    straight_distance_km: straight,
    route_distance_km: null,
    distance_source: straight != null ? 'haversine' : 'haversine',
    travel_km: straight,
  };
}

module.exports = { haversineKm, proximityMeters, verifyProximity, computeTravelDistance, selectOrigin };

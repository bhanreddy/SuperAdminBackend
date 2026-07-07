const { createClient } = require('@supabase/supabase-js');
const config = require('./env');

// Use Node >=18 native fetch with an AbortController timeout.
// This avoids the node-fetch v2 ETIMEDOUT issues on Windows while
// giving each request a hard 30-second deadline.
const FETCH_TIMEOUT_MS = 30_000;

const customFetch = (url, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal
    : controller.signal;

  return fetch(url, { ...init, signal, keepalive: true }).finally(() =>
    clearTimeout(timer),
  );
};

const supabaseOpts = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: customFetch },
};

// ── School Supabase ─────────────────────────────────────────────────────────
// schoolSupabase (anon): used ONLY for JWT validation via getUser(token)
const schoolSupabase = createClient(
  config.schoolSupabase.url,
  config.schoolSupabase.anonKey,
  supabaseOpts,
);

// schoolSupabaseAdmin (service_role): used for super_admins/founders table
// lookups, auth.admin operations (createUser, deleteUser, updateUser),
// and Supabase Storage signed URLs.
const schoolSupabaseAdmin = createClient(
  config.schoolSupabase.url,
  config.schoolSupabase.serviceRoleKey,
  supabaseOpts,
);

// ── Medical Supabase ────────────────────────────────────────────────────────
// medicalSupabase (service_role): used ONLY for medical_profile CRUD and
// medical auth.admin operations. May be null if not configured.
let medicalSupabase = null;
if (config.medicalSupabase.url && config.medicalSupabase.serviceRoleKey) {
  medicalSupabase = createClient(
    config.medicalSupabase.url,
    config.medicalSupabase.serviceRoleKey,
    supabaseOpts,
  );
}

module.exports = {
  schoolSupabase,
  schoolSupabaseAdmin,
  medicalSupabase,
};

const { createClient } = require('@supabase/supabase-js');
const { schoolSupabaseAdmin: localSupabase } = require('../config/supabase');

/**
 * Returns a Supabase SERVICE ROLE client for the given cluster + vertical.
 * Used exclusively for server-side seeding and admin operations.
 * NEVER expose this client or its credentials to the frontend.
 *
 * @param cluster_id - ID of the target cluster
 * @param vertical - 'school' | 'medical'
 * @returns Supabase client connected to the correct cluster DB
 */
async function getClusterServiceClient(cluster_id, vertical) {
  // Fetch cluster credentials from Cluster A's DB (master registry)
  // using the LOCAL Supabase client (Cluster A's service role)
  const { data: cluster, error } = await localSupabase
    .from('clusters')
    .select(
      vertical === 'school'
        ? 'school_supabase_url, school_service_role_key'
        : 'medical_supabase_url, medical_service_role_key'
    )
    .eq('cluster_id', cluster_id)
    .single();

  if (error || !cluster) {
    throw new Error(`Cluster not found: ${cluster_id}`);
  }

  const url = vertical === 'school'
    ? cluster.school_supabase_url
    : cluster.medical_supabase_url;

  const key = vertical === 'school'
    ? cluster.school_service_role_key
    : cluster.medical_service_role_key;

  if (!url || !key) {
    throw new Error(
      `Cluster ${cluster_id} is missing ${vertical} credentials. ` +
      `Ensure service_role_key was provided when the cluster was registered.`
    );
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

module.exports = { getClusterServiceClient };

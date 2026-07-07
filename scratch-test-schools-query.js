require('dotenv').config();
const { getClusterServiceClient } = require('./src/utils/clusterClient');

async function test() {
  try {
    const client = await getClusterServiceClient('cluster_a', 'school');
    const { data, error } = await client.from('schools').select(`
      id, name, code, address, logo_url, is_active, created_at,
      cluster_id, backend_url, android_package, ios_bundle_id, primary_color, 
      onboarding_status, onboarding_completed_at,
      minimum_app_version, force_update_enabled,
      payment_banner_enabled, payment_banner_reason
    `);
    
    console.log("Data:", data ? data.length : null);
    console.log("Error:", error);
  } catch (err) {
    console.error("Caught exception:", err);
  }
}

test();

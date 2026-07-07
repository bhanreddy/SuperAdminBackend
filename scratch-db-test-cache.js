const { schoolSupabaseAdmin } = require('./src/config/supabase');

async function test() {
  console.log("Fetching clusters...");
  const { data, error } = await schoolSupabaseAdmin.from('clusters').select('*');
  console.log("Data:", data);
  console.log("Error:", error);
  
  if (error && error.code === 'PGRST205') {
    console.log("Attempting schema cache reload via RPC (might fail if not supported/exist)");
    const { data: rpcData, error: rpcError } = await schoolSupabaseAdmin.rpc('reload_schema_cache');
    console.log("RPC Data:", rpcData, "RPC Error:", rpcError);
    
    // Test again
    const { data: d2, error: e2 } = await schoolSupabaseAdmin.from('clusters').select('*');
    console.log("Data2:", d2);
    console.log("Error2:", e2);
  }
}
test();

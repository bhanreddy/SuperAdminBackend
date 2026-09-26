const express = require('express');
const config = require('../../config/env');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { requirePlatformAdmin } = require('../../middleware/crmAccess');
const { sendResponse } = require('../../utils/apiResponse');
const fetch = require('node-fetch'); // Use for validate endpoint pinging
const { getClusterServiceClient } = require('../../utils/clusterClient');

const PUBLIC_COLUMNS = `
  cluster_id,
  label,
  status,
  school_backend_url,
  medical_backend_url,
  school_supabase_url,
  medical_supabase_url,
  school_anon_key,
  medical_anon_key,
  max_schools,
  school_count,
  medical_count,
  created_at,
  updated_at
`;

const router = express.Router();

/**
 * GET /api/super-admin/clusters
 * Returns the cluster registry from the database.
 * Computes live school_count and medical_count from each cluster's DB.
 * No auth required.
 */
router.get('/', async (req, res) => {
  try {
    const showAll = req.query.all === 'true';

    let query = schoolSupabaseAdmin.from('clusters').select(PUBLIC_COLUMNS);
    if (!showAll) {
      query = query.eq('status', 'active');
    }

    const { data: clusters, error } = await query.order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    // Compute live counts from each cluster's actual database
    const formattedClusters = await Promise.all(clusters.map(async (c) => {
      let liveSchoolCount = c.school_count || 0;
      let liveMedicalCount = c.medical_count || 0;

      try {
        const schoolClient = await getClusterServiceClient(c.cluster_id, 'school');
        const { count, error: schoolErr } = await schoolClient
          .from('schools')
          .select('*', { count: 'exact', head: true });
        if (!schoolErr && count !== null) {
          liveSchoolCount = count;
          // Sync back to clusters table if drifted
          if (liveSchoolCount !== c.school_count) {
            await schoolSupabaseAdmin.from('clusters')
              .update({ school_count: liveSchoolCount })
              .eq('cluster_id', c.cluster_id);
          }
        }
      } catch (err) {
        console.warn(`[clusters] Could not compute live school_count for ${c.cluster_id}:`, err.message);
      }

      try {
        const medicalClient = await getClusterServiceClient(c.cluster_id, 'medical');
        const { count, error: medErr } = await medicalClient
          .from('medical_shops')
          .select('*', { count: 'exact', head: true });
        if (!medErr && count !== null) {
          liveMedicalCount = count;
          // Sync back to clusters table if drifted
          if (liveMedicalCount !== c.medical_count) {
            await schoolSupabaseAdmin.from('clusters')
              .update({ medical_count: liveMedicalCount })
              .eq('cluster_id', c.cluster_id);
          }
        }
      } catch (err) {
        console.warn(`[clusters] Could not compute live medical_count for ${c.cluster_id}:`, err.message);
      }

      return {
        cluster_id: c.cluster_id,
        label: c.label,
        status: c.status,
        school_db: {
          supabase_url: c.school_supabase_url,
          supabase_anon_key: c.school_anon_key,
          backend_url: c.school_backend_url,
        },
        medical_db: {
          supabase_url: c.medical_supabase_url,
          supabase_anon_key: c.medical_anon_key,
          backend_url: c.medical_backend_url,
        },
        max_schools: c.max_schools,
        school_count: liveSchoolCount,
        medical_count: liveMedicalCount,
      };
    }));

    return res.json(formattedClusters);
  } catch (err) {
    console.error('Error fetching clusters:', err);
    return res.status(500).json({ error: 'Failed to fetch clusters' });
  }
});

/**
 * POST /api/super-admin/clusters
 * Create a new cluster.
 */
router.post('/', verifySuperAdminMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    const {
      cluster_id, label, school_backend_url, medical_backend_url,
      school_supabase_url, medical_supabase_url,
      school_anon_key, medical_anon_key, max_schools,
      school_service_role_key, medical_service_role_key
    } = req.body;

    if (!cluster_id || !label || !school_backend_url || !medical_backend_url || !school_service_role_key || !medical_service_role_key) {
      return res.status(400).json({ error: 'Missing required fields including service role keys' });
    }

    if (!/^[a-z0-9_]+$/.test(cluster_id)) {
      return res.status(400).json({ error: 'cluster_id must be lowercase, alphanumeric, and underscores only' });
    }

    // Check uniqueness
    const { data: existing, error: checkErr } = await schoolSupabaseAdmin
      .from('clusters')
      .select('cluster_id')
      .eq('cluster_id', cluster_id)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'cluster_id already exists' });
    }

    const newCluster = {
      cluster_id,
      label,
      school_backend_url,
      medical_backend_url,
      school_supabase_url,
      medical_supabase_url,
      school_anon_key,
      medical_anon_key,
      school_service_role_key,
      medical_service_role_key,
      max_schools: max_schools || 40,
      school_count: 0,
      status: 'active'
    };

    const { data, error } = await schoolSupabaseAdmin
      .from('clusters')
      .insert([newCluster])
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) throw error;

    // Test connectivity
    try {
      const sClient = await getClusterServiceClient(cluster_id, 'school');
      const mClient = await getClusterServiceClient(cluster_id, 'medical');
      
      const sRes = await sClient.auth.admin.listUsers({ perPage: 1 });
      if (sRes.error) throw new Error(`school service role key invalid: ${sRes.error.message}`);
      
      const mRes = await mClient.auth.admin.listUsers({ perPage: 1 });
      if (mRes.error) throw new Error(`medical service role key invalid: ${mRes.error.message}`);
    } catch (testErr) {
      // Rollback
      await schoolSupabaseAdmin.from('clusters').delete().eq('cluster_id', cluster_id);
      return res.status(400).json({ error: `service_role_key validation failed: ${testErr.message}` });
    }

    return sendResponse(res, 201, data);
  } catch (err) {
    console.error('Error creating cluster:', err);
    return res.status(500).json({ error: 'Failed to create cluster' });
  }
});

/**
 * GET /api/super-admin/clusters/assign
 * Finds the best cluster to assign the next school to.
 */
router.get('/assign', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const vertical = req.query.vertical === 'medical' ? 'medical' : 'school';

    const { data: clusters, error } = await schoolSupabaseAdmin
      .from('clusters')
      .select(PUBLIC_COLUMNS)
      .eq('status', 'active');

    if (error) throw error;

    const available = clusters.filter(c => (vertical === 'medical' ? (c.medical_count || 0) : c.school_count) < c.max_schools);

    if (available.length === 0) {
      return res.status(503).json({ error: `All clusters at ${vertical} capacity. Add a new cluster before onboarding more.` });
    }

    // Sort by count ascending
    available.sort((a, b) => (vertical === 'medical' ? (a.medical_count || 0) - (b.medical_count || 0) : a.school_count - b.school_count));

    // Map to frontend ClusterConfig shape for consistency
    const assigned = available[0];
    const formatted = {
      cluster_id: assigned.cluster_id,
      label: assigned.label,
      status: assigned.status,
      school_db: {
        supabase_url: assigned.school_supabase_url,
        supabase_anon_key: assigned.school_anon_key,
        backend_url: assigned.school_backend_url,
      },
      medical_db: {
        supabase_url: assigned.medical_supabase_url,
        supabase_anon_key: assigned.medical_anon_key,
        backend_url: assigned.medical_backend_url,
      },
      max_schools: assigned.max_schools,
      school_count: assigned.school_count,
      medical_count: assigned.medical_count,
    };

    return sendResponse(res, 200, formatted);
  } catch (err) {
    console.error('Error assigning cluster:', err);
    return res.status(500).json({ error: 'Failed to assign cluster' });
  }
});

/**
 * PATCH /api/super-admin/clusters/:cluster_id
 * Update an existing cluster.
 */
router.patch('/:cluster_id', verifySuperAdminMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    const { cluster_id } = req.params;
    const updates = req.body;

    // Disallow updating cluster_id
    delete updates.cluster_id;

    updates.updated_at = new Date().toISOString();

    const { data, error } = await schoolSupabaseAdmin
      .from('clusters')
      .update(updates)
      .eq('cluster_id', cluster_id)
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) throw error;

    if (updates.school_service_role_key || updates.medical_service_role_key) {
      try {
        if (updates.school_service_role_key) {
          const sClient = await getClusterServiceClient(cluster_id, 'school');
          const sRes = await sClient.auth.admin.listUsers({ perPage: 1 });
          if (sRes.error) throw new Error(`school: ${sRes.error.message}`);
        }
        if (updates.medical_service_role_key) {
          const mClient = await getClusterServiceClient(cluster_id, 'medical');
          const mRes = await mClient.auth.admin.listUsers({ perPage: 1 });
          if (mRes.error) throw new Error(`medical: ${mRes.error.message}`);
        }
      } catch (testErr) {
        return res.status(400).json({ error: `service_role_key validation failed: ${testErr.message}` });
      }
    }

    return sendResponse(res, 200, data);
  } catch (err) {
    console.error('Error updating cluster:', err);
    return res.status(500).json({ error: 'Failed to update cluster' });
  }
});

/**
 * POST /api/super-admin/clusters/:cluster_id/validate
 * Validates backend URLs.
 */
router.post('/:cluster_id/validate', verifySuperAdminMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    const { school_backend_url, medical_backend_url } = req.body;
    
    if (!school_backend_url || !medical_backend_url) {
      return res.status(400).json({ error: 'Both backend URLs are required for validation' });
    }

    const start = Date.now();
    let school_reachable = false;
    let medical_reachable = false;

    const ping = async (url) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        // pinging health endpoint or the base clusters endpoint to verify connection
        const target = `${url}/health`; 
        const response = await fetch(target, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        
        return response.ok;
      } catch (err) {
        return false;
      }
    };

    const [schoolRes, medicalRes] = await Promise.all([
      ping(school_backend_url),
      ping(medical_backend_url)
    ]);

    school_reachable = schoolRes;
    medical_reachable = medicalRes;

    const latency_ms = Date.now() - start;

    return sendResponse(res, 200, {
      school_reachable,
      medical_reachable,
      latency_ms
    });

  } catch (err) {
    console.error('Error validating cluster URLs:', err);
    return res.status(500).json({ error: 'Failed to validate cluster' });
  }
});

/**
 * PATCH /api/super-admin/clusters/:cluster_id/status
 * Activate or deactivate a cluster.
 */
router.patch('/:cluster_id/status', verifySuperAdminMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    const { cluster_id } = req.params;
    const { status } = req.body;

    if (status !== 'active' && status !== 'inactive') {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // We block deactivating the cluster currently running this code.
    // However, backend env does not currently have `CLUSTER_ID`. 
    // Wait! A standard practice is not to deactivate cluster_a if we are cluster_a.
    // Currently, let's assume `cluster_a` is the primary and we block if cluster_id is 'cluster_a'.
    // The spec says: (check if cluster_id matches this backend's own cluster_id from env)
    // We will check config for its own identifier. If none exists, block 'cluster_a'.
    const ownClusterId = process.env.CLUSTER_ID || 'cluster_a';

    if (status === 'inactive' && cluster_id === ownClusterId) {
      return res.status(400).json({ error: 'Cannot deactivate the currently connected cluster' });
    }

    const { data, error } = await schoolSupabaseAdmin
      .from('clusters')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('cluster_id', cluster_id)
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) throw error;

    return sendResponse(res, 200, data);
  } catch (err) {
    console.error('Error updating cluster status:', err);
    return res.status(500).json({ error: 'Failed to update cluster status' });
  }
});

module.exports = router;

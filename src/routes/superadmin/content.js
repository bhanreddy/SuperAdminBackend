const express = require('express');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { getClusterServiceClient } = require('../../utils/clusterClient');

const router = express.Router();

// All routes require super admin verification
router.use(verifySuperAdminMiddleware);

// Allowed content tables (whitelist to prevent SQL injection)
const ALLOWED_TABLES = {
  money_science: 'money_science_modules',
  life_values: 'life_values_modules',
  science_projects: 'science_projects',
};

async function getSchoolContentClient(schoolId) {
  const { data: clusters, error } = await schoolSupabaseAdmin
    .from('clusters')
    .select('cluster_id')
    .eq('status', 'active');

  if (error) throw error;

  for (const cluster of clusters || []) {
    const client = await getClusterServiceClient(cluster.cluster_id, 'school');
    const { data: school, error: schoolError } = await client
      .from('schools')
      .select('id')
      .eq('id', schoolId)
      .maybeSingle();

    if (schoolError) throw schoolError;
    if (school) return client;
  }

  const err = new Error(`School '${schoolId}' not found`);
  err.statusCode = 404;
  throw err;
}

// POST /api/super-admin/content
router.post('/', async (req, res) => {
  try {
    const { content_type, title, description, school_id, content_url, content_body, ...extra } =
      req.body;

    if (!content_type || !ALLOWED_TABLES[content_type]) {
      return res.status(400).json({
        error: `content_type must be one of: ${Object.keys(ALLOWED_TABLES).join(', ')}`,
      });
    }
    if (!title || !description || !school_id) {
      return res.status(400).json({ error: 'title, description, and school_id are required' });
    }

    const targetClient = await getSchoolContentClient(school_id);

    if (content_type === 'money_science') {
      const { data: row, error } = await targetClient
        .from('money_science_modules')
        .insert({
          title,
          description,
          school_id,
          content_url: content_url || null,
          content_body: content_body || null,
          age_group: extra.age_group || null,
          estimated_duration: parseInt(extra.estimated_duration) || 0,
          total_points: parseInt(extra.total_points) || 10,
          difficulty_level: extra.difficulty_level || 'beginner',
        })
        .select()
        .single();

      if (error) throw error;
      return sendResponse(res, 201, row);
    }

    if (content_type === 'life_values') {
      const { data: row, error } = await targetClient
        .from('life_values_modules')
        .insert({
          title,
          description,
          school_id,
          content_url: content_url || null,
          content_body: content_body || null,
        })
        .select()
        .single();

      if (error) throw error;
      return sendResponse(res, 201, row);
    }

    if (content_type === 'science_projects') {
      const materials = content_body ? content_body.split('\n').filter(Boolean) : [];
      const { data: row, error } = await targetClient
        .from('science_projects')
        .insert({
          title,
          description,
          school_id,
          content_url: content_url || null,
          difficulty_level: extra.difficulty_level || 'beginner',
          materials_required: materials,
        })
        .select()
        .single();

      if (error) throw error;
      return sendResponse(res, 201, row);
    }
  } catch (err) {
    console.error('Error creating content:', err);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create content' });
  }
});

module.exports = router;

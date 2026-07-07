const express = require('express');
const sql = require('../config/db');
const { schoolSupabaseAdmin } = require('../config/supabase');
const { sendResponse } = require('../utils/apiResponse');

const BUCKET = 'festival-posters';
const VALID_APPS = ['schoolims', 'medipos', 'paperforge'];

const router = express.Router();

// GET /api/public/festival-poster?app=schoolims|medipos|paperforge
// Unauthenticated: consumed by every client app on dashboard mount.
router.get('/festival-poster', async (req, res) => {
  try {
    const app = String(req.query.app || '').toLowerCase();
    if (!VALID_APPS.includes(app)) {
      return res.status(400).json({ error: `app must be one of: ${VALID_APPS.join(', ')}` });
    }

    const [row] = await sql`
      SELECT id, title, image_path, ends_at
      FROM festival_posters
      WHERE is_active = TRUE
        AND now() BETWEEN starts_at AND ends_at
        AND ${app} = ANY(target_apps)
      ORDER BY created_at DESC
      LIMIT 1
    `;

    res.set('Cache-Control', 'public, max-age=300');
    if (!row) {
      return sendResponse(res, 200, { poster: null });
    }

    const { data } = schoolSupabaseAdmin.storage.from(BUCKET).getPublicUrl(row.image_path);
    return sendResponse(res, 200, {
      poster: {
        id: row.id,
        title: row.title,
        image_url: data?.publicUrl ?? null,
        ends_at: row.ends_at,
      },
    });
  } catch (err) {
    console.error('Error fetching festival poster:', err);
    return res.status(500).json({ error: 'Failed to fetch festival poster' });
  }
});

module.exports = router;

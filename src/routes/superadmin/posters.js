const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const sql = require('../../config/db');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const BUCKET = 'festival-posters';
const VALID_APPS = ['schoolims', 'medipos', 'paperforge'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

const router = express.Router();

// All routes require super admin verification
router.use(verifySuperAdminMiddleware);

function posterStatus(row) {
  const now = Date.now();
  if (!row.is_active) return 'disabled';
  if (new Date(row.starts_at).getTime() > now) return 'upcoming';
  if (new Date(row.ends_at).getTime() < now) return 'expired';
  return 'live';
}

function withPublicUrl(row) {
  const { data } = schoolSupabaseAdmin.storage.from(BUCKET).getPublicUrl(row.image_path);
  return { ...row, image_url: data?.publicUrl ?? null, status: posterStatus(row) };
}

function parseTargetApps(raw) {
  let apps = raw;
  if (typeof raw === 'string') {
    try {
      apps = JSON.parse(raw);
    } catch {
      apps = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(apps) || apps.length === 0) return null;
  const cleaned = apps.map((a) => String(a).toLowerCase());
  if (cleaned.some((a) => !VALID_APPS.includes(a))) return null;
  return cleaned;
}

// GET /api/super-admin/posters — list all posters, newest first
router.get('/', async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, title, image_path, target_apps, starts_at, ends_at, is_active, created_at
      FROM festival_posters
      ORDER BY created_at DESC
    `;
    return sendResponse(res, 200, { posters: rows.map(withPublicUrl) });
  } catch (err) {
    console.error('Error listing festival posters:', err);
    return res.status(500).json({ error: 'Failed to list posters' });
  }
});

// POST /api/super-admin/posters — upload image + create poster
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }
    const mimeType = req.file.mimetype;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      return res.status(400).json({ error: 'Image must be png, jpeg, or webp' });
    }

    const { title, starts_at, ends_at, created_by } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!ends_at || Number.isNaN(Date.parse(ends_at))) {
      return res.status(400).json({ error: 'ends_at (valid date) is required' });
    }
    const startsAt = starts_at && !Number.isNaN(Date.parse(starts_at)) ? new Date(starts_at) : new Date();
    const endsAt = new Date(ends_at);
    if (endsAt <= startsAt) {
      return res.status(400).json({ error: 'ends_at must be after starts_at' });
    }

    const targetApps = parseTargetApps(req.body.target_apps ?? VALID_APPS);
    if (!targetApps) {
      return res.status(400).json({ error: `target_apps must be a non-empty subset of: ${VALID_APPS.join(', ')}` });
    }

    const id = crypto.randomUUID();
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const storagePath = `${id}.${ext}`;

    const { error: uploadError } = await schoolSupabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, { contentType: mimeType, upsert: true });
    if (uploadError) throw uploadError;

    const [row] = await sql`
      INSERT INTO festival_posters (id, title, image_path, target_apps, starts_at, ends_at, created_by)
      VALUES (${id}, ${String(title).trim()}, ${storagePath}, ${targetApps},
              ${startsAt.toISOString()}, ${endsAt.toISOString()}, ${created_by || null})
      RETURNING id, title, image_path, target_apps, starts_at, ends_at, is_active, created_at
    `;

    return sendResponse(res, 201, { poster: withPublicUrl(row) });
  } catch (err) {
    console.error('Error creating festival poster:', err);
    return res.status(500).json({ error: 'Failed to create poster', details: err.message });
  }
});

// PATCH /api/super-admin/posters/:id — toggle/edit
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, starts_at, ends_at, is_active } = req.body;

    const targetApps = req.body.target_apps !== undefined ? parseTargetApps(req.body.target_apps) : undefined;
    if (req.body.target_apps !== undefined && !targetApps) {
      return res.status(400).json({ error: `target_apps must be a non-empty subset of: ${VALID_APPS.join(', ')}` });
    }

    const [row] = await sql`
      UPDATE festival_posters SET
        title = COALESCE(${title ?? null}, title),
        starts_at = COALESCE(${starts_at ?? null}, starts_at),
        ends_at = COALESCE(${ends_at ?? null}, ends_at),
        is_active = COALESCE(${typeof is_active === 'boolean' ? is_active : null}, is_active),
        target_apps = COALESCE(${targetApps ?? null}, target_apps)
      WHERE id = ${id}
      RETURNING id, title, image_path, target_apps, starts_at, ends_at, is_active, created_at
    `;
    if (!row) {
      return res.status(404).json({ error: 'Poster not found' });
    }
    return sendResponse(res, 200, { poster: withPublicUrl(row) });
  } catch (err) {
    console.error('Error updating festival poster:', err);
    return res.status(500).json({ error: 'Failed to update poster' });
  }
});

// DELETE /api/super-admin/posters/:id — remove row + storage object
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [row] = await sql`
      DELETE FROM festival_posters WHERE id = ${id}
      RETURNING image_path
    `;
    if (!row) {
      return res.status(404).json({ error: 'Poster not found' });
    }
    const { error: removeError } = await schoolSupabaseAdmin.storage.from(BUCKET).remove([row.image_path]);
    if (removeError) {
      // Row is gone; orphaned object is harmless but worth logging.
      console.error('Failed to remove poster image from storage:', removeError);
    }
    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error deleting festival poster:', err);
    return res.status(500).json({ error: 'Failed to delete poster' });
  }
});

module.exports = router;

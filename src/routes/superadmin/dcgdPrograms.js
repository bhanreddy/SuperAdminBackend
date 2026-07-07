const express = require('express');
const sql = require('../../config/db');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { sendResponse } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');
const dcgdContentRouter = require('./dcgdContent');

const router = express.Router();

router.use(verifySuperAdminMiddleware);

// Sub-router: per-program content management
router.use('/programs/:programId/content', dcgdContentRouter);

router.get(
  '/programs',
  asyncHandler(async (req, res) => {
    const rows = await sql`
      SELECT id, name, description, icon, display_order, is_active, created_at, updated_at
      FROM dcgd_programs
      ORDER BY display_order ASC, id ASC
    `;
    return sendResponse(res, 200, rows);
  }),
);

router.post(
  '/programs',
  asyncHandler(async (req, res) => {
    const { name, description, icon, display_order, is_active } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const desc = typeof description === 'string' ? description : '';
    const ic = typeof icon === 'string' && icon.trim() ? icon.trim() : 'ribbon-outline';
    const order =
      typeof display_order === 'number' && Number.isFinite(display_order)
        ? display_order
        : (await sql`SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM dcgd_programs`)[0].n;
    const active = typeof is_active === 'boolean' ? is_active : true;

    const [row] = await sql`
      INSERT INTO dcgd_programs (name, description, icon, display_order, is_active)
      VALUES (${name.trim()}, ${desc}, ${ic}, ${order}, ${active})
      RETURNING id, name, description, icon, display_order, is_active, created_at, updated_at
    `;
    return sendResponse(res, 201, row);
  }),
);

router.patch(
  '/programs/:id',
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid program id' });
    }
    const { name, description, icon, display_order, is_active } = req.body || {};

    const [cur] = await sql`
      SELECT id, name, description, icon, display_order, is_active
      FROM dcgd_programs WHERE id = ${id}
    `;
    if (!cur) {
      return res.status(404).json({ error: 'Program not found' });
    }

    if (typeof name === 'string' && !name.trim()) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
    const nextName = typeof name === 'string' && name.trim() ? name.trim() : cur.name;
    const nextDesc = typeof description === 'string' ? description : cur.description;
    const nextIcon = typeof icon === 'string' && icon.trim() ? icon.trim() : cur.icon;
    const nextOrder =
      typeof display_order === 'number' && Number.isFinite(display_order)
        ? display_order
        : cur.display_order;
    const nextActive = typeof is_active === 'boolean' ? is_active : cur.is_active;

    if (
      name === undefined &&
      description === undefined &&
      icon === undefined &&
      display_order === undefined &&
      is_active === undefined
    ) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const [row] = await sql`
      UPDATE dcgd_programs
      SET
        name = ${nextName},
        description = ${nextDesc},
        icon = ${nextIcon},
        display_order = ${nextOrder},
        is_active = ${nextActive}
      WHERE id = ${id}
      RETURNING id, name, description, icon, display_order, is_active, created_at, updated_at
    `;

    return sendResponse(res, 200, row);
  }),
);

router.delete(
  '/programs/:id',
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid program id' });
    }
    const rows = await sql`
      DELETE FROM dcgd_programs WHERE id = ${id} RETURNING id
    `;
    if (!rows.length) {
      return res.status(404).json({ error: 'Program not found' });
    }
    return sendResponse(res, 200, { success: true, id });
  }),
);

router.post(
  '/programs/reorder',
  asyncHandler(async (req, res) => {
    const { ordered_ids: orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'ordered_ids must be a non-empty array' });
    }
    const ids = orderedIds.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
    if (ids.length !== orderedIds.length) {
      return res.status(400).json({ error: 'ordered_ids must contain numeric ids' });
    }

    await sql.begin(async (tx) => {
      for (let i = 0; i < ids.length; i += 1) {
        await tx`
          UPDATE dcgd_programs SET display_order = ${i + 1} WHERE id = ${ids[i]}
        `;
      }
    });

    const rows = await sql`
      SELECT id, name, description, icon, display_order, is_active, created_at, updated_at
      FROM dcgd_programs
      ORDER BY display_order ASC, id ASC
    `;
    return sendResponse(res, 200, rows);
  }),
);

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const [row] = await sql`
      SELECT id, page_title, subtitle, is_visible, created_at, updated_at
      FROM dcgd_settings
      WHERE id = 1
    `;
    if (!row) {
      return res.status(404).json({ error: 'DCGD settings not initialized' });
    }
    return sendResponse(res, 200, row);
  }),
);

router.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const { page_title: pageTitle, subtitle, is_visible: isVisible } = req.body || {};
    if (pageTitle !== undefined && (typeof pageTitle !== 'string' || !pageTitle.trim())) {
      return res
        .status(400)
        .json({ error: 'page_title must be a non-empty string when provided' });
    }
    if (subtitle !== undefined && typeof subtitle !== 'string') {
      return res.status(400).json({ error: 'subtitle must be a string when provided' });
    }
    if (isVisible !== undefined && typeof isVisible !== 'boolean') {
      return res.status(400).json({ error: 'is_visible must be a boolean when provided' });
    }

    const [existing] = await sql`SELECT id FROM dcgd_settings WHERE id = 1`;
    if (!existing) {
      await sql`
        INSERT INTO dcgd_settings (id, page_title, subtitle, is_visible)
        VALUES (
          1,
          ${typeof pageTitle === 'string' ? pageTitle.trim() : 'DCGD'},
          ${typeof subtitle === 'string' ? subtitle : 'Department of Career Growth and Development'},
          ${typeof isVisible === 'boolean' ? isVisible : true}
        )
      `;
    } else {
      const [cur] = await sql`
        SELECT page_title, subtitle, is_visible FROM dcgd_settings WHERE id = 1
      `;
      const nextTitle =
        typeof pageTitle === 'string' && pageTitle.trim() ? pageTitle.trim() : cur.page_title;
      const nextSub = typeof subtitle === 'string' ? subtitle : cur.subtitle;
      const nextVis = typeof isVisible === 'boolean' ? isVisible : cur.is_visible;

      if (pageTitle === undefined && subtitle === undefined && isVisible === undefined) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      await sql`
        UPDATE dcgd_settings
        SET
          page_title = ${nextTitle},
          subtitle = ${nextSub},
          is_visible = ${nextVis}
        WHERE id = 1
      `;
    }

    const [row] = await sql`
      SELECT id, page_title, subtitle, is_visible, created_at, updated_at
      FROM dcgd_settings
      WHERE id = 1
    `;
    return sendResponse(res, 200, row);
  }),
);

module.exports = router;

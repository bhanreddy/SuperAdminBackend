const express = require('express');
const sql = require('../../config/db');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { sendResponse } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router({ mergeParams: true });

router.use(verifySuperAdminMiddleware);

const COLUMNS =
  'id, program_id, title, link_url, pdf_url, image_url, content_body, display_order, is_active, created_at, updated_at';

/** GET /api/super-admin/dcgd/programs/:programId/content */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const programId = parseInt(req.params.programId, 10);
    if (!Number.isFinite(programId)) {
      return res.status(400).json({ error: 'Invalid programId' });
    }
    const rows = await sql`
      SELECT ${sql.unsafe(COLUMNS)}
      FROM dcgd_program_content
      WHERE program_id = ${programId}
      ORDER BY display_order ASC, id ASC
    `;
    return sendResponse(res, 200, rows);
  }),
);

/** POST /api/super-admin/dcgd/programs/:programId/content */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const programId = parseInt(req.params.programId, 10);
    if (!Number.isFinite(programId)) {
      return res.status(400).json({ error: 'Invalid programId' });
    }
    const { title, link_url, pdf_url, image_url, content_body, display_order, is_active } =
      req.body || {};

    console.log('[DCGD_ADMIN] CREATE REQUEST:', { programId, body: req.body });

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    // Verify program exists
    const [prog] = await sql`SELECT id FROM dcgd_programs WHERE id = ${programId}`;
    if (!prog) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const lUrl = typeof link_url === 'string' && link_url.trim() ? link_url.trim() : null;
    const pUrl = typeof pdf_url === 'string' && pdf_url.trim() ? pdf_url.trim() : null;
    const iUrl = typeof image_url === 'string' && image_url.trim() ? image_url.trim() : null;
    const body = typeof content_body === 'string' && content_body.trim() ? content_body : null;
    const order =
      typeof display_order === 'number' && Number.isFinite(display_order)
        ? display_order
        : (
            await sql`SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM dcgd_program_content WHERE program_id = ${programId}`
          )[0].n;
    const active = typeof is_active === 'boolean' ? is_active : true;

    const [row] = await sql`
      INSERT INTO dcgd_program_content (program_id, title, link_url, pdf_url, image_url, content_body, display_order, is_active)
      VALUES (${programId}, ${title.trim()}, ${lUrl}, ${pUrl}, ${iUrl}, ${body}, ${order}, ${active})
      RETURNING ${sql.unsafe(COLUMNS)}
    `;

    console.log('[DCGD_ADMIN] CREATE SUCCESS:', row);
    return sendResponse(res, 201, row);
  }),
);

/** PATCH /api/super-admin/dcgd/programs/:programId/content/:contentId */
router.patch(
  '/:contentId',
  asyncHandler(async (req, res) => {
    const programId = parseInt(req.params.programId, 10);
    const contentId = parseInt(req.params.contentId, 10);
    if (!Number.isFinite(programId) || !Number.isFinite(contentId)) {
      return res.status(400).json({ error: 'Invalid programId or contentId' });
    }

    const { title, link_url, pdf_url, image_url, content_body, display_order, is_active } =
      req.body || {};

    const [cur] = await sql`
      SELECT id, title, link_url, pdf_url, image_url, content_body, display_order, is_active
      FROM dcgd_program_content
      WHERE id = ${contentId} AND program_id = ${programId}
    `;
    if (!cur) {
      return res.status(404).json({ error: 'Content item not found' });
    }

    if (typeof title === 'string' && !title.trim()) {
      return res.status(400).json({ error: 'title cannot be empty' });
    }

    const nextTitle = typeof title === 'string' && title.trim() ? title.trim() : cur.title;
    const nextLinkUrl =
      link_url !== undefined
        ? typeof link_url === 'string' && link_url.trim()
          ? link_url.trim()
          : null
        : cur.link_url;
    const nextPdfUrl =
      pdf_url !== undefined
        ? typeof pdf_url === 'string' && pdf_url.trim()
          ? pdf_url.trim()
          : null
        : cur.pdf_url;
    const nextImageUrl =
      image_url !== undefined
        ? typeof image_url === 'string' && image_url.trim()
          ? image_url.trim()
          : null
        : cur.image_url;
    const nextBody =
      content_body !== undefined
        ? typeof content_body === 'string' && content_body.trim()
          ? content_body
          : null
        : cur.content_body;
    const nextOrder =
      typeof display_order === 'number' && Number.isFinite(display_order)
        ? display_order
        : cur.display_order;
    const nextActive = typeof is_active === 'boolean' ? is_active : cur.is_active;

    if (
      title === undefined &&
      link_url === undefined &&
      pdf_url === undefined &&
      image_url === undefined &&
      content_body === undefined &&
      display_order === undefined &&
      is_active === undefined
    ) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const [row] = await sql`
      UPDATE dcgd_program_content
      SET
        title = ${nextTitle},
        link_url = ${nextLinkUrl},
        pdf_url = ${nextPdfUrl},
        image_url = ${nextImageUrl},
        content_body = ${nextBody},
        display_order = ${nextOrder},
        is_active = ${nextActive}
      WHERE id = ${contentId} AND program_id = ${programId}
      RETURNING ${sql.unsafe(COLUMNS)}
    `;

    console.log('[DCGD_ADMIN] UPDATE SUCCESS:', { contentId, row });
    return sendResponse(res, 200, row);
  }),
);

/** DELETE /api/super-admin/dcgd/programs/:programId/content/:contentId */
router.delete(
  '/:contentId',
  asyncHandler(async (req, res) => {
    const programId = parseInt(req.params.programId, 10);
    const contentId = parseInt(req.params.contentId, 10);
    if (!Number.isFinite(programId) || !Number.isFinite(contentId)) {
      return res.status(400).json({ error: 'Invalid programId or contentId' });
    }
    const rows = await sql`
      DELETE FROM dcgd_program_content
      WHERE id = ${contentId} AND program_id = ${programId}
      RETURNING id
    `;
    if (!rows.length) {
      return res.status(404).json({ error: 'Content item not found' });
    }
    return sendResponse(res, 200, { success: true, id: contentId });
  }),
);

/** POST /api/super-admin/dcgd/programs/:programId/content/reorder */
router.post(
  '/reorder',
  asyncHandler(async (req, res) => {
    const programId = parseInt(req.params.programId, 10);
    if (!Number.isFinite(programId)) {
      return res.status(400).json({ error: 'Invalid programId' });
    }
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
          UPDATE dcgd_program_content
          SET display_order = ${i + 1}
          WHERE id = ${ids[i]} AND program_id = ${programId}
        `;
      }
    });

    const rows = await sql`
      SELECT ${sql.unsafe(COLUMNS)}
      FROM dcgd_program_content
      WHERE program_id = ${programId}
      ORDER BY display_order ASC, id ASC
    `;
    return sendResponse(res, 200, rows);
  }),
);

module.exports = router;

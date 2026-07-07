const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const router = express.Router();

// GET /api/super-admin/dashboard/stats
router.get('/stats', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const statsRow = await sql`
      SELECT
        (SELECT COUNT(*) FROM schools) AS total_schools,
        (SELECT COUNT(*) FROM schools WHERE is_active = true) AS active_schools,
        (SELECT COUNT(*) FROM students WHERE deleted_at IS NULL) AS total_students,
        (SELECT COUNT(*) FROM staff WHERE deleted_at IS NULL) AS total_staff,
        (SELECT COUNT(*) FROM super_admins WHERE is_active = true) AS total_super_admins
    `;

    const stats =
      statsRow && statsRow.length > 0
        ? statsRow[0]
        : {
            total_schools: 0,
            active_schools: 0,
            total_students: 0,
            total_staff: 0,
            total_super_admins: 0,
          };

    return sendResponse(res, 200, {
      total_schools: Number(stats.total_schools) || 0,
      active_schools: Number(stats.active_schools) || 0,
      total_students: Number(stats.total_students) || 0,
      total_staff: Number(stats.total_staff) || 0,
      total_super_admins: Number(stats.total_super_admins) || 0,
    });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats', debug: err.message });
  }
});

module.exports = router;

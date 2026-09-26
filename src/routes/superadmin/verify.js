const express = require('express');
const sql = require('../../config/db');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const router = express.Router();

// GET /api/super-admin/verify
router.get('/verify', verifySuperAdminMiddleware, async (req, res) => {
  try {
    // Try to update last_login first
    try {
      await sql`SELECT update_super_admin_last_login(${req.superAdmin.id})`;
    } catch (dbErr) {
      console.error(
        'Warning: Could not update last_login (DB might be timing out):',
        dbErr.message || dbErr.code,
      );
    }

    // Fetch full info to return directly via SQL
    const [adminData] = await sql`
      SELECT id, email, full_name, is_active, created_at, last_login, created_by
      FROM super_admins
      WHERE id = ${req.superAdmin.id}
    `;

    if (!adminData) {
      console.warn(`[verify] Super admin not found for id ${req.superAdmin.id}`);
      return res.status(403).json({ error: 'Super admin not found' });
    }

    return sendResponse(res, 200, { isSuperAdmin: true, admin: adminData });
  } catch (err) {
    console.error('Error in /verify:', err);
    // Default to returning basic info from the middleware if everything else fails
    return res.status(500).json({ error: 'Failed to verify super admin' });
  }
});

module.exports = router;

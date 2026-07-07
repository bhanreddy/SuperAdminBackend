const express = require('express');
const sql = require('../../config/db');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const router = express.Router();

// GET /api/super-admin/admins
// Uses direct SQL (same DB as auth middleware) so the list stays in sync with who
// can sign in. Includes active `founders` rows that are not already in
// `super_admins`, since founders get console access but were previously omitted
// from the Supabase-only query (showing "0 admins" while the header showed SA).
router.get('/', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM (
        SELECT
          sa.id,
          sa.email,
          sa.full_name,
          sa.is_active,
          sa.created_at,
          sa.last_login,
          sa.created_by,
          false AS is_founder
        FROM super_admins sa
        UNION ALL
        SELECT
          f.user_id AS id,
          COALESCE(NULLIF(TRIM(f.email), ''), '') AS email,
          COALESCE(NULLIF(TRIM(f.full_name), ''), 'Founder') AS full_name,
          f.is_active,
          f.created_at,
          NULL::timestamptz AS last_login,
          NULL::uuid AS created_by,
          true AS is_founder
        FROM founders f
        WHERE f.user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM super_admins sa2 WHERE sa2.id = f.user_id)
      ) merged
      ORDER BY merged.created_at ASC
    `;

    return sendResponse(res, 200, rows);
  } catch (err) {
    console.error('Error fetching super admins:', err);
    res.status(500).json({ error: 'Failed to fetch super admins' });
  }
});

// POST /api/super-admin/admins
router.post('/', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !email.includes('@'))
      return res.status(400).json({ error: 'Valid email is required' });
    if (!password || password.length < 12)
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    if (!full_name || full_name.length < 2)
      return res.status(400).json({ error: 'Full name must be at least 2 characters' });

    // Create in Auth
    const { data: authData, error: authError } = await schoolSupabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (authError) {
      if (
        authError.status === 422 ||
        authError.message.includes('already exists') ||
        authError.code === 'email_exists'
      ) {
        return res.status(409).json({ error: 'Email already exists' });
      }
      throw authError;
    }

    const authId = authData.user.id;

    // Insert into super_admins table
    const { data: newAdmin, error: insertError } = await schoolSupabaseAdmin
      .from('super_admins')
      .insert({
        id: authId,
        email,
        full_name,
        created_by: req.superAdmin.id,
      })
      .select('id, email, full_name, is_active, created_at, last_login, created_by')
      .single();

    if (insertError) throw insertError;

    return sendResponse(res, 201, newAdmin);
  } catch (err) {
    console.error('Error creating super admin:', err);
    res.status(500).json({ error: 'Failed to create super admin' });
  }
});

// PATCH /api/super-admin/admins/:id
router.patch('/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }

    const [inSuperAdmins] = await sql`SELECT id FROM super_admins WHERE id = ${id} LIMIT 1`;
    if (!inSuperAdmins) {
      return res.status(400).json({
        error:
          'This user is a founder (not a super_admins row). Activate or deactivate founders from founder management, not here.',
      });
    }

    if (id === req.superAdmin.id && !is_active) {
      return res.status(400).json({ error: 'Cannot deactivate yourself' });
    }

    // Guard: check last active
    if (!is_active) {
      const { count, error: countError } = await schoolSupabaseAdmin
        .from('super_admins')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true);

      if (countError) throw countError;

      if (count <= 1) {
        return res
          .status(400)
          .json({ error: 'Cannot deactivate the only active super admin' });
      }
    }

    const { data: updatedAdmin, error } = await schoolSupabaseAdmin
      .from('super_admins')
      .update({ is_active })
      .eq('id', id)
      .select('id, email, full_name, is_active, created_at, last_login, created_by')
      .single();

    if (error) throw error;

    return sendResponse(res, 200, updatedAdmin);
  } catch (err) {
    console.error('Error updating super admin:', err);
    res.status(500).json({ error: 'Failed to update super admin' });
  }
});

// DELETE /api/super-admin/admins/:id
router.delete('/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.superAdmin.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    const [inSuperAdmins] = await sql`SELECT id FROM super_admins WHERE id = ${id} LIMIT 1`;
    if (!inSuperAdmins) {
      return res.status(400).json({
        error: 'This user is a founder account. Remove them from the founders table, not via super admin delete.',
      });
    }

    const { count, error: countError } = await schoolSupabaseAdmin
      .from('super_admins')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    if (countError) throw countError;

    if (count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only super admin' });
    }

    const { error: deleteAuthError } = await schoolSupabaseAdmin.auth.admin.deleteUser(id);
    if (deleteAuthError) throw deleteAuthError;

    // super_admins row deletes via CASCADE since id REFERENCES auth.users(id) ON DELETE CASCADE

    return sendResponse(res, 200, { success: true });
  } catch (err) {
    console.error('Error deleting super admin:', err);
    res.status(500).json({ error: 'Failed to delete super admin' });
  }
});

module.exports = router;

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
  let authId = null;
  let isNewAuthUser = false;

  try {
    const { email, password, full_name } = req.body;

    const normEmail = String(email || '').trim().toLowerCase();
    const trimmedName = String(full_name || '').trim();

    if (!normEmail || !normEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!trimmedName || trimmedName.length < 2) {
      return res.status(400).json({ error: 'Full name must be at least 2 characters' });
    }

    const isUuid = (str) =>
      typeof str === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

    // Resolve creator ID: verify creator exists in super_admins table to respect FK constraint
    let createdById = null;
    if (req.superAdmin?.id && isUuid(req.superAdmin.id)) {
      const [creatorRow] = await sql`
        SELECT id FROM super_admins WHERE id = ${req.superAdmin.id} LIMIT 1
      `;
      if (creatorRow) {
        createdById = creatorRow.id;
      }
    }

    // Check if email already exists in super_admins
    const [existingSa] = await sql`
      SELECT id, is_active, full_name, email FROM super_admins
      WHERE LOWER(TRIM(email)) = ${normEmail}
      LIMIT 1
    `;

    if (existingSa) {
      if (existingSa.is_active) {
        return res.status(409).json({ error: 'A super admin with this email already exists' });
      }

      // Reactivate inactive super admin
      try {
        await schoolSupabaseAdmin.auth.admin.updateUserById(existingSa.id, {
          password,
          user_metadata: { full_name: trimmedName },
        });
      } catch (authUpdateErr) {
        console.warn('[admins:post] Warning updating auth password for reactivated admin:', authUpdateErr.message);
      }

      const [reactivated] = await sql`
        UPDATE super_admins
        SET is_active = true,
            full_name = ${trimmedName},
            email = ${normEmail}
        WHERE id = ${existingSa.id}
        RETURNING id, email, full_name, is_active, created_at, last_login, created_by
      `;
      return sendResponse(res, 200, reactivated);
    }

    // Create or link in Auth
    const { data: authData, error: authError } = await schoolSupabaseAdmin.auth.admin.createUser({
      email: normEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: trimmedName },
    });

    if (authError) {
      const isAlreadyExists =
        authError.status === 422 ||
        (authError.message && authError.message.toLowerCase().includes('already')) ||
        authError.code === 'email_exists';

      if (isAlreadyExists) {
        // Find existing user in auth.users
        const [existingAuthUser] = await sql`
          SELECT id, email FROM auth.users WHERE LOWER(TRIM(email)) = ${normEmail} LIMIT 1
        `;

        if (existingAuthUser) {
          authId = existingAuthUser.id;
          try {
            await schoolSupabaseAdmin.auth.admin.updateUserById(authId, {
              password,
              user_metadata: { full_name: trimmedName },
            });
          } catch (updateErr) {
            console.warn('[admins:post] Could not update auth user password:', updateErr.message);
          }
        } else {
          return res.status(409).json({ error: 'Email already exists in authentication system' });
        }
      } else {
        console.error('[admins:post] Auth createUser error:', authError);
        return res.status(authError.status || 500).json({
          error: authError.message || 'Failed to create user credentials',
        });
      }
    } else {
      authId = authData.user.id;
      isNewAuthUser = true;
    }

    // Insert into super_admins table via direct SQL
    try {
      const [newAdmin] = await sql`
        INSERT INTO super_admins (id, email, full_name, is_active, created_by, created_at)
        VALUES (${authId}, ${normEmail}, ${trimmedName}, true, ${createdById}, NOW())
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          full_name = EXCLUDED.full_name,
          is_active = true
        RETURNING id, email, full_name, is_active, created_at, last_login, created_by
      `;

      return sendResponse(res, 201, newAdmin);
    } catch (insertError) {
      // Roll back newly created auth user on DB insert failure
      if (isNewAuthUser && authId) {
        try {
          await schoolSupabaseAdmin.auth.admin.deleteUser(authId);
        } catch (cleanupErr) {
          console.error('[admins:post] Failed to clean up newly created auth user:', cleanupErr.message);
        }
      }
      console.error('[admins:post] Error inserting into super_admins:', insertError);
      return res.status(500).json({ error: 'Failed to save super admin record' });
    }
  } catch (err) {
    console.error('Error creating super admin:', err);
    if (isNewAuthUser && authId) {
      try {
        await schoolSupabaseAdmin.auth.admin.deleteUser(authId);
      } catch (_) {}
    }
    return res.status(500).json({ error: 'Failed to create super admin' });
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

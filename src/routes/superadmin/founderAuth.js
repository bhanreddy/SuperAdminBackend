const express = require('express');
const sql = require('../../config/db');
const { schoolSupabase, schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const router = express.Router();

function normalizeLoginEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/** Resolve a founders row by Supabase auth user id or by matching email. */
async function selectFounderForAuthUser(userId, authEmail) {
  const norm = normalizeLoginEmail(authEmail);
  const rows = norm
    ? await sql`
        SELECT id, user_id, email, full_name, role, is_active, created_at
        FROM founders
        WHERE user_id = ${userId}
           OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${norm})
        LIMIT 1
      `
    : await sql`
        SELECT id, user_id, email, full_name, role, is_active, created_at
        FROM founders
        WHERE user_id = ${userId}
        LIMIT 1
      `;
  return rows.length > 0 ? rows[0] : null;
}

async function selectSuperAdminForAuthUser(userId, authEmail) {
  const norm = normalizeLoginEmail(authEmail);
  const rows = norm
    ? await sql`
        SELECT id, is_active, email, full_name
        FROM super_admins
        WHERE id = ${userId}
           OR (email IS NOT NULL AND LOWER(TRIM(email)) = ${norm})
        LIMIT 1
      `
    : await sql`
        SELECT id, is_active, email, full_name
        FROM super_admins
        WHERE id = ${userId}
        LIMIT 1
      `;
  return rows.length > 0 ? rows[0] : null;
}

// POST /api/super-admin/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Use the ANON client for signInWithPassword
    const { data, error } = await schoolSupabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error('Login signInWithPassword error:', error.message);
      return res.status(401).json({ error: error.message || 'Invalid credentials' });
    }

    const user = data.user;
    const session = data.session;
    if (!user || !session) {
      return res.status(401).json({ error: 'Authentication failed' });
    }

    console.log(`[login] Auth OK for ${user.email} (id=${user.id})`);

    // Verify user is a super admin or active founder
    let superAdminRow = null;
    try {
      superAdminRow = await selectSuperAdminForAuthUser(user.id, user.email);
      if (superAdminRow && superAdminRow.id !== user.id) {
        await sql`UPDATE super_admins SET id = ${user.id} WHERE id = ${superAdminRow.id}`;
        superAdminRow.id = user.id;
      }
    } catch (saError) {
      console.log(`[login] super_admins lookup error:`, saError.message);
    }

    const isSuperAdmin = superAdminRow && superAdminRow.is_active === true;
    console.log(`[login] isSuperAdmin=${isSuperAdmin}, row=`, superAdminRow ? 'found' : 'null');

    let founder = await selectFounderForAuthUser(user.id, user.email);
    if (founder && founder.is_active === true && founder.user_id !== user.id) {
      await sql`UPDATE founders SET user_id = ${user.id} WHERE id = ${founder.id}`;
      founder = { ...founder, user_id: user.id };
    }
    const founderOk = founder && founder.is_active === true;
    console.log(`[login] founderOk=${founderOk}, founder=`, founder ? 'found' : 'null');

    if (!isSuperAdmin && !founderOk) {
      return res.status(403).json({
        error:
          'Access denied. Sign in with an account listed in super_admins (active) or founders (active). If you are a founder, ensure your row uses this auth user id or the same email as Supabase Auth.',
      });
    }

    return sendResponse(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        user_metadata: user.user_metadata,
      },
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
      },
      isSuperAdmin,
      admin: isSuperAdmin ? superAdminRow : null,
      founder: founderOk ? founder : null,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/super-admin/auth/me
router.get('/me', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const userId = req.superAdmin.id;

    const founder = await selectFounderForAuthUser(userId, req.superAdmin.email);

    // Fetch super admin info directly via SQL
    const [adminData] = await sql`
      SELECT id, email, full_name, is_active, created_at, last_login, created_by
      FROM super_admins
      WHERE id = ${userId}
    `;

    return sendResponse(res, 200, {
      isSuperAdmin: true,
      admin: adminData || req.superAdmin,
      founder: founder && founder.is_active ? founder : null,
    });
  } catch (err) {
    console.error('Error in /auth/me:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /api/super-admin/auth/change-password
router.post('/change-password', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const { error } = await schoolSupabaseAdmin.auth.admin.updateUserById(req.superAdmin.id, {
      password: newPassword,
    });
    if (error) throw error;

    return sendResponse(res, 200, { success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Error changing password:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

// POST /api/super-admin/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }

    const { data, error } = await schoolSupabaseAdmin.auth.refreshSession({ refresh_token });
    if (error) {
      return res.status(401).json({ error: error.message || 'Failed to refresh session' });
    }

    if (!data.session) {
      return res.status(401).json({ error: 'Session expired. Please login again.' });
    }

    return sendResponse(res, 200, {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      expires_in: data.session.expires_in,
    });
  } catch (err) {
    console.error('Error refreshing session:', err);
    return res.status(500).json({ error: 'Failed to refresh session' });
  }
});

module.exports = router;

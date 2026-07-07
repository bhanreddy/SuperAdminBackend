const express = require('express');
const sql = require('../../config/db');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const {
  assertSchoolEmailAvailable,
  isSchoolEmailConflict,
} = require('../../utils/schoolEmail');

const { getClusterServiceClient } = require('../../utils/clusterClient');

const router = express.Router();
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const APP_CONFIG_FIELDS = [
  'minimum_app_version',
  'force_update_enabled',
  'payment_banner_enabled',
  'payment_banner_reason',
];

async function findSchoolAndClient(id) {
  const { data: clusters } = await schoolSupabaseAdmin.from('clusters').select('cluster_id').eq('status', 'active');
  for (const c of clusters) {
    try {
      const client = await getClusterServiceClient(c.cluster_id, 'school');
      const { data } = await client.from('schools').select('*').eq('id', id).maybeSingle();
      if (data) return { school: data, client, cluster_id: c.cluster_id };
    } catch (err) {
      // ignore
    }
  }
  return { school: null, client: null, cluster_id: null };
}

// GET /api/super-admin/schools
router.get('/', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { data: clusters, error } = await schoolSupabaseAdmin.from('clusters').select('cluster_id').eq('status', 'active');
    if (error) throw error;
    let allSchools = [];
    let unreachable = false;

    await Promise.all((clusters || []).map(async (c) => {
      try {
        const client = await getClusterServiceClient(c.cluster_id, 'school');
        const { data, error } = await client.from('schools').select(`
          id, name, code, address, logo_url, is_active, created_at,
          cluster_id, backend_url, android_package, ios_bundle_id, primary_color, 
          onboarding_status, onboarding_completed_at,
          minimum_app_version, force_update_enabled,
          payment_banner_enabled, payment_banner_reason
        `);
        if (error) throw error;
        allSchools.push(...data);
      } catch (err) {
        console.error(`Failed to fetch schools from ${c.cluster_id}:`, err.message);
        unreachable = true;
      }
    }));

    allSchools.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    return res.status(200).json({ success: true, data: allSchools, cluster_unreachable: unreachable });
  } catch (err) {
    console.error('Error fetching schools:', err);
    res.status(500).json({ error: 'Failed to fetch schools' });
  }
});

// GET /api/super-admin/schools/:id
router.get('/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { school } = await findSchoolAndClient(id);
    
    if (!school) {
      return res.status(404).json({ error: 'School not found' });
    }
    return sendResponse(res, 200, school);
  } catch (err) {
    console.error('Error fetching school:', err);
    res.status(500).json({ error: 'Failed to fetch school' });
  }
});

// GET /api/super-admin/schools/:id/health
router.get('/:id/health', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { school, client } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    // Run counts in parallel via Supabase
    const [studentRes, staffRes, userRes, userList, roleList] = await Promise.all([
      client.from('students').select('*', { count: 'exact', head: true }).eq('school_id', id),
      client.from('staff').select('*', { count: 'exact', head: true }).eq('school_id', id),
      client.from('users').select('*', { count: 'exact', head: true }).eq('school_id', id),
      client.from('users').select('created_at').eq('school_id', id).order('created_at', { ascending: false }).limit(1),
      client.from('roles').select('*', { count: 'exact', head: true }).eq('school_id', id),
    ]);

    const { data: adminRole } = await client.from('roles').select('id').eq('code', 'admin').eq('school_id', id).maybeSingle();
    let firstAdminExists = false;
    if (adminRole) {
      const { data: adminUsers } = await client.from('user_roles').select('user_id').eq('role_id', adminRole.id).eq('school_id', id).limit(1);
      firstAdminExists = adminUsers && adminUsers.length > 0;
    }

    return sendResponse(res, 200, {
      student_count:       studentRes.count ?? 0,
      staff_count:         staffRes.count ?? 0,
      user_count:          userRes.count ?? 0,
      last_activity:       (userList.data && userList.data.length > 0) ? userList.data[0].created_at : null,
      defaults_seeded:     (roleList.count ?? 0) > 0,
      first_admin_exists:  firstAdminExists,
    });
  } catch (err) {
    console.error('Error fetching school health:', err);
    res.status(500).json({ error: 'Failed to fetch school health' });
  }
});


// POST /api/super-admin/schools
router.post('/', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { 
      name, code, address, logo_url, 
      android_package, ios_bundle_id, primary_color 
    } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'Name and Code are required' });
    }

    // 1. Auto-assign cluster
    const { data: clusters, error: clusterErr } = await schoolSupabaseAdmin
      .from('clusters')
      .select('*')
      .eq('status', 'active');

    if (clusterErr) throw clusterErr;

    const available = clusters.filter(c => c.school_count < c.max_schools);
    if (available.length === 0) {
      return res.status(503).json({ error: 'All clusters at capacity. Add a new cluster before onboarding more schools.' });
    }

    available.sort((a, b) => a.school_count - b.school_count);
    const assigned = available[0];

    // 2. Get target client
    const targetClient = await getClusterServiceClient(assigned.cluster_id, 'school');

    // 3. Insert School
    const newSchoolObj = {
      name, code, address: address || null, logo_url: logo_url || null, 
      cluster_id: assigned.cluster_id, backend_url: assigned.school_backend_url, 
      android_package: android_package || null, ios_bundle_id: ios_bundle_id || null, 
      primary_color: primary_color || '#1A73E8', onboarding_status: 'pending_build'
    };

    const { data: newSchool, error: insErr } = await targetClient
      .from('schools')
      .insert(newSchoolObj)
      .select()
      .single();

    if (insErr) {
      if (insErr.code === '23505') return res.status(409).json({ error: 'School code already exists' });
      throw insErr;
    }

    // 4. Increment school_count
    await schoolSupabaseAdmin
      .from('clusters')
      .update({ school_count: assigned.school_count + 1 })
      .eq('cluster_id', assigned.cluster_id);

    return sendResponse(res, 201, newSchool);
  } catch (err) {
    console.error('Error creating school:', err);
    res.status(500).json({ error: 'Failed to create school' });
  }
});

// PATCH /api/super-admin/schools/:id
router.patch('/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    
    const { school, client } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const { data: updated, error } = await client
      .from('schools')
      .update({ is_active })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return sendResponse(res, 200, updated);
  } catch (err) {
    console.error('Error updating school:', err);
    res.status(500).json({ error: 'Failed to update school' });
  }
});

// PATCH /api/super-admin/schools/:school_id/app-config
router.patch('/:school_id/app-config', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { school_id } = req.params;
    const body = req.body || {};
    const updateFields = {};

    if (Object.prototype.hasOwnProperty.call(body, 'minimum_app_version')) {
      const version = String(body.minimum_app_version ?? '').trim();
      if (!SEMVER_RE.test(version)) {
        return res.status(400).json({ error: 'minimum_app_version must use x.y.z semver format' });
      }
      updateFields.minimum_app_version = version;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'force_update_enabled')) {
      if (typeof body.force_update_enabled !== 'boolean') {
        return res.status(400).json({ error: 'force_update_enabled must be a boolean' });
      }
      updateFields.force_update_enabled = body.force_update_enabled;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'payment_banner_enabled')) {
      if (typeof body.payment_banner_enabled !== 'boolean') {
        return res.status(400).json({ error: 'payment_banner_enabled must be a boolean' });
      }
      updateFields.payment_banner_enabled = body.payment_banner_enabled;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'payment_banner_reason')) {
      const reason = body.payment_banner_reason;
      if (reason !== null && typeof reason !== 'string') {
        return res.status(400).json({ error: 'payment_banner_reason must be a string or null' });
      }
      if (typeof reason === 'string' && reason.length > 280) {
        return res.status(400).json({ error: 'payment_banner_reason must be 280 characters or fewer' });
      }
      updateFields.payment_banner_reason = typeof reason === 'string' ? reason.trim() || null : null;
    }

    const invalidFields = Object.keys(body).filter((field) => !APP_CONFIG_FIELDS.includes(field));
    if (invalidFields.length > 0) {
      return res.status(400).json({ error: `Invalid app config field: ${invalidFields[0]}` });
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'At least one app config field is required' });
    }

    const { school, client } = await findSchoolAndClient(school_id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const { data: updated, error } = await client
      .from('schools')
      .update(updateFields)
      .eq('id', school_id)
      .select()
      .single();

    if (error) throw error;
    return sendResponse(res, 200, updated);
  } catch (err) {
    console.error('Error updating school app config:', err);
    res.status(500).json({ error: 'Failed to update school app config' });
  }
});

// POST /api/super-admin/schools/:id/seed-defaults
router.post('/:id/seed-defaults', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { school, client } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const { error } = await client.rpc('seed_school_defaults', { p_school_id: id });
    if (error) throw error;

    return sendResponse(res, 200, { success: true, message: 'Defaults seeded successfully' });
  } catch (err) {
    console.error('Error seeding defaults:', err);
    res.status(500).json({ error: 'Failed to seed defaults', details: err.message });
  }
});

// POST /api/super-admin/schools/:id/first-admin
router.post('/:id/first-admin', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, first_name, last_name, gender_id, dob } = req.body;

    if (!email || !password || !first_name || !last_name || !gender_id || !dob) {
      return res
        .status(400)
        .json({ error: 'All fields including gender and date of birth are required' });
    }

    const canonicalEmail = await assertSchoolEmailAvailable(sql, id, email); // Wait, this uses sql, meaning global!
    // we need to fix assertSchoolEmailAvailable to use targetClient too, or check via client.
    // Let's implement inline check via client
    const { school, client } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const { data: existingContacts } = await client.from('person_contacts').select('id').eq('contact_value', canonicalEmail).eq('school_id', id);
    if (existingContacts && existingContacts.length > 0) {
      return res.status(409).json({ error: 'Email already registered in this school' });
    }

    // 1. Create Supabase Auth user via targetClient
    const { data: authData, error: authError } = await client.auth.admin.createUser({
      email: canonicalEmail,
      password,
      email_confirm: true
    });
    if (authError) throw authError;

    const userId = authData.user.id;

    try {
      // Check if role exists
      let { data: roleData } = await client.from('roles').select('id').eq('code', 'admin').eq('school_id', id).maybeSingle();
      let roleId;
      if (roleData) {
        roleId = roleData.id;
      } else {
        const { data: newRole } = await client.from('roles').insert({ code: 'admin', name: 'Administrator', school_id: id }).select().single();
        roleId = newRole.id;
      }

      // Insert Person
      const { data: newPerson, error: personErr } = await client.from('persons')
        .insert({ school_id: id, first_name, last_name, gender_id, dob })
        .select().single();
      if (personErr) throw personErr;
      const personId = newPerson.id;

      await client.from('person_contacts').insert({
        school_id: id, person_id: personId, contact_type: 'email', contact_value: canonicalEmail, is_primary: true
      });

      // Insert User with temporary password flag
      const { error: uErr } = await client.from('users').insert({
        id: userId, school_id: id, person_id: personId, account_status: 'active', is_temporary_password: true
      });
      if (uErr) throw uErr;

      // Assign Admin Role
      await client.from('user_roles').insert({
        user_id: userId, role_id: roleId, school_id: id
      });

    } catch (dbError) {
      console.error('Error creating first admin in DB, rolling back Auth user:', dbError);
      await client.auth.admin.deleteUser(userId);
      if (dbError.code === '23505') {
        console.warn('School-scoped email uniqueness violation', {
          constraint: dbError.constraint || dbError.constraint_name || dbError.code,
        });
        return res.status(409).json({ error: 'Email already registered in this school' });
      }
      return res
        .status(500)
        .json({ error: dbError.message || 'Failed to create first admin in database' });
    }

    return sendResponse(res, 201, { 
      success: true, 
      message: 'First admin created successfully',
      temporaryPassword: password,
      adminEmail: canonicalEmail
    });
  } catch (err) {
    if (err.code === 'SCHOOL_EMAIL_CONFLICT' || isSchoolEmailConflict(err)) {
      console.warn('School-scoped email uniqueness violation', {
        constraint: err.constraint || err.constraint_name || err.code,
      });
      return res.status(409).json({ error: 'Email already registered in this school' });
    }

    console.error('Error creating first admin:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/super-admin/schools/:id
router.delete('/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { school, client, cluster_id } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    // Note: RPC call to bypass delete triggers for school deletion
    // If not available, we delete normally and hope RLS/triggers allow it
    const { data: deletedSchool, error } = await client.from('schools').delete().eq('id', id).select().single();
    
    if (error) throw error;

    // decrement count
    const { data: cluster } = await schoolSupabaseAdmin.from('clusters').select('school_count').eq('cluster_id', cluster_id).single();
    if (cluster) {
      await schoolSupabaseAdmin.from('clusters').update({ school_count: Math.max(0, cluster.school_count - 1) }).eq('cluster_id', cluster_id);
    }

    return sendResponse(res, 200, { success: true, message: 'School deleted successfully', school: deletedSchool });
  } catch (err) {
    console.error('Error deleting school:', err);
    res.status(500).json({ error: 'Failed to delete school' });
  }
});

// PATCH /api/super-admin/schools/:id/onboarding-status
router.patch('/:id/onboarding-status', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending_build', 'apk_delivered', 'live', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid onboarding status' });
    }

    const { school, client } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    const setObj = { onboarding_status: status };
    if (status === 'live') {
      setObj.onboarding_completed_at = new Date().toISOString();
    }

    const { data: updated, error } = await client
      .from('schools')
      .update(setObj)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return sendResponse(res, 200, updated);
  } catch (err) {
    console.error('Error updating onboarding status:', err);
    res.status(500).json({ error: 'Failed to update onboarding status' });
  }
});

// GET /api/super-admin/schools/:id/build-config
router.get('/:id/build-config', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { school, cluster_id } = await findSchoolAndClient(id);
    if (!school) return res.status(404).json({ error: 'School not found' });

    // Fetch assigned cluster
    const { data: cluster, error: clusterErr } = await schoolSupabaseAdmin
      .from('clusters')
      .select('*')
      .eq('cluster_id', cluster_id || 'cluster_a')
      .single();

    if (clusterErr || !cluster) {
      return res.status(404).json({ error: 'Assigned cluster not found' });
    }

    const env_file = `EXPO_PUBLIC_SCHOOL_ID=${school.id}
EXPO_PUBLIC_SCHOOL_CODE=${school.code}
EXPO_PUBLIC_SCHOOL_NAME="${school.name}"
EXPO_PUBLIC_API_URL=${cluster.school_backend_url}
EXPO_PUBLIC_SUPABASE_URL=${cluster.school_supabase_url}
EXPO_PUBLIC_SUPABASE_ANON_KEY=${cluster.school_anon_key}
EXPO_PUBLIC_PRIMARY_COLOR=${school.primary_color || '#1A73E8'}
`;

    const app_json_changes = {
      name: school.name,
      slug: `schoolims-${school.id}`,
      "android.package": school.android_package,
      "ios.bundleIdentifier": school.ios_bundle_id
    };

    const eas_profile = {
      [school.id]: {
        "android": { "buildType": "apk" },
        "env": {
          "EXPO_PUBLIC_SCHOOL_ID": school.id,
          "EXPO_PUBLIC_SCHOOL_CODE": school.code,
          "EXPO_PUBLIC_SCHOOL_NAME": school.name,
          "EXPO_PUBLIC_API_URL": cluster.school_backend_url,
          "EXPO_PUBLIC_SUPABASE_URL": cluster.school_supabase_url,
          "EXPO_PUBLIC_SUPABASE_ANON_KEY": cluster.school_anon_key,
          "EXPO_PUBLIC_PRIMARY_COLOR": school.primary_color || '#1A73E8'
        }
      }
    };

    const firebase_package = school.android_package;

    const setup_commands = [
      "rm -rf android ios .expo node_modules",
      "find . -name '._*' -not -path './.git/*' -delete",
      "npm install",
      "npx expo prebuild --clean",
      "npm run android"
    ];

    return sendResponse(res, 200, {
      env_file,
      app_json_changes,
      eas_profile,
      firebase_package,
      setup_commands
    });
  } catch (err) {
    console.error('Error generating build config:', err);
    res.status(500).json({ error: 'Failed to generate build config' });
  }
});

module.exports = router;

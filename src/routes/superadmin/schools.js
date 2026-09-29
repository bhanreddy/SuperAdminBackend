const express = require('express');
const sql = require('../../config/db');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requirePermission, requireAnyPermission, requireSchoolAccess } = require('../../middleware/rbac');
const { PERMISSIONS, ROLES } = require('../../config/rbac');
const {
  assertSchoolEmailAvailable,
  isSchoolEmailConflict,
} = require('../../utils/schoolEmail');

const { getClusterServiceClient } = require('../../utils/clusterClient');
const { interpretSchoolMatches } = require('../../services/schoolLocator');
const { purgeSchool } = require('../../utils/purgeSchool');
const { logAudit } = require('../../services/auditLogger');
const { seedDraftFromSchool } = require('../../services/schoolConfiguration');
const { buildConfigFromDraft } = require('./schoolConfiguration');

const router = express.Router();
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const APP_CONFIG_FIELDS = [
  'minimum_app_version',
  'force_update_enabled',
  'payment_banner_enabled',
  'payment_banner_reason',
];

async function findSchoolAndClient(id, clusterId) {
  if (clusterId) {
    try {
      const client = await getClusterServiceClient(clusterId, 'school');
      const { data } = await client.from('schools').select('*').eq('id', id).maybeSingle();
      if (!data) return { school: null, client: null, cluster_id: null };
      return { school: data, client, cluster_id: clusterId };
    } catch (err) {
      return { school: null, client: null, cluster_id: null };
    }
  }
  const { data: clusters } = await schoolSupabaseAdmin.from('clusters').select('cluster_id').eq('status', 'active');
  const matches = [];
  for (const c of clusters || []) {
    try {
      const client = await getClusterServiceClient(c.cluster_id, 'school');
      const { data } = await client.from('schools').select('*').eq('id', id).maybeSingle();
      if (data) matches.push({ school: data, client, cluster_id: c.cluster_id });
    } catch (err) {
      // ignore unreachable clusters
    }
  }
  const decision = interpretSchoolMatches(matches);
  if (decision.status === 409) return { ambiguous: true, error: decision.error };
  if (decision.status !== 200) return { school: null, client: null, cluster_id: null };
  return decision.match;
}

function sendIfAmbiguous(res, located) {
  if (located && located.ambiguous) {
    res.status(409).json({
      error: located.error || 'School id matches more than one cluster. Pass cluster_id.',
      code: 'AMBIGUOUS_SCHOOL',
    });
    return true;
  }
  return false;
}

// GET /api/super-admin/schools
// Returns all schools for Founders/SchoolsReadAll; filters to assigned schools for executives
router.get('/', authenticateUser, requireAnyPermission(PERMISSIONS.SCHOOLS_READ_ASSIGNED, PERMISSIONS.SCHOOLS_READ_ALL), async (req, res) => {
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

    // Fallback: If clusters didn't return schools, load from local database schools table
    if (allSchools.length === 0) {
      try {
        const localSchools = await sql`
          SELECT id, name, code, address, contact_name, contact_phone, contact_email, contact_designation, is_active, created_at
          FROM schools
        `;
        allSchools.push(...localSchools);
      } catch (e) {
        // ignore
      }
    }

    // RBAC: If not Founder or doesn't have schools.read.all, filter to assigned schools only
    const isUnrestricted = req.user?.isFounder || req.user?.permissions?.includes(PERMISSIONS.SCHOOLS_READ_ALL);
    if (!isUnrestricted) {
      const assigned = req.user?.assignedSchoolIds || [];
      allSchools = allSchools.filter((s) => assigned.includes(s.id));
    }

    allSchools.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    return res.status(200).json({ success: true, data: allSchools, cluster_unreachable: unreachable });
  } catch (err) {
    console.error('Error fetching schools:', err);
    res.status(500).json({ error: 'Failed to fetch schools' });
  }
});

// GET /api/super-admin/schools/:id
// Protected by requireSchoolAccess: non-assigned users rejected with 403
router.get('/:id', authenticateUser, requireAnyPermission(PERMISSIONS.SCHOOLS_READ_ASSIGNED, PERMISSIONS.SCHOOLS_READ_ALL), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (located.ambiguous) return res.status(409).json({ error: located.error, code: 'AMBIGUOUS_SCHOOL' });
    let { school } = located;
    
    if (!school) {
      try {
        const [localSchool] = await sql`SELECT * FROM schools WHERE id = ${id} LIMIT 1`;
        if (localSchool) school = localSchool;
      } catch (e) {
        // ignore
      }
    }

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
router.get('/:id/health', authenticateUser, requireAnyPermission(PERMISSIONS.SCHOOLS_READ_ASSIGNED, PERMISSIONS.SCHOOLS_READ_ALL), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;

    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, client } = located;
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
// Requires schools.create permission (Founders, Sales Managers, Sales Executives)
router.post('/', authenticateUser, requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    if (req.user?.role === ROLES.SALES_EXECUTIVE) {
      return res.status(403).json({
        error: 'Sales executives submit a school dossier for founder review. The school is created only after the tech lead approves it.',
        code: 'INTAKE_REQUIRED',
      });
    }

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
    const reserved = await sql`
      UPDATE clusters
      SET school_count = school_count + 1, updated_at = now()
      WHERE cluster_id = ${assigned.cluster_id}
        AND status = 'active'
        AND school_count < max_schools
      RETURNING cluster_id
    `;
    if (!reserved.length) {
      return res.status(503).json({ error: 'All clusters at capacity. Add a new cluster before onboarding more schools.' });
    }
    const releaseReservation = () => sql`
      UPDATE clusters
      SET school_count = GREATEST(school_count - 1, 0), updated_at = now()
      WHERE cluster_id = ${assigned.cluster_id}
    `;

    // 2. Get target client
    let targetClient;
    try {
      targetClient = await getClusterServiceClient(assigned.cluster_id, 'school');
    } catch (err) {
      await releaseReservation();
      throw err;
    }

    // 3. Insert School
    const newSchoolObj = {
      name, code, address: address || null, logo_url: logo_url || null, 
      cluster_id: assigned.cluster_id, backend_url: assigned.school_backend_url, 
      android_package: android_package || null, ios_bundle_id: ios_bundle_id || null, 
      primary_color: primary_color || '#1A73E8', onboarding_status: 'pending_build'
    };

    let newSchool;
    let insErr;
    try {
      const inserted = await targetClient
        .from('schools')
        .insert(newSchoolObj)
        .select()
        .single();
      newSchool = inserted.data;
      insErr = inserted.error;
    } catch (err) {
      await releaseReservation();
      throw err;
    }

    if (insErr) {
      await releaseReservation();
      if (insErr.code === '23505') return res.status(409).json({ error: 'School code already exists' });
      throw insErr;
    }

    // 4. Increment school_count in clusters table
    await schoolSupabaseAdmin
      .from('clusters')
      .update({ school_count: assigned.school_count + 1 })
      .eq('cluster_id', assigned.cluster_id);

    // 5. Automatically assign this newly created school to the creator if creator is an executive
    if (req.user && !req.user.isFounder) {
      await sql`
        INSERT INTO internal_user_schools (user_id, school_id, assigned_by)
        VALUES (${req.user.id}, ${newSchool.id}, ${req.user.id})
        ON CONFLICT DO NOTHING
      `;
    }

    await seedDraftFromSchool(sql, {
      clusterId: assigned.cluster_id,
      school: newSchool,
      userId: req.user?.id || null,
      origin: 'created',
    }).catch((seedErr) => console.error('[schools] configuration seed failed:', seedErr.message));

    return sendResponse(res, 201, newSchool);
  } catch (err) {
    console.error('Error creating school:', err);
    res.status(500).json({ error: 'Failed to create school' });
  }
});

// PATCH /api/super-admin/schools/:id
// Requires schools.update.assigned + school access
router.patch('/:id', authenticateUser, requireAnyPermission(PERMISSIONS.SCHOOLS_UPDATE_ASSIGNED, PERMISSIONS.SCHOOLS_UPDATE_ALL), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, contact_name, contact_phone, contact_email, contact_designation, address } = req.body;
    
    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    let { school, client } = located;

    if (!school) {
      try {
        const [localSchool] = await sql`SELECT * FROM schools WHERE id = ${id} LIMIT 1`;
        if (localSchool) school = localSchool;
      } catch (e) {
        // ignore
      }
    }

    if (!school) return res.status(404).json({ error: 'School not found' });

    const updatePayload = {};
    if (is_active !== undefined) updatePayload.is_active = Boolean(is_active);
    if (contact_name !== undefined) updatePayload.contact_name = contact_name ? String(contact_name).trim() : null;
    if (contact_phone !== undefined) updatePayload.contact_phone = contact_phone ? String(contact_phone).trim() : null;
    if (contact_email !== undefined) {
      if (contact_email && !String(contact_email).includes('@')) {
        return res.status(400).json({ error: 'Invalid contact email' });
      }
      updatePayload.contact_email = contact_email ? String(contact_email).trim().toLowerCase() : null;
    }
    if (contact_designation !== undefined) updatePayload.contact_designation = contact_designation ? String(contact_designation).trim() : null;
    if (address !== undefined) updatePayload.address = address ? String(address).trim() : null;

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'No valid update fields provided' });
    }

    let updatedSchool = { ...school, ...updatePayload };

    // Update in Supabase cluster if client is available
    if (client) {
      try {
        const { data: updated, error } = await client
          .from('schools')
          .update(updatePayload)
          .eq('id', id)
          .select()
          .single();
        if (!error && updated) {
          updatedSchool = updated;
        }
      } catch (err) {
        console.warn('[schools.patch] Cluster update notice:', err.message);
      }
    }

    // Also update in local database schools table
    try {
      const [updatedLocal] = await sql`
        UPDATE schools
        SET
          is_active = COALESCE(${updatePayload.is_active !== undefined ? updatePayload.is_active : null}, is_active),
          contact_name = COALESCE(${updatePayload.contact_name !== undefined ? updatePayload.contact_name : null}, contact_name),
          contact_phone = COALESCE(${updatePayload.contact_phone !== undefined ? updatePayload.contact_phone : null}, contact_phone),
          contact_email = COALESCE(${updatePayload.contact_email !== undefined ? updatePayload.contact_email : null}, contact_email),
          contact_designation = COALESCE(${updatePayload.contact_designation !== undefined ? updatePayload.contact_designation : null}, contact_designation),
          address = COALESCE(${updatePayload.address !== undefined ? updatePayload.address : null}, address)
        WHERE id = ${id}
        RETURNING *
      `;
      if (updatedLocal) {
        updatedSchool = { ...updatedSchool, ...updatedLocal };
      }
    } catch (err) {
      console.warn('[schools.patch] Local DB update notice:', err.message);
    }

    // Audit log Workflow A: School contact details updated
    await logAudit({
      userId: req.user.id,
      action: 'SCHOOL_CONTACTS_UPDATED',
      entity: 'SCHOOL',
      entityId: String(id),
      details: {
        actorEmployeeId: req.user.employeeId,
        actorRole: req.user.role,
        previous: {
          is_active: school.is_active,
          contact_name: school.contact_name,
          contact_phone: school.contact_phone,
          contact_email: school.contact_email,
          contact_designation: school.contact_designation,
          address: school.address,
        },
        updates: updatePayload,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendResponse(res, 200, updatedSchool);
  } catch (err) {
    console.error('Error updating school:', err);
    res.status(500).json({ error: 'Failed to update school' });
  }
});

// PATCH /api/super-admin/schools/:school_id/app-config
// Requires configs.modify + school access
router.patch('/:school_id/app-config', authenticateUser, requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('school_id'), async (req, res) => {
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

    const located = await findSchoolAndClient(school_id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, client } = located;
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
router.post('/:id/seed-defaults', authenticateUser, requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;

    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, client } = located;
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
router.post('/:id/first-admin', authenticateUser, requirePermission(PERMISSIONS.CONFIGS_MODIFY), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, first_name, last_name, gender_id, dob } = req.body;

    if (!email || !password || !first_name || !last_name || !gender_id || !dob) {
      return res
        .status(400)
        .json({ error: 'All fields including gender and date of birth are required' });
    }

    const canonicalEmail = await assertSchoolEmailAvailable(sql, id, email);
    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, client } = located;
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

      // Manage Staff lists from the `staff` table — seed a staff row so the first
      // admin is visible in the school app (person + user alone is not enough).
      let { data: designation } = await client
        .from('staff_designations')
        .select('id')
        .eq('school_id', id)
        .eq('name', 'Administrator')
        .maybeSingle();

      if (!designation) {
        const { data: createdDesignation, error: designationErr } = await client
          .from('staff_designations')
          .insert({ school_id: id, name: 'Administrator' })
          .select('id')
          .single();
        if (designationErr) {
          // Race / unique conflict: re-read, or fall back to Principal/Other.
          const { data: existingAdminDesig } = await client
            .from('staff_designations')
            .select('id')
            .eq('school_id', id)
            .eq('name', 'Administrator')
            .maybeSingle();
          if (existingAdminDesig) {
            designation = existingAdminDesig;
          } else {
            const { data: fallbackDesig } = await client
              .from('staff_designations')
              .select('id')
              .eq('school_id', id)
              .in('name', ['Principal', 'Other'])
              .limit(1)
              .maybeSingle();
            designation = fallbackDesig || null;
            if (!designation) throw designationErr;
          }
        } else {
          designation = createdDesignation;
        }
      }

      const staffCode = `ADM-${String(personId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const joiningDate = new Date().toISOString().slice(0, 10);
      const { error: staffErr } = await client.from('staff').insert({
        school_id: id,
        person_id: personId,
        staff_code: staffCode,
        joining_date: joiningDate,
        status_id: 1,
        designation_id: designation.id,
      });
      if (staffErr) throw staffErr;

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
      return res.status(409).json({ error: 'Email already registered in this school' });
    }
    console.error('Error creating first admin:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/super-admin/schools/:id
// Requires schools.delete permission (Founders only)
router.delete('/:id', authenticateUser, requirePermission(PERMISSIONS.SCHOOLS_DELETE), async (req, res) => {
  try {
    const schoolId = Number(req.params.id);
    if (!Number.isInteger(schoolId) || schoolId <= 0) {
      return res.status(400).json({ error: 'Invalid school id' });
    }

    const located = await findSchoolAndClient(schoolId, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, cluster_id } = located;
    if (!school) return res.status(404).json({ error: 'School not found' });

    const deletedSchool = await purgeSchool(sql, schoolId);
    if (!deletedSchool) {
      return res.status(404).json({ error: 'School not found' });
    }

    if (cluster_id) {
      const { data: cluster } = await schoolSupabaseAdmin
        .from('clusters')
        .select('school_count')
        .eq('cluster_id', cluster_id)
        .single();
      if (cluster) {
        await schoolSupabaseAdmin
          .from('clusters')
          .update({ school_count: Math.max(0, (cluster.school_count || 0) - 1) })
          .eq('cluster_id', cluster_id);
      }
    }

    return sendResponse(res, 200, {
      success: true,
      message: 'School deleted successfully',
      school: deletedSchool,
    });
  } catch (err) {
    console.error('Error deleting school:', err);
    res.status(500).json({
      error: err?.message || 'Failed to delete school',
    });
  }
});

// PATCH /api/super-admin/schools/:id/onboarding-status
router.patch('/:id/onboarding-status', authenticateUser, requireAnyPermission(PERMISSIONS.SCHOOLS_UPDATE_ASSIGNED, PERMISSIONS.SCHOOLS_UPDATE_ALL), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending_build', 'apk_delivered', 'live', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid onboarding status' });
    }

    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, client } = located;
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
router.get('/:id/build-config', authenticateUser, requirePermission(PERMISSIONS.BUILDS_READ), requireSchoolAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const located = await findSchoolAndClient(id, req.query.cluster_id);
    if (sendIfAmbiguous(res, located)) return;
    const { school, cluster_id } = located;
    if (!school) return res.status(404).json({ error: 'School not found' });
    const resolvedCluster = cluster_id || school.cluster_id;
    if (!resolvedCluster) {
      return res.status(409).json({ error: 'School has no cluster reference', code: 'CLUSTER_REQUIRED' });
    }

    // Fetch assigned cluster
    const { data: cluster, error: clusterErr } = await schoolSupabaseAdmin
      .from('clusters')
      .select('*')
      .eq('cluster_id', resolvedCluster)
      .single();

    if (clusterErr || !cluster) {
      return res.status(404).json({ error: 'Assigned cluster not found' });
    }

    const fromDraft = await buildConfigFromDraft(school, resolvedCluster);
    if (fromDraft) return sendResponse(res, 200, fromDraft);

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

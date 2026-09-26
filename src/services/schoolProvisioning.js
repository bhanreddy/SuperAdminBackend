const { normalizeEmail } = require('../utils/schoolEmail');

async function readSchoolReadiness(client, schoolId) {
  const { data: school, error } = await client
    .from('schools')
    .select('id, onboarding_status')
    .eq('id', schoolId)
    .maybeSingle();
  if (error) throw error;
  if (!school) return null;
  const roleList = await client.from('roles').select('*', { count: 'exact', head: true }).eq('school_id', schoolId);
  const { data: adminRole } = await client
    .from('roles')
    .select('id')
    .eq('code', 'admin')
    .eq('school_id', schoolId)
    .maybeSingle();
  let firstAdminExists = false;
  if (adminRole) {
    const { data: adminUsers } = await client
      .from('user_roles')
      .select('user_id')
      .eq('role_id', adminRole.id)
      .eq('school_id', schoolId)
      .limit(1);
    firstAdminExists = Boolean(adminUsers && adminUsers.length);
  }
  return {
    onboarding_status: school.onboarding_status,
    defaults_seeded: (roleList.count ?? 0) > 0,
    first_admin_exists: firstAdminExists,
  };
}

async function provisionFirstAdmin(client, schoolId, admin) {
  const email = normalizeEmail(admin?.email);
  const password = admin?.password;
  const firstName = String(admin?.first_name || '').trim();
  const lastName = String(admin?.last_name || '').trim();
  const genderId = admin?.gender_id;
  const dob = admin?.dob;
  if (!email || !password || !firstName || !lastName || !genderId || !dob) {
    return { ok: false, error: 'First admin needs email, password, name, gender, and date of birth' };
  }
  const { data: existingContacts } = await client
    .from('person_contacts')
    .select('id')
    .eq('contact_value', email)
    .eq('school_id', schoolId);
  if (existingContacts && existingContacts.length > 0) {
    return { ok: false, error: 'Email already registered in this school' };
  }
  const { data: authData, error: authError } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError) return { ok: false, error: 'First admin could not be provisioned' };
  const userId = authData.user.id;
  try {
    let { data: roleData } = await client.from('roles').select('id').eq('code', 'admin').eq('school_id', schoolId).maybeSingle();
    let roleId = roleData?.id;
    if (!roleId) {
      const { data: newRole, error: roleErr } = await client
        .from('roles')
        .insert({ code: 'admin', name: 'Administrator', school_id: schoolId })
        .select('id')
        .single();
      if (roleErr) throw roleErr;
      roleId = newRole.id;
    }
    const { data: newPerson, error: personErr } = await client
      .from('persons')
      .insert({ school_id: schoolId, first_name: firstName, last_name: lastName, gender_id: genderId, dob })
      .select('id')
      .single();
    if (personErr) throw personErr;
    const { error: contactErr } = await client.from('person_contacts').insert({
      school_id: schoolId,
      person_id: newPerson.id,
      contact_type: 'email',
      contact_value: email,
      is_primary: true,
    });
    if (contactErr) throw contactErr;
    let { data: designation } = await client
      .from('staff_designations')
      .select('id')
      .eq('school_id', schoolId)
      .eq('name', 'Administrator')
      .maybeSingle();
    if (!designation) {
      const { data: createdDesignation, error: designationErr } = await client
        .from('staff_designations')
        .insert({ school_id: schoolId, name: 'Administrator' })
        .select('id')
        .single();
      if (designationErr) throw designationErr;
      designation = createdDesignation;
    }
    const staffCode = `ADM-${String(newPerson.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const { error: staffErr } = await client.from('staff').insert({
      school_id: schoolId,
      person_id: newPerson.id,
      staff_code: staffCode,
      joining_date: new Date().toISOString().slice(0, 10),
      status_id: 1,
      designation_id: designation.id,
    });
    if (staffErr) throw staffErr;
    const { error: userErr } = await client.from('users').insert({
      id: userId,
      school_id: schoolId,
      person_id: newPerson.id,
      account_status: 'active',
      is_temporary_password: true,
    });
    if (userErr) throw userErr;
    const { error: roleAssignErr } = await client.from('user_roles').insert({
      user_id: userId,
      role_id: roleId,
      school_id: schoolId,
    });
    if (roleAssignErr) throw roleAssignErr;
    return { ok: true, school_id: schoolId };
  } catch (err) {
    await client.auth.admin.deleteUser(userId);
    return { ok: false, error: 'First admin could not be linked to the school. The school was left in place.' };
  }
}

module.exports = { readSchoolReadiness, provisionFirstAdmin };

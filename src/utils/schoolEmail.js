function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isSchoolEmailConflict(error) {
  const constraintName = error?.constraint || error?.constraint_name;
  return (
    error?.code === '23505' &&
    [
      'person_contacts_school_email_unique',
      'users_school_email_unique',
      'parents_school_email_unique',
      'staff_school_email_unique',
    ].includes(constraintName)
  );
}

async function assertSchoolEmailAvailable(sql, schoolId, email, excludePersonId = null) {
  const normalized = normalizeEmail(email);
  if (!normalized) return normalized;

  const rows = excludePersonId
    ? await sql`
        SELECT id
        FROM person_contacts
        WHERE school_id = ${schoolId}
          AND contact_type = 'email'
          AND lower(contact_value) = ${normalized}
          AND person_id <> ${excludePersonId}
          AND deleted_at IS NULL
        LIMIT 1
      `
    : await sql`
        SELECT id
        FROM person_contacts
        WHERE school_id = ${schoolId}
          AND contact_type = 'email'
          AND lower(contact_value) = ${normalized}
          AND deleted_at IS NULL
        LIMIT 1
      `;

  if (rows.length > 0) {
    const err = new Error('Email already registered in this school');
    err.code = 'SCHOOL_EMAIL_CONFLICT';
    err.constraint = 'person_contacts_school_email_unique';
    throw err;
  }

  return normalized;
}

module.exports = {
  assertSchoolEmailAvailable,
  isSchoolEmailConflict,
  normalizeEmail,
};

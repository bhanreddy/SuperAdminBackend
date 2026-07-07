const PEN_MAX_LENGTH = 30;
const PEN_FORMAT = /^[A-Za-z0-9]+$/;

function normalizePenNumber(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  return trimmed.toUpperCase();
}

function validatePenNumber(pen, { required = false } = {}) {
  const normalized = normalizePenNumber(pen);

  if (normalized == null) {
    if (required) {
      return { ok: false, error: 'PEN Number is required.' };
    }
    return { ok: true, value: null };
  }

  if (normalized.length > PEN_MAX_LENGTH) {
    return {
      ok: false,
      error: `PEN Number must be at most ${PEN_MAX_LENGTH} characters.`,
    };
  }

  if (!PEN_FORMAT.test(normalized)) {
    return {
      ok: false,
      error: 'PEN Number must contain only letters and numbers.',
    };
  }

  return { ok: true, value: normalized };
}

async function assertPenNumberAvailable(
  sql,
  schoolId,
  pen,
  { excludeStudentId = null } = {},
) {
  const validation = validatePenNumber(pen);
  if (!validation.ok) {
    const err = new Error(validation.error);
    err.code = 'PEN_VALIDATION';
    throw err;
  }

  const normalized = validation.value;
  if (normalized == null) return null;

  const [existing] = excludeStudentId
    ? await sql`
        SELECT id FROM students
        WHERE pen_number = ${normalized}
          AND school_id = ${schoolId}
          AND id <> ${excludeStudentId}
          AND deleted_at IS NULL
        LIMIT 1
      `
    : await sql`
        SELECT id FROM students
        WHERE pen_number = ${normalized}
          AND school_id = ${schoolId}
          AND deleted_at IS NULL
        LIMIT 1
      `;

  if (existing) {
    const err = new Error(`PEN Number '${normalized}' already exists.`);
    err.code = 'PEN_CONFLICT';
    throw err;
  }

  return normalized;
}

function isPenConflict(error) {
  const constraintName = error?.constraint || error?.constraint_name;
  return error?.code === '23505' && constraintName === 'idx_students_pen_active';
}

module.exports = {
  normalizePenNumber,
  validatePenNumber,
  assertPenNumberAvailable,
  isPenConflict,
};

const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { assertSchoolEmailAvailable } = require('../../utils/schoolEmail');
const { validatePenNumber, assertPenNumberAvailable, isPenConflict } = require('../../utils/studentPen');
const { getClusterServiceClient } = require('../../utils/clusterClient');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

// ── Robust Excel date parser ────────────────────────────────────────────────
// Handles: Excel serial numbers, Date objects, and string formats
// (YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, M/D/YYYY, M/D/YY, etc.)
function parseExcelDate(value) {
  if (value == null || value === '') return null;

  // 1. Excel serial number (e.g. 45444)
  if (typeof value === 'number') {
    const d = new Date((value - (25567 + 2)) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    return null;
  }

  // 2. Already a Date object
  if (value instanceof Date) {
    if (!isNaN(value.getTime())) return value.toISOString().split('T')[0];
    return null;
  }

  // 3. String parsing
  const str = String(value).trim();

  // 3a. Already YYYY-MM-DD (ISO format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(str + 'T00:00:00');
    if (!isNaN(d.getTime())) return str;
  }

  // 3b. DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const [, dd, mm, yyyy] = dmyMatch;
    const isoStr = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const d = new Date(isoStr + 'T00:00:00');
    if (!isNaN(d.getTime())) return isoStr;
  }

  // 3c. M/D/YY (short year)
  const mdyyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (mdyyMatch) {
    const [, mm, dd, yy] = mdyyMatch;
    const fullYear = parseInt(yy) > 50 ? '19' + yy : '20' + yy;
    const isoStr = `${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const d = new Date(isoStr + 'T00:00:00');
    if (!isNaN(d.getTime())) return isoStr;
  }

  // 3d. Fallback: try native Date constructor
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) return fallback.toISOString().split('T')[0];

  return null;
}

function normalizeLookupValue(value) {
  return String(value || '').trim().toLowerCase();
}

function addLookupKey(map, value, id) {
  const key = normalizeLookupValue(value);
  if (key) map[key] = id;
}

function normalizeAcademicYearCode(value) {
  const raw = String(value || '').trim();
  const longCode = raw.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (longCode) return `${longCode[1]}-${longCode[2]}`;

  const shortCode = raw.match(/^(\d{4})\s*[-/]\s*(\d{2})$/);
  if (!shortCode) return raw;

  const startYear = Number(shortCode[1]);
  const shortEndYear = Number(shortCode[2]);
  let endYear = Math.floor(startYear / 100) * 100 + shortEndYear;
  if (endYear <= startYear) endYear += 100;
  return `${startYear}-${endYear}`;
}

function formatLookupOptions(rows) {
  const values = rows
    .flatMap((row) => [row.name, row.code].filter(Boolean))
    .map((value) => String(value).trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, 12).join(', ');
}

function formatAcademicYearOptions(rows) {
  return [...new Set(rows.map((row) => row.code).filter(Boolean))].slice(0, 12).join(', ');
}

function notFoundMessage(label, value, schoolId, available) {
  const pluralLabels = {
    Class: 'classes',
    Section: 'sections',
    'Academic Year': 'academic years',
  };
  const plural = pluralLabels[label] || `${label.toLowerCase()}s`;
  return `${label} '${value}' not found for school ${schoolId}${available ? `. Available ${plural}: ${available}` : ''}`;
}

async function getSchoolAuthAdminClient(schoolId) {
  const [school] = await sql`SELECT * FROM schools WHERE id = ${schoolId}`;
  if (!school) {
    const err = new Error(`School '${schoolId}' not found`);
    err.statusCode = 404;
    throw err;
  }

  if (!school.cluster_id) return schoolSupabaseAdmin;

  return getClusterServiceClient(school.cluster_id, 'school');
}

// POST /api/super-admin/schools/:id/students/import
router.post(
  '/schools/:id/students/import',
  verifySuperAdminMiddleware,
  upload.single('file'),
  async (req, res) => {
    try {
      const { id: schoolId } = req.params;
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

      if (!data || data.length === 0) {
        return res.status(400).json({ error: 'Empty excel file' });
      }

      const classes = await sql`SELECT id, name, code FROM classes WHERE school_id = ${schoolId}`;
      const sections = await sql`SELECT id, name, code FROM sections WHERE school_id = ${schoolId}`;
      const academicYears = await sql`SELECT id, code, start_date, end_date FROM academic_years WHERE school_id = ${schoolId}`;
      const activeStatuses = await sql`SELECT id, code FROM student_statuses`;
      const authAdmin = await getSchoolAuthAdminClient(schoolId);

      const classMap = {};
      classes.forEach((c) => {
        addLookupKey(classMap, c.name, c.id);
        addLookupKey(classMap, c.code, c.id);
      });
      const sectionMap = {};
      sections.forEach((s) => {
        addLookupKey(sectionMap, s.name, s.id);
        addLookupKey(sectionMap, s.code, s.id);
      });
      const genderMap = { male: 1, female: 2, other: 3 };
      const statusMap = Object.fromEntries(
        activeStatuses.map((s) => [s.code.toLowerCase(), s.id]),
      );
      const academicYearMap = {};
      academicYears.forEach((ay) => {
        addLookupKey(academicYearMap, ay.code, ay);
        addLookupKey(academicYearMap, normalizeAcademicYearCode(ay.code), ay);
      });
      const availableClasses = formatLookupOptions(classes);
      const availableSections = formatLookupOptions(sections);
      const availableAcademicYears = formatAcademicYearOptions(academicYears);

      // ── New reference maps (matching accounts add student form constants) ──
      const categoryMap = { general: 1, obc: 2, 'sc/st': 3, 'sc': 3, 'st': 3 };
      const religionMap = { hindu: 1, muslim: 2, christian: 3, sikh: 4, other: 5 };
      const bloodGroupMap = {
        'a+': 1, 'a-': 2, 'b+': 3, 'b-': 4,
        'ab+': 5, 'ab-': 6, 'o+': 7, 'o-': 8,
      };

      // ── Fetch the student role for this school (for login creation) ──
      const [studentRole] = await sql`SELECT id FROM roles WHERE code = 'student' AND school_id = ${schoolId}`;
      if (!studentRole) {
        return res.status(400).json({
          error: "Student role is not configured for this school. Seed school defaults before importing students.",
        });
      }

      let successCount = 0;
      let credentialsCreated = 0;
      let errors = [];

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowNum = i + 2;

        try {
          const firstName = row['First Name'];
          const lastNameRaw = row['Last Name'] ?? row['Last Name (optional)'];
          const lastName = lastNameRaw != null ? String(lastNameRaw).trim() || null : null;
          const admissionNo = row['Admission Number'];
          const penRaw = row['PEN Number'];
          const aparRaw = row['APAR Number'];
          const hasPenInRow = penRaw != null && String(penRaw).trim() !== '';
          const aparNumber = (aparRaw != null && String(aparRaw).trim() !== '') ? String(aparRaw).trim() : null;
          let admissionDate = row['Admission Date'];
          const className = row['Class']?.toString().trim();
          const sectionName = row['Section']?.toString().trim();
          const gender = normalizeLookupValue(row['Gender']);
          let dob = row['Date of Birth'];
          const email = row['Email'];
          const phone = row['Phone'];
          const academicYearCode = row['Academic Year']?.toString().trim();

          // ── Coerce password to string early ──
          // xlsx parses purely-numeric passwords (e.g. 123456) as JavaScript
          // numbers. We must convert before any truthy check, otherwise a
          // password of numeric `0` would be treated as "no password".
          let passwordStr = row['Password'] != null ? String(row['Password']).trim() : '';

          // ── New optional fields ──
          const categoryStr = normalizeLookupValue(row['Category']);
          const religionStr = normalizeLookupValue(row['Religion']);
          const bloodGroupStr = normalizeLookupValue(row['Blood Group']);

          // ── Skip completely empty rows ──
          const isEmptyRow = Object.values(row).every(
            (val) => val == null || String(val).trim() === '',
          );
          if (isEmptyRow) {
            continue;
          }

          const missingFields = [];
          if (firstName == null || String(firstName).trim() === '') missingFields.push('First Name');
          if (admissionNo == null || String(admissionNo).trim() === '') missingFields.push('Admission Number');
          if (admissionDate == null || String(admissionDate).trim() === '') missingFields.push('Admission Date');
          if (className == null || String(className).trim() === '') missingFields.push('Class');
          if (sectionName == null || String(sectionName).trim() === '') missingFields.push('Section');
          if (gender == null || String(gender).trim() === '') missingFields.push('Gender');
          if (academicYearCode == null || String(academicYearCode).trim() === '') missingFields.push('Academic Year');

          if (missingFields.length > 0) {
            errors.push(`Row ${rowNum}: Missing mandatory fields: ${missingFields.join(', ')}`);
            continue;
          }

          // ── Parse dates robustly (handles serial numbers, Date objects, various string formats) ──
          admissionDate = parseExcelDate(admissionDate);
          dob = parseExcelDate(dob);

          if (!admissionDate) {
            errors.push(`Row ${rowNum}: Invalid or missing Admission Date`);
            continue;
          }

          const genderId = genderMap[gender] || 3;
          const classId = classMap[normalizeLookupValue(className)];
          const sectionId = sectionMap[normalizeLookupValue(sectionName)];
          const statusId = statusMap[normalizeLookupValue(row['Status'])] || 1;

          // ── Resolve new reference IDs (default to 1 if not provided or not found) ──
          const categoryId = categoryStr ? (categoryMap[categoryStr] || 1) : 1;
          const religionId = religionStr ? (religionMap[religionStr] || 1) : 1;
          const bloodGroupId = bloodGroupStr ? (bloodGroupMap[bloodGroupStr] || 1) : 1;

          const academicYear = academicYearMap[normalizeLookupValue(normalizeAcademicYearCode(academicYearCode))];

          if (!classId) {
            errors.push(`Row ${rowNum}: ${notFoundMessage('Class', className, schoolId, availableClasses)}`);
            continue;
          }
          if (!sectionId) {
            errors.push(`Row ${rowNum}: ${notFoundMessage('Section', sectionName, schoolId, availableSections)}`);
            continue;
          }
          if (!academicYear) {
            errors.push(`Row ${rowNum}: ${notFoundMessage('Academic Year', academicYearCode, schoolId, availableAcademicYears)}`);
            continue;
          }

          const [existingAdm] = await sql`SELECT id FROM students WHERE admission_no = ${admissionNo.toString()} AND school_id = ${schoolId} AND deleted_at IS NULL`;
          if (existingAdm) {
            errors.push(`Row ${rowNum}: Admission Number '${admissionNo}' already exists`);
            continue;
          }

          let normalizedPenNumber = null;
          if (hasPenInRow) {
            const penValidation = validatePenNumber(penRaw);
            if (!penValidation.ok) {
              errors.push(`Row ${rowNum}: ${penValidation.error}`);
              continue;
            }

            if (penValidation.value) {
              try {
                normalizedPenNumber = await assertPenNumberAvailable(sql, schoolId, penValidation.value);
              } catch (penErr) {
                errors.push(`Row ${rowNum}: ${penErr.message}`);
                continue;
              }
            }
          }

          // ── Resolve email/password from Excel.
          // Mirrors the test app add-student path: the entered email is the
          // Login ID, so imported students must receive that same auth email.
          let canonicalEmail = null;
          const rawEmail = email ? email.toString().trim() : '';
          if (!rawEmail || !passwordStr) {
            errors.push(`Row ${rowNum}: Email and Password are required to create student login credentials`);
            continue;
          }

          try {
            canonicalEmail = await assertSchoolEmailAvailable(sql, schoolId, rawEmail);
          } catch (emailErr) {
            errors.push(`Row ${rowNum}: Email '${rawEmail}' already registered in this school`);
            continue;
          }

          // ── Validate password length (Supabase requires >= 6 characters) ──
          if (passwordStr.length < 6) {
            errors.push(`Row ${rowNum}: Password must be at least 6 characters long`);
            continue;
          }

          let rowCredentialsCreated = false;

          await sql.begin(async (tx) => {
            // 1. Create Person
            const [person] = await tx`
              INSERT INTO persons (school_id, first_name, middle_name, last_name, dob, gender_id, display_name)
              VALUES (${schoolId}, ${firstName}, ${row['Middle Name'] || null}, ${lastName}, ${dob || null}, ${genderId}, ${lastName ? `${firstName} ${lastName}` : firstName})
              RETURNING id
            `;

            // 2. Create Student (with category_id, religion_id, blood_group_id)
            const [student] = normalizedPenNumber
              ? await tx`
                  INSERT INTO students (school_id, person_id, admission_no, pen_number, apar_number, admission_date, status_id, category_id, religion_id, blood_group_id)
                  VALUES (${schoolId}, ${person.id}, ${admissionNo.toString()}, ${normalizedPenNumber}, ${aparNumber}, ${admissionDate}, ${statusId}, ${categoryId}, ${religionId}, ${bloodGroupId})
                  RETURNING id
                `
              : await tx`
                  INSERT INTO students (school_id, person_id, admission_no, apar_number, admission_date, status_id, category_id, religion_id, blood_group_id)
                  VALUES (${schoolId}, ${person.id}, ${admissionNo.toString()}, ${aparNumber}, ${admissionDate}, ${statusId}, ${categoryId}, ${religionId}, ${bloodGroupId})
                  RETURNING id
                `;

            // 3. Contacts
            if (canonicalEmail)
              await tx`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${schoolId}, ${person.id}, 'email', ${canonicalEmail}, true)`;
            if (phone)
              await tx`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${schoolId}, ${person.id}, 'phone', ${phone.toString()}, true)`;

            // 4. Enrollment with auto-roll. Create/restore the class-section
            // mapping just like the app add-student flow.
            const [cs] = await tx`
              INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
              VALUES (${schoolId}, ${classId}, ${sectionId}, ${academicYear.id})
              ON CONFLICT (school_id, class_id, section_id, academic_year_id)
              DO UPDATE SET deleted_at = NULL
              RETURNING id
            `;

            const [rollData] = await tx`
              SELECT COALESCE(MAX(roll_number), 0) + 1 as next_roll 
              FROM student_enrollments 
              WHERE class_section_id = ${cs.id} AND school_id = ${schoolId} 
              AND academic_year_id = ${academicYear.id} AND deleted_at IS NULL
            `;

            await tx`
              INSERT INTO student_enrollments (school_id, student_id, class_section_id, academic_year_id, status, start_date, roll_number)
              VALUES (${schoolId}, ${student.id}, ${cs.id}, ${academicYear.id}, 'active', ${admissionDate}, ${rollData ? rollData.next_roll : 1})
            `;

            // 5. Father parent record
            const fFirstName = row['Father First Name'];
            if (fFirstName) {
              const [father] = await tx`
                INSERT INTO persons (school_id, first_name, last_name, gender_id, display_name)
                VALUES (${schoolId}, ${fFirstName}, ${row['Father Last Name'] || lastName}, 1, ${fFirstName + ' ' + (row['Father Last Name'] || lastName)})
                RETURNING id
              `;
              const fPhone = row['Father Phone'];
              if (fPhone)
                await tx`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${schoolId}, ${father.id}, 'phone', ${fPhone.toString()}, true)`;

              const [parentRecord] = await tx`
                INSERT INTO parents (school_id, person_id, occupation)
                VALUES (${schoolId}, ${father.id}, ${row['Father Occupation'] || null})
                RETURNING id
              `;
              await tx`
                INSERT INTO student_parents (school_id, student_id, parent_id, relationship_id, is_primary_contact)
                VALUES (${schoolId}, ${student.id}, ${parentRecord.id}, 1, true)
              `;
            }

            // 6. Mother parent record
            const mFirstName = row['Mother First Name'];
            if (mFirstName) {
              const [mother] = await tx`
                INSERT INTO persons (school_id, first_name, last_name, gender_id, display_name)
                VALUES (${schoolId}, ${mFirstName}, ${row['Mother Last Name'] || lastName}, 2, ${mFirstName + ' ' + (row['Mother Last Name'] || lastName)})
                RETURNING id
              `;
              const mPhone = row['Mother Phone'];
              if (mPhone)
                await tx`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${schoolId}, ${mother.id}, 'phone', ${mPhone.toString()}, true)`;

              const [motherRecord] = await tx`
                INSERT INTO parents (school_id, person_id, occupation)
                VALUES (${schoolId}, ${mother.id}, ${row['Mother Occupation'] || null})
                RETURNING id
              `;
              await tx`
                INSERT INTO student_parents (school_id, student_id, parent_id, relationship_id, is_primary_contact)
                VALUES (${schoolId}, ${student.id}, ${motherRecord.id}, 2, false)
              `;
            }

            // 7. Create Supabase auth user — failure throws and rolls back DB writes for this row
            console.log(`[Import] Row ${rowNum}: Creating auth user for ${rawEmail} (school ${schoolId})`);
            const { data: authData, error: authError } = await authAdmin.auth.admin.createUser({
              email: rawEmail,
              password: passwordStr,
              email_confirm: true,
            });
            if (authError) {
              throw new Error(`Auth user creation failed — ${authError.message}`);
            }
            if (!authData?.user?.id) {
              throw new Error('Supabase returned empty auth data — check service_role key and project configuration');
            }

            const authUserId = authData.user.id;

            // 8. Link Supabase auth user to local users table
            const [existingLocalUser] = await tx`SELECT id FROM users WHERE id = ${authUserId}`;
            if (!existingLocalUser) {
              const [user] = await tx`
                INSERT INTO users (id, school_id, person_id, account_status)
                VALUES (${authUserId}, ${schoolId}, ${person.id}, 'active')
                RETURNING id
              `;

              await tx`INSERT INTO user_roles (user_id, role_id, school_id) VALUES (${user.id}, ${studentRole.id}, ${schoolId})`;
            }
            rowCredentialsCreated = true;
            console.log(`[Import] Row ${rowNum}: Login credentials created successfully`);
          });

          if (rowCredentialsCreated) credentialsCreated++;
          successCount++;
        } catch (err) {
          console.error(`[Import] Row ${i + 2}: Unexpected error:`, err);
          if (isPenConflict(err)) {
            errors.push(`Row ${rowNum}: PEN Number already exists`);
          } else {
            errors.push(`Row ${rowNum}: ${err.message}`);
          }
        }
      }

      const firstErrors = errors.slice(0, 3).join('; ');
      const failureMessage = successCount > 0
        ? `Imported ${successCount} students with ${credentialsCreated} login credentials created.`
        : `No students were imported. ${errors.length} row${errors.length === 1 ? '' : 's'} failed validation or save.${firstErrors ? ` First error${errors.length > 1 ? 's' : ''}: ${firstErrors}` : ''}`;

      const result = {
        success: successCount > 0,
        importedCount: successCount,
        credentialsCreated,
        errors,
        message: failureMessage,
      };

      console.log(`[Import] School ${schoolId}: imported=${successCount}, credentials=${credentialsCreated}, errors=${errors.length}`);

      if (successCount === 0 && errors.length > 0) {
        return sendResponse(res, 400, {
          ...result,
          error: result.message,
        });
      }

      return sendResponse(res, 200, result);
    } catch (error) {
      console.error('Import error:', error);
      res.status(500).json({ error: 'Server error during import', detail: error.message });
    }
  },
);

module.exports = router;

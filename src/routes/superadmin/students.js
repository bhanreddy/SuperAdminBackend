const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { authenticateUser, requireAnyPermission } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');

const router = express.Router();

// GET /api/super-admin/students
router.get('/', authenticateUser, requireAnyPermission(PERMISSIONS.STUDENTS_READ_ASSIGNED, PERMISSIONS.SCHOOLS_READ_ALL), async (req, res) => {
  try {
    const studentsList = await sql`
      SELECT 
        s.id, 
        s.admission_no, 
        s.created_at,
        s.status_id,
        st.code as status_name,
        p.first_name, 
        p.last_name, 
        p.gender_id,
        p.photo_url,
        sc.name as school_name,
        sc.id as school_id
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN schools sc ON s.school_id = sc.id
      LEFT JOIN student_statuses st ON s.status_id = st.id
      WHERE s.deleted_at IS NULL
        ${req.user.isFounder || req.user.permissions.includes(PERMISSIONS.SCHOOLS_READ_ALL)
          ? sql``
          : sql`AND s.school_id IN ${sql(req.user.assignedSchoolIds.length ? req.user.assignedSchoolIds : [-1])}`}
      ORDER BY s.created_at DESC
    `;
    return sendResponse(res, 200, studentsList);
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// GET /api/super-admin/students/:id
router.get('/:id', authenticateUser, requireAnyPermission(PERMISSIONS.STUDENTS_READ_ASSIGNED, PERMISSIONS.SCHOOLS_READ_ALL), async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await sql`
      SELECT 
        s.id, 
        s.admission_no, 
        s.created_at,
        s.status_id,
        st.code as status_name,
        p.first_name, 
        p.last_name, 
        p.gender_id,
        p.photo_url,
        sc.name as school_name,
        sc.id as school_id
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN schools sc ON s.school_id = sc.id
      LEFT JOIN student_statuses st ON s.status_id = st.id
      WHERE s.deleted_at IS NULL AND s.id = ${id}
    `;
    if (!rows.length) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (
      !req.user.isFounder &&
      !req.user.permissions.includes(PERMISSIONS.SCHOOLS_READ_ALL) &&
      !req.user.assignedSchoolIds.includes(Number(rows[0].school_id))
    ) {
      return res.status(403).json({ error: 'Access denied to this student\'s school' });
    }
    return sendResponse(res, 200, rows[0]);
  } catch (err) {
    console.error('Error fetching student:', err);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

module.exports = router;

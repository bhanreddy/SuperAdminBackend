const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');

const router = express.Router();

// GET /api/super-admin/students
router.get('/', verifySuperAdminMiddleware, async (req, res) => {
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
      ORDER BY s.created_at DESC
    `;
    return sendResponse(res, 200, studentsList);
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// GET /api/super-admin/students/:id
router.get('/:id', verifySuperAdminMiddleware, async (req, res) => {
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
    return sendResponse(res, 200, rows[0]);
  } catch (err) {
    console.error('Error fetching student:', err);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

module.exports = router;

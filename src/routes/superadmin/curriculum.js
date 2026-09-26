const express = require('express');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { sendResponse } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');
const CurriculumMasterService = require('../../services/curriculumMasterService');
const CurriculumPublicationService = require('../../services/curriculumPublicationService');
const CurriculumDiffService = require('../../services/curriculumDiffService');
const sql = require('../../config/db');

const router = express.Router();

// Require SuperAdmin/Founder auth across all control plane routes
router.use(verifySuperAdminMiddleware);

// ══════════════════════════════════════════════════════════════════════════════
// 1. PRODUCTS & VERSIONS
// ══════════════════════════════════════════════════════════════════════════════

router.get('/products', asyncHandler(async (req, res) => {
  const { status, board, search } = req.query;
  const products = await CurriculumMasterService.listProducts({ status, board, search });
  return sendResponse(res, 200, { success: true, data: products });
}));

router.get('/products/:id', asyncHandler(async (req, res) => {
  const product = await CurriculumMasterService.getProductById(req.params.id);
  if (!product) return sendResponse(res, 404, { error: 'Curriculum product not found' });
  return sendResponse(res, 200, { success: true, data: product });
}));

router.post('/products', asyncHandler(async (req, res) => {
  const { code, name, description, board_or_framework, curriculum_type, default_language, supported_languages } = req.body || {};
  if (!code || !name || !board_or_framework) {
    return sendResponse(res, 400, { error: 'code, name, and board_or_framework are required' });
  }

  const product = await CurriculumMasterService.createProduct({
    code, name, description, board_or_framework, curriculum_type,
    default_language, supported_languages,
    userId: req.superAdmin?.id
  });

  return sendResponse(res, 201, { success: true, data: product });
}));

router.post('/products/:id/versions', asyncHandler(async (req, res) => {
  const { version_type, release_name, release_notes, based_on_version_id } = req.body || {};
  const version = await CurriculumMasterService.createVersion({
    productId: req.params.id,
    versionType: version_type || 'MINOR',
    releaseName: release_name,
    releaseNotes: release_notes,
    basedOnVersionId: based_on_version_id,
    userId: req.superAdmin?.id
  });
  return sendResponse(res, 201, { success: true, data: version });
}));

router.get('/versions/:id', asyncHandler(async (req, res) => {
  const version = await CurriculumMasterService.getVersionById(req.params.id);
  if (!version) return sendResponse(res, 404, { error: 'Curriculum version not found' });
  return sendResponse(res, 200, { success: true, data: version });
}));

router.get('/versions/:id/tree', asyncHandler(async (req, res) => {
  const { standard_grade_level, canonical_subject_code } = req.query;
  const tree = await CurriculumMasterService.getVersionTree({
    versionId: req.params.id,
    standardGradeLevel: standard_grade_level,
    canonicalSubjectCode: canonical_subject_code
  });
  return sendResponse(res, 200, { success: true, data: tree });
}));

// ══════════════════════════════════════════════════════════════════════════════
// 2. DRAFT AUTHORING (OFFERINGS / UNITS / CHAPTERS / LESSONS)
// ══════════════════════════════════════════════════════════════════════════════

router.post('/versions/:id/offerings', asyncHandler(async (req, res) => {
  const { standard_grade_level, canonical_subject_code, canonical_subject_name, subject_type, sequence, weekly_periods } = req.body || {};
  if (!standard_grade_level || !canonical_subject_code || !canonical_subject_name) {
    return sendResponse(res, 400, { error: 'standard_grade_level, canonical_subject_code, and canonical_subject_name are required' });
  }

  const offering = await CurriculumMasterService.addOffering({
    versionId: req.params.id,
    standardGradeLevel: standard_grade_level,
    canonicalSubjectCode: canonical_subject_code,
    canonicalSubjectName: canonical_subject_name,
    subjectType: subject_type,
    sequence: sequence || 1,
    weeklyPeriods: weekly_periods || 5
  });

  return sendResponse(res, 201, { success: true, data: offering });
}));

router.post('/offerings/:id/units', asyncHandler(async (req, res) => {
  const { code, title, description, sequence, estimated_periods } = req.body || {};
  if (!code || !title) return sendResponse(res, 400, { error: 'code and title are required' });

  const unit = await CurriculumMasterService.addUnit({
    offeringId: req.params.id,
    code, title, description,
    sequence: sequence || 1,
    estimatedPeriods: estimated_periods || 10
  });

  return sendResponse(res, 201, { success: true, data: unit });
}));

router.post('/units/:id/chapters', asyncHandler(async (req, res) => {
  const { code, title, description, sequence, estimated_periods, difficulty_level } = req.body || {};
  if (!code || !title) return sendResponse(res, 400, { error: 'code and title are required' });

  const chapter = await CurriculumMasterService.addChapter({
    unitId: req.params.id,
    code, title, description,
    sequence: sequence || 1,
    estimatedPeriods: estimated_periods || 2,
    difficultyLevel: difficulty_level || 'MEDIUM'
  });

  return sendResponse(res, 201, { success: true, data: chapter });
}));

router.post('/chapters/:id/lessons', asyncHandler(async (req, res) => {
  const { code, title, description, sequence, lesson_type, estimated_minutes, teacher_guidance, student_summary, is_optional } = req.body || {};
  if (!code || !title) return sendResponse(res, 400, { error: 'code and title are required' });

  const lesson = await CurriculumMasterService.addLesson({
    chapterId: req.params.id,
    code, title, description,
    sequence: sequence || 1,
    lessonType: lesson_type || 'THEORY',
    estimatedMinutes: estimated_minutes || 45,
    teacherGuidance: teacher_guidance,
    studentSummary: student_summary,
    isOptional: is_optional || false
  });

  return sendResponse(res, 201, { success: true, data: lesson });
}));

// ══════════════════════════════════════════════════════════════════════════════
// 3. REVIEW WORKFLOW & FEEDBACK
// ══════════════════════════════════════════════════════════════════════════════

router.post('/versions/:id/submit-review', asyncHandler(async (req, res) => {
  const updated = await CurriculumPublicationService.submitForReview(req.params.id, req.superAdmin?.id);
  return sendResponse(res, 200, { success: true, data: updated });
}));

router.post('/versions/:id/reviews', asyncHandler(async (req, res) => {
  const { review_type, summary, status } = req.body || {};
  if (!review_type) return sendResponse(res, 400, { error: 'review_type is required' });

  const review = await CurriculumPublicationService.addReview(req.params.id, {
    reviewType: review_type,
    summary,
    status: status || 'IN_PROGRESS',
    reviewerId: req.superAdmin?.id
  });

  return sendResponse(res, 201, { success: true, data: review });
}));

router.get('/versions/:id/comments', asyncHandler(async (req, res) => {
  const comments = await CurriculumPublicationService.listComments(req.params.id);
  return sendResponse(res, 200, { success: true, data: comments });
}));

router.post('/versions/:id/comments', asyncHandler(async (req, res) => {
  const { review_id, entity_type, entity_id, field_path, severity, comment } = req.body || {};
  if (!entity_type || !entity_id || !comment) {
    return sendResponse(res, 400, { error: 'entity_type, entity_id, and comment are required' });
  }

  const reviewComment = await CurriculumPublicationService.addComment(req.params.id, {
    reviewId: review_id,
    entityType: entity_type,
    entityId: entity_id,
    fieldPath: field_path,
    severity: severity || 'REQUIRED_CHANGE',
    comment,
    createdBy: req.superAdmin?.id
  });

  return sendResponse(res, 201, { success: true, data: reviewComment });
}));

router.patch('/comments/:id/resolve', asyncHandler(async (req, res) => {
  const { resolution_notes } = req.body || {};
  const resolved = await CurriculumPublicationService.resolveComment(req.params.id, {
    resolvedBy: req.superAdmin?.id,
    resolutionNotes: resolution_notes
  });
  return sendResponse(res, 200, { success: true, data: resolved });
}));

router.post('/versions/:id/approve', asyncHandler(async (req, res) => {
  const approved = await CurriculumPublicationService.approveVersion(req.params.id, req.superAdmin?.id);
  return sendResponse(res, 200, { success: true, data: approved });
}));

// ══════════════════════════════════════════════════════════════════════════════
// 4. PUBLICATION & WITHDRAWAL
// ══════════════════════════════════════════════════════════════════════════════

router.post('/versions/:id/publish', asyncHandler(async (req, res) => {
  const { release_notes } = req.body || {};
  const result = await CurriculumPublicationService.publishVersion(req.params.id, {
    releaseNotes: release_notes,
    publishedBy: req.superAdmin?.id
  });
  return sendResponse(res, 200, { success: true, data: result });
}));

router.post('/versions/:id/withdraw', asyncHandler(async (req, res) => {
  const { reason, recommended_replacement_version_id } = req.body || {};
  if (!reason) return sendResponse(res, 400, { error: 'reason is required for withdrawal' });

  const result = await CurriculumPublicationService.withdrawVersion(req.params.id, {
    reason,
    replacementVersionId: recommended_replacement_version_id,
    withdrawnBy: req.superAdmin?.id
  });

  return sendResponse(res, 200, { success: true, data: result });
}));

// ══════════════════════════════════════════════════════════════════════════════
// 5. VERSION DIFF
// ══════════════════════════════════════════════════════════════════════════════

router.get('/versions/:versionA/compare/:versionB', asyncHandler(async (req, res) => {
  const diff = await CurriculumDiffService.compareVersions(req.params.versionA, req.params.versionB);
  return sendResponse(res, 200, { success: true, data: diff });
}));

// ══════════════════════════════════════════════════════════════════════════════
// 6. GLOBAL SCHOOL ASSIGNMENTS INSPECTION & MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

router.get('/assignments', asyncHandler(async (req, res) => {
  const { school_id, product_id, status } = req.query;
  const assignments = await sql`
    SELECT 
      sca.*,
      s.name AS school_name,
      s.code AS school_code,
      ay.name AS academic_year_name,
      cp.code AS product_code,
      cp.name AS product_name,
      cv.version_label,
      cv.status AS version_status
    FROM school_curriculum_assignments sca
    JOIN schools s ON s.id = sca.school_id
    JOIN academic_years ay ON ay.id = sca.academic_year_id
    JOIN curriculum_products cp ON cp.id = sca.curriculum_product_id
    JOIN curriculum_versions cv ON cv.id = sca.curriculum_version_id
    WHERE 1=1
      ${school_id ? sql`AND sca.school_id = ${Number(school_id)}` : sql``}
      ${product_id ? sql`AND sca.curriculum_product_id = ${product_id}` : sql``}
      ${status ? sql`AND sca.status = ${status}` : sql``}
    ORDER BY sca.assigned_at DESC;
  `;
  return sendResponse(res, 200, { success: true, data: assignments });
}));

router.post('/assignments', asyncHandler(async (req, res) => {
  const { school_id, academic_year_id, curriculum_product_id, curriculum_version_id, auto_upgrade_policy = 'MANUAL' } = req.body || {};
  if (!school_id || !academic_year_id || !curriculum_product_id || !curriculum_version_id) {
    return sendResponse(res, 400, { error: 'school_id, academic_year_id, curriculum_product_id, and curriculum_version_id are required' });
  }

  const [assignment] = await sql`
    INSERT INTO school_curriculum_assignments (
      school_id, academic_year_id, curriculum_product_id, curriculum_version_id,
      status, auto_upgrade_policy, assigned_by
    ) VALUES (
      ${Number(school_id)}, ${academic_year_id}, ${curriculum_product_id}, ${curriculum_version_id},
      'ACTIVE', ${auto_upgrade_policy}, ${req.superAdmin?.id || null}
    )
    ON CONFLICT (school_id, academic_year_id, curriculum_product_id)
    DO UPDATE SET
      curriculum_version_id = EXCLUDED.curriculum_version_id,
      auto_upgrade_policy = EXCLUDED.auto_upgrade_policy,
      status = 'ACTIVE',
      updated_at = now()
    RETURNING *;
  `;

  await sql`
    INSERT INTO curriculum_assignment_history (
      school_id, academic_year_id, assignment_id, to_version_id, action, reason, performed_by
    ) VALUES (
      ${Number(school_id)}, ${academic_year_id}, ${assignment.id}, ${curriculum_version_id},
      'ASSIGN', 'Assigned from SuperAdmin Control Plane', ${req.superAdmin?.id || null}
    );
  `;

  return sendResponse(res, 201, { success: true, data: assignment });
}));

module.exports = router;

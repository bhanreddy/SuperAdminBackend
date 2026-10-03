const sql = require('../config/db');
const authoringClient = require('./curriculumAuthoringClient');

/**
 * Domain Service for the NexSyrus Curriculum Master Catalog and Release Control Plane.
 * Manages Curriculum Products, Semantic Versions, Node Authoring, Review Gates, and Publications.
 */
class CurriculumMasterService {

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. CURRICULUM PRODUCTS
  // ══════════════════════════════════════════════════════════════════════════════

  static async listProducts({ status, board, search } = {}) {
    return sql`
      SELECT 
        cp.id,
        cp.code,
        cp.name,
        cp.description,
        cp.board_or_framework,
        cp.curriculum_type,
        cp.default_language,
        cp.supported_languages,
        cp.status,
        cp.created_at,
        cp.updated_at,
        COUNT(DISTINCT cv.id)::int AS total_versions,
        COUNT(DISTINCT cv.id) FILTER (WHERE cv.status = 'PUBLISHED')::int AS published_versions_count,
        MAX(cv.version_label) FILTER (WHERE cv.status = 'PUBLISHED') AS latest_published_version
      FROM curriculum_products cp
      LEFT JOIN curriculum_versions cv ON cv.curriculum_product_id = cp.id
      WHERE 1=1
        ${status ? sql`AND cp.status = ${status}` : sql``}
        ${board ? sql`AND cp.board_or_framework = ${board}` : sql``}
        ${search ? sql`AND (cp.name ILIKE ${'%' + search + '%'} OR cp.code ILIKE ${'%' + search + '%'})` : sql``}
      GROUP BY cp.id
      ORDER BY cp.created_at DESC;
    `;
  }

  static async getProductById(productId) {
    const [product] = await sql`
      SELECT * FROM curriculum_products WHERE id = ${productId};
    `;
    if (!product) return null;

    const versions = await sql`
      SELECT 
        cv.*,
        COUNT(DISTINCT co.id)::int AS offerings_count
      FROM curriculum_versions cv
      LEFT JOIN curriculum_offerings co ON co.curriculum_version_id = cv.id
      WHERE cv.curriculum_product_id = ${productId}
      GROUP BY cv.id
      ORDER BY cv.major DESC, cv.minor DESC, cv.patch DESC;
    `;

    return { ...product, versions };
  }

  static async createProduct(input) {
    return authoringClient.createProduct(input);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. CURRICULUM VERSIONS & STATE MACHINE
  // ══════════════════════════════════════════════════════════════════════════════

  static async getVersionById(versionId) {
    const [version] = await sql`
      SELECT 
        cv.*,
        cp.code AS product_code,
        cp.name AS product_name,
        cp.board_or_framework
      FROM curriculum_versions cv
      JOIN curriculum_products cp ON cp.id = cv.curriculum_product_id
      WHERE cv.id = ${versionId};
    `;
    return version || null;
  }

  static async createVersion(input) {
    return authoringClient.createVersion(input);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. CURRICULUM TREE QUERY (Zero N+1)
  // ══════════════════════════════════════════════════════════════════════════════

  static async getVersionTree({ versionId, standardGradeLevel, canonicalSubjectCode }) {
    const offerings = await sql`
      SELECT 
        co.id AS offering_id,
        co.standard_grade_level,
        co.canonical_subject_code,
        co.canonical_subject_name,
        co.subject_type,
        co.sequence AS offering_sequence,
        co.weekly_periods,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', u.id,
              'code', u.code,
              'title', u.title,
              'description', u.description,
              'sequence', u.sequence,
              'estimated_periods', u.estimated_periods,
              'chapters', COALESCE(
                (
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', ch.id,
                      'code', ch.code,
                      'title', ch.title,
                      'description', ch.description,
                      'sequence', ch.sequence,
                      'estimated_periods', ch.estimated_periods,
                      'difficulty_level', ch.difficulty_level,
                      'lessons', COALESCE(
                        (
                          SELECT jsonb_agg(
                            jsonb_build_object(
                              'id', l.id,
                              'code', l.code,
                              'title', l.title,
                              'description', l.description,
                              'sequence', l.sequence,
                              'lesson_type', l.lesson_type,
                              'estimated_minutes', l.estimated_minutes,
                              'teacher_guidance', l.teacher_guidance,
                              'student_summary', l.student_summary,
                              'is_optional', l.is_optional,
                              'objectives', COALESCE(
                                (
                                  SELECT jsonb_agg(jsonb_build_object('id', o.id, 'code', o.code, 'statement', o.statement, 'bloom_level', o.bloom_level))
                                  FROM curriculum_lesson_objectives clo
                                  JOIN curriculum_objectives o ON o.id = clo.objective_id
                                  WHERE clo.lesson_id = l.id
                                ), '[]'::jsonb
                              ),
                              'resources', COALESCE(
                                (
                                  SELECT jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'resource_type', r.resource_type, 'external_url', r.external_url))
                                  FROM curriculum_lesson_resources clr
                                  JOIN curriculum_resources r ON r.id = clr.resource_id
                                  WHERE clr.lesson_id = l.id
                                ), '[]'::jsonb
                              )
                            ) ORDER BY l.sequence ASC
                          )
                          FROM curriculum_master_lessons l
                          WHERE l.chapter_id = ch.id
                        ), '[]'::jsonb
                      )
                    ) ORDER BY ch.sequence ASC
                  )
                  FROM curriculum_master_chapters ch
                  WHERE ch.unit_id = u.id
                ), '[]'::jsonb
              )
            ) ORDER BY u.sequence ASC
          ) FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb
        ) AS units
      FROM curriculum_offerings co
      LEFT JOIN curriculum_master_units u ON u.offering_id = co.id
      WHERE co.curriculum_version_id = ${versionId}
        ${standardGradeLevel ? sql`AND co.standard_grade_level = ${standardGradeLevel}` : sql``}
        ${canonicalSubjectCode ? sql`AND co.canonical_subject_code = ${canonicalSubjectCode}` : sql``}
      GROUP BY co.id
      ORDER BY co.standard_grade_level ASC, co.sequence ASC;
    `;

    return offerings;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. DRAFT NODE MUTATIONS (Enforcing Immutability)
  // ══════════════════════════════════════════════════════════════════════════════

  static addOffering(input) { return authoringClient.createOffering(input); }
  static addUnit(input) { return authoringClient.createUnit(input); }
  static addChapter(input) { return authoringClient.createChapter(input); }
  static addLesson(input) { return authoringClient.createLesson(input); }

  static async createOffering(versionIdOrPayload, maybePayload = {}) {
    const payload = typeof versionIdOrPayload === 'object' ? versionIdOrPayload : { versionId: versionIdOrPayload, ...maybePayload };
    return authoringClient.createOffering(payload);
  }
  static async createUnit(offeringIdOrPayload, maybePayload = {}) {
    const payload = typeof offeringIdOrPayload === 'object' ? offeringIdOrPayload : { offeringId: offeringIdOrPayload, ...maybePayload };
    return authoringClient.createUnit(payload);
  }
  static async createChapter(unitIdOrPayload, maybePayload = {}) {
    const payload = typeof unitIdOrPayload === 'object' ? unitIdOrPayload : { unitId: unitIdOrPayload, ...maybePayload };
    return authoringClient.createChapter(payload);
  }
  static async createLesson(chapterIdOrPayload, maybePayload = {}) {
    const payload = typeof chapterIdOrPayload === 'object' ? chapterIdOrPayload : { chapterId: chapterIdOrPayload, ...maybePayload };
    return authoringClient.createLesson(payload);
  }

  static async getFullTree(versionId) {
    const version = await this.getVersionById(versionId);
    const offerings = await this.getVersionTree({ versionId });
    return { version, offerings };
  }
}

module.exports = CurriculumMasterService;

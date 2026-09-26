const crypto = require('crypto');
const sql = require('../config/db');

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

  static async createProduct({ code, name, description, board_or_framework, boardOrFramework, curriculum_type = 'STANDARD', curriculumType, default_language = 'en', defaultLanguage, supported_languages = ['en'], supportedLanguages, userId, user_id }) {
    const cleanCode = String(code).trim().toUpperCase();
    const cleanName = String(name).trim();
    const board = board_or_framework || boardOrFramework || 'CBSE';
    const currType = curriculum_type || curriculumType || 'STANDARD';
    const defLang = default_language || defaultLanguage || 'en';
    const suppLangs = supported_languages || supportedLanguages || ['en'];
    const creator = userId || user_id || null;

    const [existing] = await sql`
      SELECT id FROM curriculum_products WHERE code = ${cleanCode};
    `;
    if (existing) {
      const err = new Error(`Curriculum product with code '${cleanCode}' already exists`);
      err.statusCode = 409;
      err.code = 'PRODUCT_CODE_EXISTS';
      throw err;
    }

    const [product] = await sql`
      INSERT INTO curriculum_products (
        code, name, description, board_or_framework, curriculum_type,
        default_language, supported_languages, status, created_by
      ) VALUES (
        ${cleanCode}, ${cleanName}, ${description || null}, ${board},
        ${currType}, ${defLang}, ${suppLangs}, 'ACTIVE', ${creator}
      )
      RETURNING *;
    `;

    await this.logAudit({
      actorId: creator,
      actorType: 'SUPER_ADMIN',
      action: 'CURRICULUM_PRODUCT_CREATED',
      entityType: 'PRODUCT',
      entityId: product.id,
      afterState: product,
      reason: 'Created new master curriculum product'
    });

    return product;
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

  static async createVersion({ productId, major: reqMajor, minor: reqMinor, patch: reqPatch, versionType = 'MINOR', releaseName, releaseNotes, basedOnVersionId, cloneFromVersionId, userId, user_id }) {
    const [product] = await sql`SELECT id, code FROM curriculum_products WHERE id = ${productId}`;
    if (!product) {
      const err = new Error('Curriculum product not found');
      err.statusCode = 404;
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const parentVersionId = cloneFromVersionId || basedOnVersionId || null;
    const creator = userId || user_id || null;

    let major = reqMajor;
    let minor = reqMinor;
    let patch = reqPatch;

    if (major === undefined || minor === undefined || patch === undefined) {
      const [latest] = await sql`
        SELECT major, minor, patch FROM curriculum_versions
        WHERE curriculum_product_id = ${productId}
        ORDER BY major DESC, minor DESC, patch DESC
        LIMIT 1;
      `;

      if (latest) {
        if (versionType === 'MAJOR') {
          major = latest.major + 1;
          minor = 0;
          patch = 0;
        } else if (versionType === 'MINOR') {
          major = latest.major;
          minor = latest.minor + 1;
          patch = 0;
        } else {
          major = latest.major;
          minor = latest.minor;
          patch = latest.patch + 1;
        }
      } else {
        major = 1;
        minor = 0;
        patch = 0;
      }
    }

    const versionLabel = `${major}.${minor}.${patch}`;

    const [version] = await sql`
      INSERT INTO curriculum_versions (
        curriculum_product_id, major, minor, patch, version_label,
        status, based_on_version_id, release_name, release_notes, created_by
      ) VALUES (
        ${productId}, ${major}, ${minor}, ${patch}, ${versionLabel},
        'DRAFT', ${parentVersionId},
        ${releaseName || `Release ${versionLabel}`}, ${releaseNotes || null}, ${creator}
      )
      RETURNING *;
    `;

    // If cloning from a previous version, clone the entire offering/unit/chapter/lesson graph
    if (parentVersionId) {
      await this.cloneVersionContent({ sourceVersionId: parentVersionId, targetVersionId: version.id });
    }

    await this.logAudit({
      actorId: creator,
      actorType: 'SUPER_ADMIN',
      action: 'CURRICULUM_VERSION_CREATED',
      entityType: 'VERSION',
      entityId: version.id,
      afterState: version,
      reason: `Spawned draft version ${versionLabel} (${versionType})`
    });

    return version;
  }

  /**
   * Clones entire curriculum hierarchy from source version to target draft version.
   */
  static async cloneVersionContent({ sourceVersionId, targetVersionId }) {
    const offerings = await sql`SELECT * FROM curriculum_offerings WHERE curriculum_version_id = ${sourceVersionId} ORDER BY sequence`;

    for (const off of offerings) {
      const [newOff] = await sql`
        INSERT INTO curriculum_offerings (
          curriculum_version_id, standard_grade_level, canonical_subject_code,
          canonical_subject_name, subject_type, sequence, weekly_periods, metadata
        ) VALUES (
          ${targetVersionId}, ${off.standard_grade_level}, ${off.canonical_subject_code},
          ${off.canonical_subject_name}, ${off.subject_type}, ${off.sequence}, ${off.weekly_periods}, ${off.metadata}
        ) RETURNING id;
      `;

      const units = await sql`SELECT * FROM curriculum_master_units WHERE offering_id = ${off.id} ORDER BY sequence`;
      for (const u of units) {
        const [newUnit] = await sql`
          INSERT INTO curriculum_master_units (
            offering_id, code, title, description, sequence, estimated_periods, metadata
          ) VALUES (
            ${newOff.id}, ${u.code}, ${u.title}, ${u.description}, ${u.sequence}, ${u.estimated_periods}, ${u.metadata}
          ) RETURNING id;
        `;

        const chapters = await sql`SELECT * FROM curriculum_master_chapters WHERE unit_id = ${u.id} ORDER BY sequence`;
        for (const ch of chapters) {
          const [newChap] = await sql`
            INSERT INTO curriculum_master_chapters (
              unit_id, code, title, description, sequence, estimated_periods, difficulty_level, metadata
            ) VALUES (
              ${newUnit.id}, ${ch.code}, ${ch.title}, ${ch.description}, ${ch.sequence}, ${ch.estimated_periods}, ${ch.difficulty_level}, ${ch.metadata}
            ) RETURNING id;
          `;

          const lessons = await sql`SELECT * FROM curriculum_master_lessons WHERE chapter_id = ${ch.id} ORDER BY sequence`;
          for (const l of lessons) {
            const [newLesson] = await sql`
              INSERT INTO curriculum_master_lessons (
                chapter_id, code, title, description, sequence, lesson_type,
                estimated_minutes, teacher_guidance, student_summary, prerequisite_notes, is_optional, metadata
              ) VALUES (
                ${newChap.id}, ${l.code}, ${l.title}, ${l.description}, ${l.sequence}, ${l.lesson_type},
                ${l.estimated_minutes}, ${l.teacher_guidance}, ${l.student_summary}, ${l.prerequisite_notes}, ${l.is_optional}, ${l.metadata}
              ) RETURNING id;
            `;

            // Clone junction associations
            await sql`
              INSERT INTO curriculum_lesson_objectives (lesson_id, objective_id)
              SELECT ${newLesson.id}, objective_id FROM curriculum_lesson_objectives WHERE lesson_id = ${l.id};
            `;
            await sql`
              INSERT INTO curriculum_lesson_competencies (lesson_id, competency_id)
              SELECT ${newLesson.id}, competency_id FROM curriculum_lesson_competencies WHERE lesson_id = ${l.id};
            `;
            await sql`
              INSERT INTO curriculum_lesson_activities (lesson_id, activity_id, sequence)
              SELECT ${newLesson.id}, activity_id, sequence FROM curriculum_lesson_activities WHERE lesson_id = ${l.id};
            `;
            await sql`
              INSERT INTO curriculum_lesson_assessments (lesson_id, assessment_id)
              SELECT ${newLesson.id}, assessment_id FROM curriculum_lesson_assessments WHERE lesson_id = ${l.id};
            `;
            await sql`
              INSERT INTO curriculum_lesson_resources (lesson_id, resource_id)
              SELECT ${newLesson.id}, resource_id FROM curriculum_lesson_resources WHERE lesson_id = ${l.id};
            `;
          }
        }
      }
    }
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

  static async assertVersionEditable(versionId) {
    const [version] = await sql`SELECT status, version_label FROM curriculum_versions WHERE id = ${versionId}`;
    if (!version) {
      const err = new Error('Version not found');
      err.statusCode = 404;
      throw err;
    }
    if (['PUBLISHED', 'SUPERSEDED', 'WITHDRAWN', 'ARCHIVED'].includes(version.status)) {
      const err = new Error(`Cannot modify version ${version.version_label}: It is in immutable status '${version.status}'`);
      err.statusCode = 409;
      err.code = 'CURRICULUM_VERSION_IMMUTABLE';
      throw err;
    }
  }

  static async addOffering({ versionId, standardGradeLevel, canonicalSubjectCode, canonicalSubjectName, title, subjectType = 'CORE', sequence = 1, weeklyPeriods = 5, academicPeriodsPerWeek }) {
    await this.assertVersionEditable(versionId);
    const subName = canonicalSubjectName || title || canonicalSubjectCode;
    const periods = weeklyPeriods || academicPeriodsPerWeek || 5;
    const [offering] = await sql`
      INSERT INTO curriculum_offerings (
        curriculum_version_id, standard_grade_level, canonical_subject_code,
        canonical_subject_name, subject_type, sequence, weekly_periods
      ) VALUES (
        ${versionId}, ${standardGradeLevel}, ${canonicalSubjectCode},
        ${subName}, ${subjectType}, ${sequence}, ${periods}
      ) RETURNING *;
    `;
    return offering;
  }

  static async addUnit({ offeringId, code, title, description, sequence = 1, estimatedPeriods = 10 }) {
    const [offering] = await sql`SELECT curriculum_version_id FROM curriculum_offerings WHERE id = ${offeringId}`;
    if (!offering) throw new Error('Offering not found');
    await this.assertVersionEditable(offering.curriculum_version_id);

    const [unit] = await sql`
      INSERT INTO curriculum_master_units (
        offering_id, code, title, description, sequence, estimated_periods
      ) VALUES (
        ${offeringId}, ${code}, ${title}, ${description || null}, ${sequence}, ${estimatedPeriods}
      ) RETURNING *;
    `;
    return unit;
  }

  static async addChapter({ unitId, code, title, description, sequence = 1, estimatedPeriods = 2, difficultyLevel = 'MEDIUM' }) {
    const [unit] = await sql`
      SELECT co.curriculum_version_id 
      FROM curriculum_master_units u
      JOIN curriculum_offerings co ON co.id = u.offering_id
      WHERE u.id = ${unitId};
    `;
    if (!unit) throw new Error('Unit not found');
    await this.assertVersionEditable(unit.curriculum_version_id);

    const [chapter] = await sql`
      INSERT INTO curriculum_master_chapters (
        unit_id, code, title, description, sequence, estimated_periods, difficulty_level
      ) VALUES (
        ${unitId}, ${code}, ${title}, ${description || null}, ${sequence}, ${estimatedPeriods}, ${difficultyLevel}
      ) RETURNING *;
    `;
    return chapter;
  }

  static async addLesson({ chapterId, code, title, description, sequence = 1, lessonType = 'THEORY', estimatedMinutes = 45, teacherGuidance, studentSummary, isOptional = false }) {
    const [chap] = await sql`
      SELECT co.curriculum_version_id
      FROM curriculum_master_chapters ch
      JOIN curriculum_master_units u ON u.id = ch.unit_id
      JOIN curriculum_offerings co ON co.id = u.offering_id
      WHERE ch.id = ${chapterId};
    `;
    if (!chap) throw new Error('Chapter not found');
    await this.assertVersionEditable(chap.curriculum_version_id);

    const [lesson] = await sql`
      INSERT INTO curriculum_master_lessons (
        chapter_id, code, title, description, sequence, lesson_type,
        estimated_minutes, teacher_guidance, student_summary, is_optional
      ) VALUES (
        ${chapterId}, ${code}, ${title}, ${description || null}, ${sequence}, ${lessonType},
        ${estimatedMinutes}, ${teacherGuidance || null}, ${studentSummary || null}, ${Boolean(isOptional)}
      ) RETURNING *;
    `;
    return lesson;
  }

  // Convenience aliases for testing & SDK callers
  static async createOffering(versionIdOrPayload, maybePayload = {}) {
    const payload = typeof versionIdOrPayload === 'object' ? versionIdOrPayload : { versionId: versionIdOrPayload, ...maybePayload };
    return this.addOffering(payload);
  }

  static async createUnit(offeringIdOrPayload, maybePayload = {}) {
    const payload = typeof offeringIdOrPayload === 'object' ? offeringIdOrPayload : { offeringId: offeringIdOrPayload, ...maybePayload };
    return this.addUnit(payload);
  }

  static async createChapter(unitIdOrPayload, maybePayload = {}) {
    const payload = typeof unitIdOrPayload === 'object' ? unitIdOrPayload : { unitId: unitIdOrPayload, ...maybePayload };
    return this.addChapter(payload);
  }

  static async createLesson(chapterIdOrPayload, maybePayload = {}) {
    const payload = typeof chapterIdOrPayload === 'object' ? chapterIdOrPayload : { chapterId: chapterIdOrPayload, ...maybePayload };
    return this.addLesson(payload);
  }

  static async getFullTree(versionId) {
    const version = await this.getVersionById(versionId);
    const offerings = await this.getVersionTree({ versionId });
    return { version, offerings };
  }

  static async logAudit({ actorId, actorType = 'USER', schoolId = null, action, entityType, entityId, beforeState = null, afterState = null, reason = null, requestId = null, ipAddress = null }) {
    try {
      await sql`
        INSERT INTO curriculum_audit_logs (
          actor_id, actor_type, school_id, action, entity_type, entity_id,
          before_state, after_state, reason, request_id, ip_address
        ) VALUES (
          ${actorId || null}, ${actorType}, ${schoolId}, ${action}, ${entityType}, ${entityId || null},
          ${beforeState ? sql.json(beforeState) : null},
          ${afterState ? sql.json(afterState) : null},
          ${reason}, ${requestId}, ${ipAddress ? ipAddress.split(',')[0].trim() : null}
        );
      `;
    } catch (e) {
      console.warn('[CurriculumAudit] Log error:', e.message);
    }
  }
}

module.exports = CurriculumMasterService;

const crypto = require('crypto');
const sql = require('../config/db');
const CurriculumMasterService = require('./curriculumMasterService');

/**
 * Service responsible for Curriculum Review Gates, Snapshot Serialization,
 * Cryptographic Checksumming, and Atomic Immutable Publication.
 */
class CurriculumPublicationService {

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. REVIEW WORKFLOW
  // ══════════════════════════════════════════════════════════════════════════════

  static async submitForReview(versionId, userId) {
    const [version] = await sql`SELECT status, version_label FROM curriculum_versions WHERE id = ${versionId}`;
    if (!version) throw new Error('Version not found');

    if (version.status !== 'DRAFT' && version.status !== 'CHANGES_REQUESTED') {
      const err = new Error(`Cannot submit version ${version.version_label} for review: current status is '${version.status}'`);
      err.statusCode = 409;
      err.code = 'INVALID_STATUS_TRANSITION';
      throw err;
    }

    const [updated] = await sql`
      UPDATE curriculum_versions
      SET status = 'IN_REVIEW', submitted_by = ${userId || null}, submitted_at = now(), updated_at = now()
      WHERE id = ${versionId}
      RETURNING *;
    `;

    await CurriculumMasterService.logAudit({
      actorId: userId,
      actorType: 'SUPER_ADMIN',
      action: 'CURRICULUM_REVIEW_SUBMITTED',
      entityType: 'VERSION',
      entityId: versionId,
      reason: 'Submitted version for multi-disciplinary review'
    });

    return updated;
  }

  static async addReview(versionId, { reviewType, summary, status = 'IN_PROGRESS', reviewerId }) {
    const [review] = await sql`
      INSERT INTO curriculum_reviews (
        curriculum_version_id, review_type, reviewer_id, status, summary,
        started_at, completed_at
      ) VALUES (
        ${versionId}, ${reviewType}, ${reviewerId}, ${status}, ${summary || null},
        now(), ${status === 'APPROVED' || status === 'CHANGES_REQUESTED' ? sql`now()` : null}
      )
      ON CONFLICT (curriculum_version_id, review_type, reviewer_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        completed_at = CASE WHEN EXCLUDED.status IN ('APPROVED', 'CHANGES_REQUESTED') THEN now() ELSE curriculum_reviews.completed_at END,
        updated_at = now()
      RETURNING *;
    `;
    return review;
  }

  static async addComment(versionId, { reviewId, entityType, entityId, fieldPath, severity = 'REQUIRED_CHANGE', comment, createdBy }) {
    const [reviewComment] = await sql`
      INSERT INTO curriculum_review_comments (
        curriculum_version_id, review_id, entity_type, entity_id, field_path,
        severity, comment, status, created_by
      ) VALUES (
        ${versionId}, ${reviewId || null}, ${entityType}, ${entityId}, ${fieldPath || null},
        ${severity}, ${comment}, 'OPEN', ${createdBy}
      )
      RETURNING *;
    `;
    return reviewComment;
  }

  static async resolveComment(commentId, { resolvedBy, resolutionNotes }) {
    const [comment] = await sql`
      UPDATE curriculum_review_comments
      SET status = 'RESOLVED', resolved_by = ${resolvedBy}, resolved_at = now(), resolution_notes = ${resolutionNotes || 'Resolved'}
      WHERE id = ${commentId}
      RETURNING *;
    `;
    return comment;
  }

  static async listComments(versionId) {
    return sql`
      SELECT c.*, u.email as author_email
      FROM curriculum_review_comments c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.curriculum_version_id = ${versionId}
      ORDER BY 
        CASE c.severity WHEN 'BLOCKER' THEN 1 WHEN 'REQUIRED_CHANGE' THEN 2 WHEN 'SUGGESTION' THEN 3 ELSE 4 END ASC,
        c.created_at DESC;
    `;
  }

  static async approveVersion(versionId, userId) {
    const [version] = await sql`SELECT status, version_label FROM curriculum_versions WHERE id = ${versionId}`;
    if (!version) throw new Error('Version not found');

    if (version.status !== 'IN_REVIEW') {
      const err = new Error(`Cannot approve version ${version.version_label}: current status is '${version.status}', expected 'IN_REVIEW'`);
      err.statusCode = 409;
      err.code = 'INVALID_STATUS_TRANSITION';
      throw err;
    }

    // Gate 1: Check for open BLOCKER comments
    const [blockers] = await sql`
      SELECT count(*)::int as count 
      FROM curriculum_review_comments
      WHERE curriculum_version_id = ${versionId} AND status = 'OPEN' AND severity = 'BLOCKER';
    `;
    if (blockers.count > 0) {
      const err = new Error(`Approval blocked: Version has ${blockers.count} unresolved BLOCKER comment(s)`);
      err.statusCode = 409;
      err.code = 'CURRICULUM_REVIEW_BLOCKED';
      throw err;
    }

    const [updated] = await sql`
      UPDATE curriculum_versions
      SET status = 'APPROVED', approved_by = ${userId || null}, approved_at = now(), updated_at = now()
      WHERE id = ${versionId}
      RETURNING *;
    `;

    await CurriculumMasterService.logAudit({
      actorId: userId,
      actorType: 'SUPER_ADMIN',
      action: 'CURRICULUM_VERSION_APPROVED',
      entityType: 'VERSION',
      entityId: versionId,
      reason: 'All review gates passed, version approved for release'
    });

    return updated;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. ATOMIC PUBLICATION & SNAPSHOT SERIALIZATION
  // ══════════════════════════════════════════════════════════════════════════════

  static async publishVersion(versionId, { releaseNotes, publishedBy }) {
    return await sql.begin(async (tx) => {
      // 1. Lock version row
      const [version] = await tx`
        SELECT * FROM curriculum_versions WHERE id = ${versionId} FOR UPDATE;
      `;
      if (!version) {
        const err = new Error('Version not found');
        err.statusCode = 404;
        throw err;
      }

      if (version.status === 'PUBLISHED') {
        const err = new Error('Version is already published and immutable');
        err.statusCode = 409;
        err.code = 'ALREADY_PUBLISHED';
        throw err;
      }

      if (version.status !== 'APPROVED') {
        const err = new Error(`Version status must be 'APPROVED' before publication. Current: '${version.status}'`);
        err.statusCode = 409;
        err.code = 'CURRICULUM_PUBLICATION_FAILED';
        throw err;
      }

      // 2. Revalidate zero open blockers
      const [blockers] = await tx`
        SELECT count(*)::int as count 
        FROM curriculum_review_comments
        WHERE curriculum_version_id = ${versionId} AND status = 'OPEN' AND severity = 'BLOCKER';
      `;
      if (blockers.count > 0) {
        const err = new Error(`Publication halted: Found ${blockers.count} unresolved BLOCKER comment(s)`);
        err.statusCode = 409;
        err.code = 'CURRICULUM_REVIEW_BLOCKED';
        throw err;
      }

      // 3. Validate pedagogical hierarchy integrity
      const [offeringsCount] = await tx`SELECT count(*)::int as count FROM curriculum_offerings WHERE curriculum_version_id = ${versionId}`;
      if (offeringsCount.count === 0) {
        const err = new Error('Cannot publish curriculum version with zero offerings');
        err.statusCode = 422;
        err.code = 'EMPTY_CURRICULUM_VERSION';
        throw err;
      }

      // 4. Build canonical tree representation
      const tree = await CurriculumMasterService.getVersionTree({ versionId });
      const canonicalJson = JSON.stringify(tree);
      const checksum = crypto.createHash('sha256').update(canonicalJson).digest('hex');

      // 5. Count entities
      const [unitsCount] = await tx`
        SELECT count(*)::int as count 
        FROM curriculum_master_units u 
        JOIN curriculum_offerings o ON o.id = u.offering_id 
        WHERE o.curriculum_version_id = ${versionId};
      `;
      const [lessonsCount] = await tx`
        SELECT count(*)::int as count 
        FROM curriculum_master_lessons l
        JOIN curriculum_master_chapters ch ON ch.id = l.chapter_id
        JOIN curriculum_master_units u ON u.id = ch.unit_id
        JOIN curriculum_offerings o ON o.id = u.offering_id
        WHERE o.curriculum_version_id = ${versionId};
      `;

      const entityCount = {
        offerings: offeringsCount.count,
        units: unitsCount.count,
        lessons: lessonsCount.count
      };

      // 6. Insert Publication Record
      const [pub] = await tx`
        INSERT INTO curriculum_publications (
          curriculum_version_id, published_by, published_at, checksum, release_notes
        ) VALUES (
          ${versionId}, ${publishedBy || null}, now(), ${checksum}, ${releaseNotes || version.release_notes || null}
        )
        RETURNING *;
      `;

      // 7. Insert Canonical Snapshot Record
      await tx`
        INSERT INTO curriculum_version_snapshots (
          curriculum_version_id, snapshot_data, entity_count, checksum
        ) VALUES (
          ${versionId}, ${tx.json(tree)}, ${tx.json(entityCount)}, ${checksum}
        );
      `;

      // 8. Mark Version as PUBLISHED
      const [publishedVersion] = await tx`
        UPDATE curriculum_versions
        SET status = 'PUBLISHED', published_at = now(), published_by = ${publishedBy || null}, checksum = ${checksum}, updated_at = now()
        WHERE id = ${versionId}
        RETURNING *;
      `;

      // 9. Mark prior version SUPERSEDED if this is a minor/major increment
      if (version.based_on_version_id) {
        await tx`
          UPDATE curriculum_versions
          SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now()
          WHERE id = ${version.based_on_version_id} AND status = 'PUBLISHED';
        `;
      }

      await CurriculumMasterService.logAudit({
        actorId: publishedBy,
        actorType: 'SUPER_ADMIN',
        action: 'CURRICULUM_PUBLISHED',
        entityType: 'VERSION',
        entityId: versionId,
        afterState: { version: publishedVersion.version_label, checksum, entityCount },
        reason: `Published immutable release ${publishedVersion.version_label}`
      });

      return {
        publication: pub,
        version: publishedVersion,
        checksum,
        entityCount
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. VERSION WITHDRAWAL
  // ══════════════════════════════════════════════════════════════════════════════

  static async withdrawVersion(versionId, { reason, replacementVersionId, withdrawnBy }) {
    return await sql.begin(async (tx) => {
      const [version] = await tx`SELECT * FROM curriculum_versions WHERE id = ${versionId} FOR UPDATE;`;
      if (!version) throw new Error('Version not found');

      if (version.status !== 'PUBLISHED') {
        const err = new Error(`Only published versions can be withdrawn. Current: '${version.status}'`);
        err.statusCode = 409;
        throw err;
      }

      const [withdrawn] = await tx`
        UPDATE curriculum_versions
        SET status = 'WITHDRAWN', withdrawn_at = now(), updated_at = now()
        WHERE id = ${versionId}
        RETURNING *;
      `;

      // Find all affected school assignments
      const affectedAssignments = await tx`
        SELECT 
          sca.id AS assignment_id,
          sca.school_id,
          s.name AS school_name,
          s.code AS school_code,
          ay.name AS academic_year_name
        FROM school_curriculum_assignments sca
        JOIN schools s ON s.id = sca.school_id
        JOIN academic_years ay ON ay.id = sca.academic_year_id
        WHERE sca.curriculum_version_id = ${versionId} AND sca.status = 'ACTIVE';
      `;

      await CurriculumMasterService.logAudit({
        actorId: withdrawnBy,
        actorType: 'SUPER_ADMIN',
        action: 'CURRICULUM_WITHDRAWN',
        entityType: 'VERSION',
        entityId: versionId,
        afterState: { withdrawn: true, reason, affectedCount: affectedAssignments.length },
        reason: `Emergency withdrawal of version ${version.version_label}: ${reason}`
      });

      return {
        version: withdrawn,
        affectedSchoolsCount: affectedAssignments.length,
        affectedSchools: affectedAssignments,
        recommendedReplacementId: replacementVersionId || null
      };
    });
  }
}

module.exports = CurriculumPublicationService;

const sql = require('../config/db');
const authoringClient = require('./curriculumAuthoringClient');

class CurriculumPublicationService {
  static submitForReview(versionId, input = {}) {
    return authoringClient.submitForReview(versionId, input.authorization);
  }

  static addReview(versionId, input = {}) {
    return authoringClient.addReview(versionId, input.authorization, {
      review_type: input.reviewType || input.review_type,
      summary: input.summary,
      status: input.status || 'IN_PROGRESS',
    });
  }

  static addComment(versionId, input = {}) {
    return authoringClient.addComment(versionId, input.authorization, {
      review_id: input.reviewId || input.review_id,
      entity_type: input.entityType || input.targetEntityType || input.entity_type,
      entity_id: input.entityId || input.targetEntityId || input.entity_id,
      field_path: input.fieldPath || input.field_path,
      severity: input.severity,
      comment: input.comment,
    });
  }

  static resolveComment(commentId, input = {}) {
    return authoringClient.resolveComment(commentId, input.authorization, {
      resolution_notes: input.resolutionNotes || input.resolution_notes,
    });
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

  static approveVersion(versionId, input = {}) {
    return authoringClient.approveVersion(versionId, input.authorization);
  }

  static publishVersion(versionId, input = {}) {
    return authoringClient.publishVersion(versionId, input.authorization, {
      release_notes: input.releaseNotes || input.release_notes,
    });
  }

  static withdrawVersion(versionId, input = {}) {
    return authoringClient.withdrawVersion(versionId, input.authorization, {
      reason: input.reason,
      recommended_replacement_version_id: input.replacementVersionId || input.recommended_replacement_version_id,
    });
  }
}

module.exports = CurriculumPublicationService;

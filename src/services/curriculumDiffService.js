const sql = require('../config/db');
const CurriculumMasterService = require('./curriculumMasterService');

/**
 * Service to compute granular 2-way and field-level diffs between two Curriculum Versions.
 */
class CurriculumDiffService {

  static async compareVersions(versionIdA, versionIdB) {
    const [treeA, treeB] = await Promise.all([
      CurriculumMasterService.getVersionTree({ versionId: versionIdA }),
      CurriculumMasterService.getVersionTree({ versionId: versionIdB })
    ]);

    const changes = [];
    const summary = { added: 0, removed: 0, modified: 0, reordered: 0, unchanged: 0 };

    // Index Version A nodes by semantic path:
    // offering: `${standard_grade_level}:${canonical_subject_code}`
    // unit: `${offering_key}:${unit_code}`
    // chapter: `${unit_key}:${chapter_code}`
    // lesson: `${chapter_key}:${lesson_code}`

    const mapA = this.flattenTree(treeA);
    const mapB = this.flattenTree(treeB);

    // 1. Check for modified and removed items from A
    for (const [key, itemA] of mapA.entries()) {
      if (!mapB.has(key)) {
        summary.removed++;
        changes.push({
          entityType: itemA.entityType,
          entityId: itemA.id,
          key,
          changeType: 'REMOVED',
          before: itemA
        });
      } else {
        const itemB = mapB.get(key);
        const fieldDiff = this.diffFields(itemA, itemB);
        if (fieldDiff.length > 0) {
          const isReorder = fieldDiff.length === 1 && fieldDiff[0].field === 'sequence';
          if (isReorder) {
            summary.reordered++;
            changes.push({
              entityType: itemA.entityType,
              entityId: itemB.id,
              key,
              changeType: 'REORDERED',
              fields: fieldDiff
            });
          } else {
            summary.modified++;
            changes.push({
              entityType: itemA.entityType,
              entityId: itemB.id,
              key,
              changeType: 'MODIFIED',
              fields: fieldDiff
            });
          }
        } else {
          summary.unchanged++;
        }
      }
    }

    // 2. Check for added items in B
    for (const [key, itemB] of mapB.entries()) {
      if (!mapA.has(key)) {
        summary.added++;
        changes.push({
          entityType: itemB.entityType,
          entityId: itemB.id,
          key,
          changeType: 'ADDED',
          after: itemB
        });
      }
    }

    return {
      summary,
      changes
    };
  }

  static flattenTree(tree) {
    const map = new Map();

    for (const off of tree) {
      const offKey = `OFFERING:${off.standard_grade_level}:${off.canonical_subject_code}`;
      map.set(offKey, {
        entityType: 'OFFERING',
        id: off.offering_id,
        sequence: off.offering_sequence,
        weekly_periods: off.weekly_periods,
        canonical_subject_name: off.canonical_subject_name
      });

      for (const u of (off.units || [])) {
        const uKey = `${offKey}/UNIT:${u.code}`;
        map.set(uKey, {
          entityType: 'UNIT',
          id: u.id,
          code: u.code,
          title: u.title,
          sequence: u.sequence,
          estimated_periods: u.estimated_periods
        });

        for (const ch of (u.chapters || [])) {
          const chKey = `${uKey}/CHAPTER:${ch.code}`;
          map.set(chKey, {
            entityType: 'CHAPTER',
            id: ch.id,
            code: ch.code,
            title: ch.title,
            sequence: ch.sequence,
            difficulty_level: ch.difficulty_level,
            estimated_periods: ch.estimated_periods
          });

          for (const l of (ch.lessons || [])) {
            const lKey = `${chKey}/LESSON:${l.code}`;
            map.set(lKey, {
              entityType: 'LESSON',
              id: l.id,
              code: l.code,
              title: l.title,
              sequence: l.sequence,
              lesson_type: l.lesson_type,
              estimated_minutes: l.estimated_minutes,
              teacher_guidance: l.teacher_guidance,
              student_summary: l.student_summary,
              is_optional: l.is_optional
            });
          }
        }
      }
    }

    return map;
  }

  static diffFields(a, b) {
    const diffs = [];
    const ignored = new Set(['id', 'entityType']);

    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of allKeys) {
      if (ignored.has(k)) continue;
      const valA = a[k] !== undefined ? a[k] : null;
      const valB = b[k] !== undefined ? b[k] : null;

      if (JSON.stringify(valA) !== JSON.stringify(valB)) {
        diffs.push({
          field: k,
          before: valA,
          after: valB
        });
      }
    }
    return diffs;
  }
}

module.exports = CurriculumDiffService;

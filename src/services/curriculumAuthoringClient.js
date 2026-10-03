const { schoolPublicApiUrl } = require('../config/schoolPublicApi');

function apiBase() {
  const explicit = String(process.env.SCHOOL_CURRICULUM_API_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return schoolPublicApiUrl();
}

function authorizationHeader(input) {
  const header = input?.authorization || input?.Authorization;
  if (!header) {
    const err = new Error('Workforce authorization is required for curriculum writes');
    err.statusCode = 401;
    err.code = 'AUTHORING_AUTH_REQUIRED';
    throw err;
  }
  return header;
}

async function request(method, path, { authorization, body, idempotencyKey } = {}) {
  const response = await fetch(`${apiBase()}/curriculum/authoring${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization,
      ...(idempotencyKey ? {'Idempotency-Key':idempotencyKey}:{}),
    },
    signal: AbortSignal.timeout(25000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json.error || 'Curriculum authoring failed');
    err.statusCode = response.status;
    err.current = json.current;
    err.code = json.code || 'CURRICULUM_AUTHORING_FAILED';
    throw err;
  }
  return json.data;
}

const CurriculumAuthoringClient = {
  assignment(schoolId,operation,authorization,body,idempotencyKey){
    if(!Number.isSafeInteger(Number(schoolId))||Number(schoolId)<=0||!['assign','upgrade','withdraw','preview-upgrade'].includes(operation))throw Object.assign(new Error('Invalid deployment target'),{statusCode:422});
    return request('POST',`/schools/${Number(schoolId)}/assignments/${operation}`,{authorization,body,idempotencyKey});
  },
  createProduct(input) {
    return request('POST', '/products', {
      authorization: authorizationHeader(input),
      body: {
        code: input.code,
        name: input.name,
        description: input.description,
        board_or_framework: input.board_or_framework || input.boardOrFramework,
        curriculum_type: input.curriculum_type || input.curriculumType,
        default_language: input.default_language || input.defaultLanguage,
        supported_languages: input.supported_languages || input.supportedLanguages,
      },
    });
  },

  createVersion(input) {
    return request('POST', `/products/${input.productId}/versions`, {
      authorization: authorizationHeader(input),
      body: {
        version_type: input.versionType || input.version_type,
        release_name: input.releaseName || input.release_name,
        release_notes: input.releaseNotes || input.release_notes,
        based_on_version_id: input.basedOnVersionId || input.cloneFromVersionId || input.based_on_version_id,
        major: input.major,
        minor: input.minor,
        patch: input.patch,
      },
    });
  },

  createOffering(input) {
    return request('POST', `/versions/${input.versionId}/offerings`, {
      authorization: authorizationHeader(input),
      body: {
        standard_grade_level: input.standardGradeLevel || input.standard_grade_level,
        canonical_subject_code: input.canonicalSubjectCode || input.canonical_subject_code,
        canonical_subject_name: input.canonicalSubjectName || input.canonical_subject_name || input.title,
        subject_type: input.subjectType || input.subject_type,
        sequence: input.sequence,
        weekly_periods: input.weeklyPeriods || input.academicPeriodsPerWeek || input.weekly_periods,
      },
    });
  },

  createUnit(input) {
    return request('POST', `/offerings/${input.offeringId}/units`, {
      authorization: authorizationHeader(input),
      body: {
        code: input.code,
        title: input.title,
        description: input.description,
        sequence: input.sequence,
        estimated_periods: input.estimatedPeriods || input.estimated_periods,
      },
    });
  },

  createChapter(input) {
    return request('POST', `/units/${input.unitId}/chapters`, {
      authorization: authorizationHeader(input),
      body: {
        code: input.code,
        title: input.title,
        description: input.description,
        sequence: input.sequence,
        estimated_periods: input.estimatedPeriods || input.estimated_periods,
        difficulty_level: input.difficultyLevel || input.difficulty_level,
      },
    });
  },

  createLesson(input) {
    return request('POST', `/chapters/${input.chapterId}/lessons`, {
      authorization: authorizationHeader(input),
      body: {
        code: input.code,
        title: input.title,
        description: input.description,
        sequence: input.sequence,
        lesson_type: input.lessonType || input.lesson_type,
        estimated_minutes: input.estimatedMinutes || input.estimated_minutes,
        teacher_guidance: input.teacherGuidance || input.teacher_guidance,
        student_summary: input.studentSummary || input.student_summary,
        is_optional: input.isOptional || input.is_optional,
      },
    });
  },

  submitForReview(versionId, authorization) {
    return request('POST', `/versions/${versionId}/submit-review`, { authorization, body: {} });
  },

  addReview(versionId, authorization, body) {
    return request('POST', `/versions/${versionId}/reviews`, { authorization, body });
  },

  addComment(versionId, authorization, body) {
    return request('POST', `/versions/${versionId}/comments`, { authorization, body });
  },

  resolveComment(commentId, authorization, body) {
    return request('PATCH', `/comments/${commentId}/resolve`, { authorization, body });
  },

  approveVersion(versionId, authorization) {
    return request('POST', `/versions/${versionId}/approve`, { authorization, body: {} });
  },

  publishVersion(versionId, authorization, body) {
    return request('POST', `/versions/${versionId}/publish`, { authorization, body });
  },

  withdrawVersion(versionId, authorization, body) {
    return request('POST', `/versions/${versionId}/withdraw`, { authorization, body });
  },
};

module.exports = CurriculumAuthoringClient;

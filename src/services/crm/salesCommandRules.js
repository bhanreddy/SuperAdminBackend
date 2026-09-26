/**
 * Founder Sales Command rule version 1.
 * Pure thresholds and classifiers. SQL receives these numbers as parameters
 * so dashboard metadata and query predicates stay on one policy.
 */
const RULE_VERSION = 1;
const SCHEMA_VERSION = 1;
const HIGH_VALUE_INR = '100000.00';
const SEVERE_FOLLOWUP_SECONDS = 72 * 60 * 60;
const DAY_SECONDS = 86400;

const STAGE_STALE_DAYS = {
  NEW: 2,
  CONTACTED: 7,
  QUALIFIED: 7,
  DEMO: 7,
  PROPOSAL: 14,
  NEGOTIATION: 14,
};

const SALES_TASK_TYPES = ['FOLLOW_UP', 'CALL', 'EMAIL', 'MEETING'];
const OPEN_TASK_STATUSES = ['OPEN', 'IN_PROGRESS'];
const SCHOOL_ALIASES = ['SCHOOL', 'SCHOOLIMS'];
const OTHER_VERTICALS = ['MEDICAL', 'RETAIL', 'OTHER'];
const QUALIFIED_PLUS = ['QUALIFIED', 'DEMO', 'PROPOSAL', 'NEGOTIATION', 'PILOT'];

const SEVERITY = {
  FOLLOWUP_SEVERE: 100,
  FOLLOWUP_OVERDUE: 90,
  PILOT_DECISION_OVERDUE: 85,
  PILOT_END_OVERDUE: 85,
  HIGH_VALUE_NO_CONTACT: 80,
  DEMO_WITHOUT_PROPOSAL: 75,
  PROPOSAL_NO_RESPONSE: 70,
  PILOT_ENDING: 65,
  STAGE_STALE: 60,
  MISSING_NEXT_ACTION: 60,
  OWNER_INACTIVE: 60,
  INTAKE_UNASSIGNED: 55,
  LOSS_REVIEW: 50,
  CONTACTLESS_INTAKE: 45,
  DATA_QUALITY: 40,
};

const SUGGESTED_ACTION = {
  FOLLOWUP_SEVERE: 'Complete or reschedule the follow-up and record the reason.',
  FOLLOWUP_OVERDUE: 'Contact the school or complete the follow-up.',
  PILOT_DECISION_OVERDUE: 'Record the conversion decision for the completed pilot.',
  PILOT_END_OVERDUE: 'Record the pilot completion or an extension.',
  HIGH_VALUE_NO_CONTACT: 'Contact the decision maker.',
  DEMO_WITHOUT_PROPOSAL: 'Prepare and record a sent proposal. A draft does not clear this.',
  PROPOSAL_NO_RESPONSE: 'Request a response. A sent record is not proof of delivery.',
  PILOT_ENDING: 'Arrange the decision meeting.',
  STAGE_STALE: 'Inspect the stage and the next action.',
  MISSING_NEXT_ACTION: 'Schedule the next action.',
  OWNER_INACTIVE: 'Reassign or review the owner. Unknown actor mapping is not inactivity.',
  INTAKE_UNASSIGNED: 'Assign an owner or research the school.',
  LOSS_REVIEW: 'Record a review. Do not invent a loss reason.',
  CONTACTLESS_INTAKE: 'Research a usable contact channel.',
  DATA_QUALITY: 'Repair the record. This is not a proven overdue or high-value signal.',
};

const AGING_BUCKETS = [
  { id: '0_2', label: '0–2 days', minDays: 0, maxDays: 2 },
  { id: '3_7', label: '3–7 days', minDays: 3, maxDays: 7 },
  { id: '8_14', label: '8–14 days', minDays: 8, maxDays: 14 },
  { id: '15_30', label: '15–30 days', minDays: 15, maxDays: 30 },
  { id: '31_plus', label: '31+ days', minDays: 31, maxDays: null },
  { id: 'unknown', label: 'Unknown', minDays: null, maxDays: null },
];

function agingBucket(elapsedSeconds) {
  if (elapsedSeconds == null || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return 'unknown';
  const days = Math.floor(elapsedSeconds / DAY_SECONDS);
  if (days <= 2) return '0_2';
  if (days <= 7) return '3_7';
  if (days <= 14) return '8_14';
  if (days <= 30) return '15_30';
  return '31_plus';
}

function classifyFollowUp({
  status,
  dueAt,
  now,
  nextLocalMidnight,
  parentOpen,
  assigneeActive,
  dueValid,
}) {
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (parentOpen === false) return 'NOT_APPLICABLE';
  if (!dueValid || assigneeActive === false || dueAt == null) return 'DATA_QUALITY';
  const due = new Date(dueAt).getTime();
  const t = new Date(now).getTime();
  const midnight = new Date(nextLocalMidnight).getTime();
  if (Number.isNaN(due) || Number.isNaN(t) || Number.isNaN(midnight)) return 'DATA_QUALITY';
  if (due <= t - SEVERE_FOLLOWUP_SECONDS * 1000) return 'SEVERELY_OVERDUE';
  if (due < t) return 'OVERDUE';
  if (due >= t && due < midnight) return 'DUE_TODAY';
  if (due >= midnight) return 'UPCOMING';
  return 'DATA_QUALITY';
}

function changeRatio(current, previous) {
  if (previous == null) return { change_ratio: null, comparison_note: 'no comparable baseline' };
  const prev = Number(previous);
  const cur = Number(current);
  if (!Number.isFinite(prev) || !Number.isFinite(cur)) return { change_ratio: null, comparison_note: 'no comparable baseline' };
  if (prev === 0) return { change_ratio: null, comparison_note: 'no comparable baseline' };
  return { change_ratio: (cur - prev) / prev, comparison_note: null };
}

function percentRatio(numerator, denominator, evidenceComplete) {
  if (!evidenceComplete || denominator === 0 || denominator == null || numerator == null) {
    return null;
  }
  return numerator / denominator;
}

function attentionPriority(row, other) {
  if (row.severity !== other.severity) return other.severity - row.severity;
  if (row.age_seconds !== other.age_seconds) return other.age_seconds - row.age_seconds;
  const created = new Date(row.created_at).getTime() - new Date(other.created_at).getTime();
  if (created !== 0) return created;
  return String(row.entity_key).localeCompare(String(other.entity_key));
}

function stageIsStale(stage, ageSeconds, pilotPlannedEnd, now) {
  if (ageSeconds == null) return false;
  if (stage === 'PILOT') {
    if (!pilotPlannedEnd) return false;
    return new Date(now).getTime() >= new Date(pilotPlannedEnd).getTime() + 2 * DAY_SECONDS * 1000;
  }
  const days = STAGE_STALE_DAYS[stage];
  if (!days) return false;
  return ageSeconds >= days * DAY_SECONDS;
}

module.exports = {
  RULE_VERSION,
  SCHEMA_VERSION,
  HIGH_VALUE_INR,
  SEVERE_FOLLOWUP_SECONDS,
  DAY_SECONDS,
  STAGE_STALE_DAYS,
  SALES_TASK_TYPES,
  OPEN_TASK_STATUSES,
  SCHOOL_ALIASES,
  OTHER_VERTICALS,
  QUALIFIED_PLUS,
  SEVERITY,
  SUGGESTED_ACTION,
  AGING_BUCKETS,
  agingBucket,
  classifyFollowUp,
  changeRatio,
  percentRatio,
  attentionPriority,
  stageIsStale,
};

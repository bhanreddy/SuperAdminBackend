const { ROLES } = require("../../config/rbac");
const CHANNELS = [
  ["announcements", "Announcements", "Company updates and role announcements"],
  [
    "security",
    "Account & security",
    "Account access, credentials and permission changes",
  ],
  ["assignments", "My work", "Assignments, onboarding milestones and blockers"],
  ["support", "Support", "Ticket assignments, status changes and escalations"],
  ["sales", "Sales & CRM", "Sales tasks and school intake updates"],
  ["finance", "Finance", "Billing and accounting activity"],
  ["payroll", "Payroll", "Payroll processing and payment updates"],
  [
    "approvals",
    "Requirements & approvals",
    "School requests and review decisions",
  ],
  [
    "deployments",
    "Builds & deployments",
    "School configuration and package jobs",
  ],
  ["curriculum", "Curriculum", "Curriculum release activity"],
  [
    "connect",
    "NexSyrus Connect",
    "Mentions, direct messages, threads and announcements",
  ],
  ["system", "System", "Other updates addressed to you"],
].map(([id, label, description]) => ({
  id,
  label,
  description,
  mandatory: id === "security",
}));
const CHANNEL_IDS = CHANNELS.map((c) => c.id);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
function uuid(value) {
  check(
    typeof value === "string" && UUID.test(value),
    "Invalid notification identifier",
  );
  return value;
}
function channel(value) {
  check(CHANNEL_IDS.includes(value), "Unknown notification channel");
  return value;
}
function text(value, max) {
  check(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= max,
    `Text must contain 1–${max} characters`,
  );
  return value.trim();
}
function preferences(body) {
  check(
    body && typeof body === "object" && !Array.isArray(body),
    "Invalid preferences",
  );
  const result = {};
  for (const key of [
    "inbox_enabled",
    "email_enabled",
    "push_enabled",
    "sms_enabled",
  ]) {
    if (body[key] !== undefined) {
      check(typeof body[key] === "boolean", `${key} must be boolean`);
      result[key] = body[key];
    }
  }
  check(Object.keys(result).length > 0, "No preferences supplied");
  return result;
}
function announcement(body, key) {
  check(
    typeof key === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(key),
    "A 16–100 character Idempotency-Key is required",
  );
  check(body && typeof body === "object", "Invalid announcement");
  const roles = body.roles === undefined ? [] : body.roles;
  check(
    Array.isArray(roles) &&
      roles.length <= Object.keys(ROLES).length &&
      roles.every((r) => Object.values(ROLES).includes(r)),
    "Invalid audience roles",
  );
  check(
    body.priority === undefined || ["normal", "high"].includes(body.priority),
    "Invalid announcement priority",
  );
  return {
    title: text(body.title, 160),
    body: text(body.body, 2000),
    roles: [...new Set(roles)].sort(),
    priority: body.priority || "normal",
  };
}
function cursor(value) {
  if (!value) return null;
  try {
    check(typeof value === "string" && value.length <= 300, "Invalid cursor");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    uuid(parsed.id);
    // Preserve PostgreSQL microseconds. JS Date truncation skips tied rows.
    check(
      typeof parsed.at === "string" &&
        /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(parsed.at) &&
        Number.isFinite(Date.parse(parsed.at)),
      "Invalid cursor",
    );
    return parsed;
  } catch {
    throw Object.assign(new Error("Invalid notification cursor"), {
      status: 400,
    });
  }
}
module.exports = {
  CHANNELS,
  CHANNEL_IDS,
  check,
  uuid,
  channel,
  text,
  preferences,
  announcement,
  cursor,
};

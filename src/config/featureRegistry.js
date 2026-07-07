/**
 * FEATURE_REGISTRY — STUDENT-role feature flags (Founder Console side).
 *
 * MUST stay in sync with SchoolIMS-Backend/utils/featureRegistry.js — the two
 * backends deploy separately so the registry is duplicated by necessity.
 * ponytail: single source per deploy; if this drifts, the student app and the
 * console disagree on defaults. Keep the two files identical in key/metadata.
 */

const STUDENT_ROLE = 'student';

const FEATURE_REGISTRY = [
  // drawer
  { key: 'menu.dcgd',             label: 'DCGD',            group: 'drawer',        default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'menu.ai_doubt_assist',  label: 'AI Doubt Assist', group: 'drawer',       default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'menu.insurance',        label: 'Insurance',       group: 'drawer',        default_enabled: true, data_bearing: false, toggleable: true },
  { key: 'menu.money_science',    label: 'Money Science',   group: 'drawer',        default_enabled: true, data_bearing: false, toggleable: true },
  { key: 'menu.girl_safety',      label: 'Girl Safety',     group: 'drawer',        default_enabled: true, data_bearing: false, toggleable: true },
  // quick_actions
  { key: 'quick.announcements',   label: 'Announcements',   group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.complaints',      label: 'Complaints',      group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.life_values',     label: 'Life Values',     group: 'quick_actions', default_enabled: true, data_bearing: false, toggleable: true },
  { key: 'quick.transport',       label: 'Transport',       group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.science_projects',label: 'Science Projects',group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.profile',         label: 'Profile',         group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  // topbar
  { key: 'topbar.diary',          label: 'Diary',           group: 'topbar',        default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'topbar.lms',            label: 'LMS',             group: 'topbar',        default_enabled: true, data_bearing: true,  toggleable: true },
  // home
  { key: 'home.todays_snapshot',  label: "Today's Snapshot (attendance)", group: 'home', default_enabled: true, data_bearing: true, toggleable: true },
  { key: 'home.academic_advisor', label: 'Academic Advisor',group: 'home',          default_enabled: true, data_bearing: true,  toggleable: true },
  // bottom_nav
  { key: 'nav.time_table',        label: 'Time Table',      group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'nav.fees',              label: 'Fees',            group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'nav.results',           label: 'Results',         group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'nav.home',              label: 'Home',            group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: false },
];

const REGISTRY_BY_KEY = new Map(FEATURE_REGISTRY.map((f) => [f.key, f]));
const getFeature = (key) => REGISTRY_BY_KEY.get(key) || null;

/**
 * Full catalog + effective state for a school, given its override rows.
 * overrides: { feature_key: enabled }. Returns one entry per registry feature
 * with { ...meta, enabled (effective), source: 'default' | 'overridden' }.
 */
function resolveCatalog(overrides = {}) {
  return FEATURE_REGISTRY.map((f) => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, f.key);
    return {
      ...f,
      enabled: overridden ? overrides[f.key] : f.default_enabled,
      source: overridden ? 'overridden' : 'default',
    };
  });
}

module.exports = { STUDENT_ROLE, FEATURE_REGISTRY, getFeature, resolveCatalog };

// RED ALERT v3 Sprint Command Center definition and idempotent seeder.
// The task data is imported from the approved 10-day command-center artifact.

const definition = require('../data/redAlertSprintV3.json');

const SPRINT_VERSION = definition.version;
const ROLE_KEYS = Object.keys(definition.roles);

const DAYS_META = [
  {
    day: 1,
    date_label: 'Execution Day 1 of 10',
    title: 'Freeze the battlefield',
    handoff: 'Curriculum freezes the pilot; Sales freezes the ICP; Scale freezes the hiring scorecard; Tech publishes the dependency map.',
    gate: 'Pilot, ICP, technical scope, research instrument, prospect base, and hiring funnel are explicit and reviewable.',
  },
  {
    day: 2,
    date_label: 'Execution Day 2 of 10',
    title: 'Evidence, architecture, and qualification',
    handoff: 'Research and commercial evidence feed the curriculum schema, versioning, RBAC, scripts, and candidate evaluation system.',
    gate: 'Source-backed standards, validated interviews, technical designs, decision-maker paths, and hiring controls exist as artifacts.',
  },
  {
    day: 3,
    date_label: 'Execution Day 3 of 10',
    title: 'Contracts, positioning, and sourcing',
    handoff: 'Curriculum terminology and progression maps become API/import contracts; field language becomes the pitch and discovery system.',
    gate: 'Contracts are implementable, the offer is explainable, and both prospect and candidate pipelines are active.',
  },
  {
    day: 4,
    date_label: 'Execution Day 4 of 10',
    title: 'Prototype the critical workflows',
    handoff: 'Curriculum models drive staff, student, and management prototypes while Sales and Scale turn them into demo and training narratives.',
    gate: 'Core workflows are demonstrable and the assessment, objection, outreach, and certification systems are documented.',
  },
  {
    day: 5,
    date_label: 'Execution Day 5 of 10',
    title: 'Build, validate, and enter the field',
    handoff: 'Gold-standard curriculum content, product flows, brochure proof, and field conversations are reviewed against one shared evidence bar.',
    gate: 'A complete unit works end to end, outreach is logged, decision-maker meetings are real, and sales collateral passes comprehension testing.',
  },
  {
    day: 6,
    date_label: 'Execution Day 6 of 10',
    title: 'Operationalize quality and repeatability',
    handoff: 'Analytics, demo data, QA, authoring, proposals, follow-up sequences, territory design, and KPIs become one operating system.',
    gate: 'The team can demonstrate, measure, review, and repeat the product and commercial process without undocumented work.',
  },
  {
    day: 7,
    date_label: 'Execution Day 7 of 10',
    title: 'Run the system under pressure',
    handoff: 'Live demos and simulations feed CRM architecture, curriculum pacing, rejection taxonomy, certification, and coaching.',
    gate: 'Five complete demos are delivered, feedback is classified, and operating gaps have named owners and next actions.',
  },
  {
    day: 8,
    date_label: 'Execution Day 8 of 10',
    title: 'Scale visibility and control',
    handoff: 'Founder dashboards, attribution, parent visibility, curriculum USPs, pipeline expansion, and candidate shortlists converge into measurable control.',
    gate: 'Leaders can see progress, attribution, pipeline health, curriculum proof, field feedback, and hiring readiness from structured data.',
  },
  {
    day: 9,
    date_label: 'Execution Day 9 of 10',
    title: 'Attack weak assumptions',
    handoff: 'Security and reliability tests, hostile curriculum review, pipeline truth, follow-up enforcement, and hiring diagnostics close critical gaps.',
    gate: 'No unresolved P0/P1 defect remains, forecasts are evidence-based, and the strongest rejection reasons have explicit responses.',
  },
  {
    day: 10,
    date_label: 'Execution Day 10 of 10',
    title: 'Freeze, ship, and hand over',
    handoff: 'All four owners publish their versioned deliverables, unresolved assumptions, measurable outcomes, and 30-day execution backlog.',
    gate: 'RED ALERT v3 is deployed, backed up, measurable, and handed over with Curriculum Framework v1.0, Sales Playbook v1, and Sales Scale Kit v1.',
  },
];

const ALL_TASKS = definition.tasks;

async function ensureRoleConstraint(sql) {
  const [constraint] = await sql`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'sprint_tasks'::regclass
      AND conname = 'sprint_tasks_role_check'
  `;

  const isCurrent = ROLE_KEYS.every((role) => constraint?.definition?.includes(`'${role}'`));
  if (isCurrent) return;

  await sql`ALTER TABLE sprint_tasks DROP CONSTRAINT IF EXISTS sprint_tasks_role_check`;
  await sql`
    ALTER TABLE sprint_tasks
    ADD CONSTRAINT sprint_tasks_role_check
    CHECK (role IN ('tech', 'curr', 'sales', 'scale')) NOT VALID
  `;
}

/**
 * Idempotently installs the current sprint definition.
 * New v3 IDs intentionally start clean; retired sprint tasks are removed only
 * after the replacement rows exist. Historical activity remains available.
 */
async function seedSprintDataIfNeeded(sql) {
  try {
    await ensureRoleConstraint(sql);

    const existingTasks = await sql`SELECT id FROM sprint_tasks`;
    const currentIds = new Set(ALL_TASKS.map((task) => task.id));
    const retiredIds = existingTasks.map((task) => task.id).filter((id) => !currentIds.has(id));

    for (const day of DAYS_META) {
      await sql`
        INSERT INTO sprint_days (day, date_label, title, handoff, gate)
        VALUES (${day.day}, ${day.date_label}, ${day.title}, ${day.handoff}, ${day.gate})
        ON CONFLICT (day) DO UPDATE
        SET date_label = EXCLUDED.date_label,
            title = EXCLUDED.title,
            handoff = EXCLUDED.handoff,
            gate = EXCLUDED.gate
      `;
    }

    for (const task of ALL_TASKS) {
      await sql`
        INSERT INTO sprint_tasks (id, role, num, title, day, orig_day_label, status)
        VALUES (${task.id}, ${task.role}, ${task.num}, ${task.title}, ${task.day}, ${task.orig_day_label}, 'todo')
        ON CONFLICT (id) DO UPDATE
        SET role = EXCLUDED.role,
            num = EXCLUDED.num,
            title = EXCLUDED.title,
            day = EXCLUDED.day,
            orig_day_label = EXCLUDED.orig_day_label
      `;
    }

    for (const id of retiredIds) {
      await sql`DELETE FROM sprint_tasks WHERE id = ${id}`;
    }
    await sql`DELETE FROM sprint_days WHERE day > ${definition.duration_days}`;
    await sql`ALTER TABLE sprint_tasks VALIDATE CONSTRAINT sprint_tasks_role_check`;

    if (retiredIds.length > 0) {
      await sql`
        INSERT INTO sprint_activity_logs (action, details, user_name)
        VALUES (
          'sprint_definition_replaced',
          ${`Installed ${SPRINT_VERSION}: ${definition.duration_days} days, ${ALL_TASKS.length} deliverables, ${retiredIds.length} retired tasks replaced`},
          'System'
        )
      `;
    }

    console.log(`[sprintSeed] ${SPRINT_VERSION} verified: ${DAYS_META.length} days, ${ALL_TASKS.length} deliverables.`);
    return true;
  } catch (err) {
    console.error(`[sprintSeed] Failed to seed ${SPRINT_VERSION}:`, err.message);
    throw err;
  }
}

let sprintReadyPromise = null;

function ensureSprintDataReady(sql) {
  if (!sprintReadyPromise) {
    sprintReadyPromise = seedSprintDataIfNeeded(sql).catch((err) => {
      sprintReadyPromise = null;
      throw err;
    });
  }
  return sprintReadyPromise;
}

module.exports = {
  SPRINT_VERSION,
  ROLE_KEYS,
  DAYS_META,
  ALL_TASKS,
  seedSprintDataIfNeeded,
  ensureSprintDataReady,
};

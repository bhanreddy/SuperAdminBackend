// sprintSeed.js
// 11-Day Sprint Command Center Seed Data and Seeder Utility

const DAYS_META = [
  {
    day: 1,
    date_label: "Sep 20 / Sep 21, 2026",
    title: "Scope, Architectural Boundaries & Lead Sourcing",
    handoff: "Academics locks pilot grades/subjects -> Tech Lead & Content Lead.",
    gate: "Signed off MVP scope document; First 50 school leads in CRM."
  },
  {
    day: 2,
    date_label: "Sep 21 / Sep 22, 2026",
    title: "ER Modeling, Progression Hierarchy & Competitor Recon",
    handoff: "Standardized taxonomy from Academics -> Tech Lead for DB schema mapping.",
    gate: "ER diagram v1.0 approved; Hierarchy vocabulary finalized; Competitor pricing map done."
  },
  {
    day: 3,
    date_label: "Sep 22 / Sep 23, 2026",
    title: "Outcomes, Resource Schemas & Pitch Positioning",
    handoff: "Tech Lead locks multi-tenancy rules; Content & Academics finalize templates.",
    gate: "DB schema DDL drafted; Master lesson planning template validated; Pricing teardown done."
  },
  {
    day: 4,
    date_label: "Sep 23 / Sep 24, 2026",
    title: "Tenancy, Versioning, Evaluation & Outreach Scripts",
    handoff: "Tech Lead shares OpenAPI spec; Content delivers worksheet format to Academics.",
    gate: "OpenAPI contracts locked; QA rubric finalized; Bilingual scripts approved."
  },
  {
    day: 5,
    date_label: "Sep 24 / Sep 25, 2026",
    title: "RBAC, Assessment Blueprint & Cold Outreach Kickoff",
    handoff: "Academics provides Chapter 1 outline to Content Lead for immediate writing.",
    gate: "Backend container boots with DB migrations; 30+ school discovery calls initiated."
  },
  {
    day: 6,
    date_label: "Sep 25 / Sep 26, 2026",
    title: "Offline Sync Specs, DB Migrations & Backend Scaffold",
    handoff: "Content authoring workflow locked; Tech sets up migration pipelines.",
    gate: "Backend repo compiles; Teacher workload report published; Outreach batch 1 logged."
  },
  {
    day: 7,
    date_label: "Sep 26 / Sep 27, 2026",
    title: "Core CRUD APIs, Pilot Drafting & Discovery Scaling",
    handoff: "Micro-objectives to Content Lead; Worksheets to Academics; Demos confirmed.",
    gate: "CRUD & hierarchy APIs passing tests; Chapter 1 Lessons 1–2 drafted; 6+ school demos booked."
  },
  {
    day: 8,
    date_label: "Sep 27 / Sep 28, 2026",
    title: "Data Flow Wiring, Seed Data & Differentiation Paths",
    handoff: "Raw pilot chapter content to Tech Lead for automated database seeding.",
    gate: "Seed script populates DB; Remediation framework documented; Demo pitch deck polished."
  },
  {
    day: 9,
    date_label: "Sep 28 / Sep 29, 2026",
    title: "UI Prototypes, Tenant Security & Live Demos",
    handoff: "Live demo feedback from Sales Lead -> Academics & Content Leads for iteration.",
    gate: "Curriculum UI prototype functional; Tenant isolation verified; 3 live school demos delivered."
  },
  {
    day: 10,
    date_label: "Sep 29 / Sep 30, 2026",
    title: "SchoolIMS Integration, Content Audit & Pilot Shortlist",
    handoff: "Content audit revisions to Tech Lead; Commercial terms requested by Sales.",
    gate: "SchoolIMS SSO bridge operational; Content audit passed; 3-5 pilot schools evaluating MOUs."
  },
  {
    day: 11,
    date_label: "Oct 1, 2026",
    title: "Final Staging Deploy, Executive Showcase & Sign-Off (DEADLINE)",
    handoff: "All 4 Leads deliver unified system, live staging URL, and signed pilot MOUs to Board.",
    gate: "Working prototype live; Framework v1.1 approved; Sales Playbook & Pipeline signed off."
  }
];

const ALL_TASKS = [
  // TECH LEAD (25 tasks)
  { id: "tech-1", role: "tech", num: 1, title: "Analyze current SchoolIMS architecture and identify curriculum integration boundaries.", day: 1, orig_day_label: "Day 1" },
  { id: "tech-2", role: "tech", num: 2, title: "Define the curriculum platform's technical scope and MVP requirements.", day: 1, orig_day_label: "Day 1" },
  { id: "tech-3", role: "tech", num: 3, title: "Design the complete curriculum entity relationship model.", day: 2, orig_day_label: "Day 2" },
  { id: "tech-4", role: "tech", num: 4, title: "Define academic year, grade, subject, unit, chapter, and lesson relationships.", day: 2, orig_day_label: "Day 2" },
  { id: "tech-5", role: "tech", num: 5, title: "Design learning outcomes, competencies, and progression data structures.", day: 3, orig_day_label: "Day 3" },
  { id: "tech-6", role: "tech", num: 6, title: "Design lesson plans, activities, resources, and assessment schemas.", day: 3, orig_day_label: "Day 3" },
  { id: "tech-7", role: "tech", num: 7, title: "Define multi-tenant data isolation using school_id.", day: 3, orig_day_label: "Day 4" },
  { id: "tech-8", role: "tech", num: 8, title: "Design curriculum versioning and publishing architecture.", day: 4, orig_day_label: "Day 4" },
  { id: "tech-9", role: "tech", num: 9, title: "Define admin, teacher, student, and parent access permissions.", day: 4, orig_day_label: "Day 5" },
  { id: "tech-10", role: "tech", num: 10, title: "Document curriculum APIs and integration contracts.", day: 4, orig_day_label: "Day 5" },
  { id: "tech-11", role: "tech", num: 11, title: "Review offline-first requirements for rural school environments.", day: 5, orig_day_label: "Day 6" },
  { id: "tech-12", role: "tech", num: 12, title: "Finalize database migration and deployment strategy.", day: 5, orig_day_label: "Day 6" },
  { id: "tech-13", role: "tech", num: 13, title: "Create the curriculum backend project structure.", day: 6, orig_day_label: "Day 8" },
  { id: "tech-14", role: "tech", num: 14, title: "Implement curriculum data creation and retrieval APIs.", day: 7, orig_day_label: "Days 9–10" },
  { id: "tech-15", role: "tech", num: 15, title: "Implement academic hierarchy management APIs.", day: 7, orig_day_label: "Day 10" },
  { id: "tech-16", role: "tech", num: 16, title: "Implement lesson and activity data flow.", day: 8, orig_day_label: "Days 11–12" },
  { id: "tech-17", role: "tech", num: 17, title: "Create seed data for the pilot curriculum.", day: 8, orig_day_label: "Day 12" },
  { id: "tech-18", role: "tech", num: 18, title: "Build or prototype curriculum management UI/API workflows.", day: 9, orig_day_label: "Days 13–14" },
  { id: "tech-19", role: "tech", num: 19, title: "Implement authorization and tenant-isolation checks.", day: 9, orig_day_label: "Day 15" },
  { id: "tech-20", role: "tech", num: 20, title: "Connect curriculum data to the SchoolIMS integration boundary.", day: 10, orig_day_label: "Days 16–18" },
  { id: "tech-21", role: "tech", num: 21, title: "Implement basic content version and publishing controls.", day: 10, orig_day_label: "Day 19" },
  { id: "tech-22", role: "tech", num: 22, title: "Test APIs, data integrity, and permission boundaries.", day: 11, orig_day_label: "Day 20" },
  { id: "tech-23", role: "tech", num: 23, title: "Deploy the pilot infrastructure to a test environment.", day: 11, orig_day_label: "Day 21" },
  { id: "tech-24", role: "tech", num: 24, title: "Fix critical issues and document the technical implementation.", day: 11, orig_day_label: "Days 22–27" },
  { id: "tech-25", role: "tech", num: 25, title: "Present the working prototype and prepare next 3-month roadmap.", day: 11, orig_day_label: "Days 28–31" },

  // ACADEMIC LEAD (25 tasks)
  { id: "acad-1", role: "acad", num: 1, title: "Define NexSyrus Curriculum vision, mission, and academic philosophy.", day: 1, orig_day_label: "Day 1" },
  { id: "acad-2", role: "acad", num: 2, title: "Select initial pilot grades, subjects, and learning scope.", day: 1, orig_day_label: "Day 1" },
  { id: "acad-3", role: "acad", num: 3, title: "Research official curriculum requirements for the selected pilot.", day: 1, orig_day_label: "Days 1–2" },
  { id: "acad-4", role: "acad", num: 4, title: "Map grade-wise subject and topic progression.", day: 2, orig_day_label: "Day 2" },
  { id: "acad-5", role: "acad", num: 5, title: "Define the curriculum hierarchy and academic terminology.", day: 2, orig_day_label: "Day 3" },
  { id: "acad-6", role: "acad", num: 6, title: "Create learning outcome and competency standards.", day: 3, orig_day_label: "Day 3" },
  { id: "acad-7", role: "acad", num: 7, title: "Define age-appropriate learning progression guidelines.", day: 3, orig_day_label: "Day 4" },
  { id: "acad-8", role: "acad", num: 8, title: "Create lesson planning templates.", day: 3, orig_day_label: "Day 4" },
  { id: "acad-9", role: "acad", num: 9, title: "Define teaching methodologies and activity-based learning principles.", day: 4, orig_day_label: "Day 5" },
  { id: "acad-10", role: "acad", num: 10, title: "Define assessment and evaluation framework.", day: 4, orig_day_label: "Day 5" },
  { id: "acad-11", role: "acad", num: 11, title: "Create curriculum quality assurance checklist.", day: 5, orig_day_label: "Day 6" },
  { id: "acad-12", role: "acad", num: 12, title: "Document teacher workload problems and curriculum needs.", day: 5, orig_day_label: "Day 6" },
  { id: "acad-13", role: "acad", num: 13, title: "Prepare the curriculum framework specification.", day: 6, orig_day_label: "Days 8–9" },
  { id: "acad-14", role: "acad", num: 14, title: "Create the pilot chapter and lesson progression.", day: 7, orig_day_label: "Days 9–10" },
  { id: "acad-15", role: "acad", num: 15, title: "Define learning objectives for every pilot lesson.", day: 7, orig_day_label: "Day 10" },
  { id: "acad-16", role: "acad", num: 16, title: "Review activities and assessments for alignment.", day: 8, orig_day_label: "Days 11–12" },
  { id: "acad-17", role: "acad", num: 17, title: "Define remedial and advanced learning pathways.", day: 8, orig_day_label: "Day 12" },
  { id: "acad-18", role: "acad", num: 18, title: "Define teacher feedback and curriculum improvement process.", day: 9, orig_day_label: "Day 13" },
  { id: "acad-19", role: "acad", num: 19, title: "Review the curriculum framework with all members.", day: 9, orig_day_label: "Day 14" },
  { id: "acad-20", role: "acad", num: 20, title: "Prepare a sample academic year and term plan.", day: 9, orig_day_label: "Days 15–16" },
  { id: "acad-21", role: "acad", num: 21, title: "Audit pilot content for accuracy and age appropriateness.", day: 10, orig_day_label: "Days 17–19" },
  { id: "acad-22", role: "acad", num: 22, title: "Validate learning outcomes with teacher feedback.", day: 10, orig_day_label: "Day 20" },
  { id: "acad-23", role: "acad", num: 23, title: "Finalize curriculum authoring guidelines.", day: 11, orig_day_label: "Days 21–23" },
  { id: "acad-24", role: "acad", num: 24, title: "Prepare the academic curriculum presentation for schools.", day: 11, orig_day_label: "Days 24–27" },
  { id: "acad-25", role: "acad", num: 25, title: "Approve Framework v1.1 and prepare next 3-month academic roadmap.", day: 11, orig_day_label: "Days 28–31" },

  // CONTENT LEAD (25 tasks)
  { id: "content-1", role: "content", num: 1, title: "Research teacher and student learning difficulties in target schools.", day: 1, orig_day_label: "Day 1" },
  { id: "content-2", role: "content", num: 2, title: "Identify suitable content formats for low-network environments.", day: 1, orig_day_label: "Day 1" },
  { id: "content-3", role: "content", num: 3, title: "Research engaging activity-based learning approaches.", day: 2, orig_day_label: "Day 2" },
  { id: "content-4", role: "content", num: 4, title: "Define the content types required for each lesson.", day: 2, orig_day_label: "Day 2" },
  { id: "content-5", role: "content", num: 5, title: "Create lesson content templates.", day: 3, orig_day_label: "Day 3" },
  { id: "content-6", role: "content", num: 6, title: "Create activity and practical exercise templates.", day: 3, orig_day_label: "Day 3" },
  { id: "content-7", role: "content", num: 7, title: "Create worksheets and classroom practice formats.", day: 4, orig_day_label: "Day 4" },
  { id: "content-8", role: "content", num: 8, title: "Define visual, video, and interactive resource requirements.", day: 4, orig_day_label: "Day 4" },
  { id: "content-9", role: "content", num: 9, title: "Prepare sample teacher guide formats.", day: 5, orig_day_label: "Day 5" },
  { id: "content-10", role: "content", num: 10, title: "Design student self-learning resource formats.", day: 5, orig_day_label: "Day 5" },
  { id: "content-11", role: "content", num: 11, title: "Research curriculum-related teacher workload issues.", day: 6, orig_day_label: "Day 6" },
  { id: "content-12", role: "content", num: 12, title: "Prepare content production and review workflow.", day: 6, orig_day_label: "Day 6" },
  { id: "content-13", role: "content", num: 13, title: "Create the pilot chapter content outline.", day: 7, orig_day_label: "Days 8–9" },
  { id: "content-14", role: "content", num: 14, title: "Write pilot lesson materials.", day: 7, orig_day_label: "Days 9–11" },
  { id: "content-15", role: "content", num: 15, title: "Create learning activities and worksheets.", day: 8, orig_day_label: "Days 10–12" },
  { id: "content-16", role: "content", num: 16, title: "Prepare teacher instructions and classroom resources.", day: 8, orig_day_label: "Day 12" },
  { id: "content-17", role: "content", num: 17, title: "Create sample assessment and practice materials.", day: 8, orig_day_label: "Days 13–14" },
  { id: "content-18", role: "content", num: 18, title: "Prepare a sample learning video/storyboard plan.", day: 9, orig_day_label: "Day 14" },
  { id: "content-19", role: "content", num: 19, title: "Build the pilot content presentation for demos.", day: 9, orig_day_label: "Day 15" },
  { id: "content-20", role: "content", num: 20, title: "Conduct teacher-focused usability reviews.", day: 10, orig_day_label: "Days 16–18" },
  { id: "content-21", role: "content", num: 21, title: "Collect and document teacher/student experience feedback.", day: 10, orig_day_label: "Days 18–20" },
  { id: "content-22", role: "content", num: 22, title: "Improve content based on validation feedback.", day: 10, orig_day_label: "Days 21–23" },
  { id: "content-23", role: "content", num: 23, title: "Prepare teacher onboarding and training materials.", day: 11, orig_day_label: "Days 24–25" },
  { id: "content-24", role: "content", num: 24, title: "Create curriculum sales demo storytelling and presentation assets.", day: 11, orig_day_label: "Days 26–28" },
  { id: "content-25", role: "content", num: 25, title: "Finalize pilot content library and next-quarter roadmap.", day: 11, orig_day_label: "Days 29–31" },

  // SALES LEAD (25 tasks)
  { id: "sales-1", role: "sales", num: 1, title: "Define target school segments and geographic territories.", day: 1, orig_day_label: "Day 1" },
  { id: "sales-2", role: "sales", num: 2, title: "Research potential school leads across target Telangana districts.", day: 1, orig_day_label: "Day 1" },
  { id: "sales-3", role: "sales", num: 3, title: "Build the initial school lead database.", day: 2, orig_day_label: "Days 1–2" },
  { id: "sales-4", role: "sales", num: 4, title: "Identify principals, owners, and decision-makers.", day: 2, orig_day_label: "Day 2" },
  { id: "sales-5", role: "sales", num: 5, title: "Research competitor School ERP and curriculum offerings.", day: 3, orig_day_label: "Days 2–3" },
  { id: "sales-6", role: "sales", num: 6, title: "Document competitor pricing and packaging where verifiable.", day: 3, orig_day_label: "Day 3" },
  { id: "sales-7", role: "sales", num: 7, title: "Prepare principal discovery questions.", day: 4, orig_day_label: "Day 4" },
  { id: "sales-8", role: "sales", num: 8, title: "Prepare SchoolIMS + Curriculum introductory pitch.", day: 4, orig_day_label: "Day 4" },
  { id: "sales-9", role: "sales", num: 9, title: "Create Telugu + English outreach scripts.", day: 5, orig_day_label: "Day 5" },
  { id: "sales-10", role: "sales", num: 10, title: "Prepare objection-handling and FAQ document.", day: 5, orig_day_label: "Day 5" },
  { id: "sales-11", role: "sales", num: 11, title: "Set up CRM tracking and lead follow-up process.", day: 6, orig_day_label: "Day 6" },
  { id: "sales-12", role: "sales", num: 12, title: "Create a daily sales reporting format.", day: 6, orig_day_label: "Day 6" },
  { id: "sales-13", role: "sales", num: 13, title: "Start outreach to qualified school leads.", day: 6, orig_day_label: "Days 8–10" },
  { id: "sales-14", role: "sales", num: 14, title: "Conduct principal and school-owner discovery calls.", day: 7, orig_day_label: "Days 9–12" },
  { id: "sales-15", role: "sales", num: 15, title: "Schedule product and curriculum demonstrations.", day: 7, orig_day_label: "Days 10–14" },
  { id: "sales-16", role: "sales", num: 16, title: "Document school curriculum problems and priorities.", day: 8, orig_day_label: "Days 11–14" },
  { id: "sales-17", role: "sales", num: 17, title: "Collect teacher and principal feedback on pilot concept.", day: 9, orig_day_label: "Days 15–17" },
  { id: "sales-18", role: "sales", num: 18, title: "Conduct SchoolIMS + Curriculum demos.", day: 9, orig_day_label: "Days 15–19" },
  { id: "sales-19", role: "sales", num: 19, title: "Track objections, pricing concerns, and feature requests.", day: 10, orig_day_label: "Days 16–20" },
  { id: "sales-20", role: "sales", num: 20, title: "Identify potential pilot schools.", day: 10, orig_day_label: "Days 18–21" },
  { id: "sales-21", role: "sales", num: 21, title: "Conduct structured follow-ups with qualified leads.", day: 11, orig_day_label: "Days 21–24" },
  { id: "sales-22", role: "sales", num: 22, title: "Prepare pilot school outreach and proposal process.", day: 11, orig_day_label: "Days 22–25" },
  { id: "sales-23", role: "sales", num: 23, title: "Measure lead quality, conversations, and demo outcomes.", day: 11, orig_day_label: "Days 24–27" },
  { id: "sales-24", role: "sales", num: 24, title: "Document a repeatable sales process for future executives.", day: 11, orig_day_label: "Days 26–29" },
  { id: "sales-25", role: "sales", num: 25, title: "Present sales report, pipeline, and next-quarter roadmap.", day: 11, orig_day_label: "Days 30–31" }
];

/**
 * Idempotently seed sprint days and tasks if not already populated.
 */
async function seedSprintDataIfNeeded(sql) {
  try {
    // 1. Seed Days
    for (const dm of DAYS_META) {
      await sql`
        INSERT INTO sprint_days (day, date_label, title, handoff, gate)
        VALUES (${dm.day}, ${dm.date_label}, ${dm.title}, ${dm.handoff}, ${dm.gate})
        ON CONFLICT (day) DO UPDATE
        SET date_label = EXCLUDED.date_label,
            title = EXCLUDED.title,
            handoff = EXCLUDED.handoff,
            gate = EXCLUDED.gate
      `;
    }

    // 2. Seed Tasks (preserving status/assignee/notes if already existing)
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

    console.log('[sprintSeed] ✅ All 11 days and 100 deliverables successfully verified/seeded.');
    return true;
  } catch (err) {
    console.error('[sprintSeed] ❌ Error seeding sprint data:', err.message);
    throw err;
  }
}

module.exports = {
  DAYS_META,
  ALL_TASKS,
  seedSprintDataIfNeeded,
};

/**
 * Dedicated CRM database migrations.
 * Lexical filename order is not a valid bootstrap: 07_top_level_crm.sql
 * references founders, which 09_dedicated_crm_baseline.sql creates.
 * Apply this manifest. Do not edit already-shipped migration files to paper over order.
 */
const CRM_MIGRATIONS = [
  {
    id: '09_dedicated_crm_baseline',
    file: '09_dedicated_crm_baseline.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: [],
  },
  {
    id: '08_website_chat',
    file: '08_website_chat.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: [],
  },
  {
    id: '07_top_level_crm',
    file: '07_top_level_crm.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['09_dedicated_crm_baseline'],
  },
  {
    id: '15_sales_crm_foundation',
    file: '15_sales_crm_foundation.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['09_dedicated_crm_baseline', '07_top_level_crm'],
  },
  {
    id: '16_school_prospect_import',
    file: '16_school_prospect_import.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['15_sales_crm_foundation'],
  },
  {
    id: '17_founder_sales_command',
    file: '17_founder_sales_command.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['16_school_prospect_import'],
  },
  {
    id: '18_trackable_links',
    file: '18_trackable_links.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['17_founder_sales_command'],
  },
  {
    id: '19_field_feedback',
    file: '19_field_feedback.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['18_trackable_links'],
  },
  {
    id: '20_field_visits',
    file: '20_field_visits.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['19_field_feedback'],
  },
  {
    id: '21_field_day_plan',
    file: '21_field_day_plan.sql',
    database: 'CRM_DATABASE_URL',
    dependsOn: ['20_field_visits'],
  },
];

function orderedCrmMigrations() {
  const pending = [...CRM_MIGRATIONS];
  const done = [];
  const doneIds = new Set();
  while (pending.length) {
    const nextIndex = pending.findIndex((item) => item.dependsOn.every((dep) => doneIds.has(dep)));
    if (nextIndex === -1) {
      throw new Error(`CRM migration dependency cycle or missing parent: ${pending.map((item) => item.id).join(', ')}`);
    }
    const [next] = pending.splice(nextIndex, 1);
    done.push(next);
    doneIds.add(next.id);
  }
  return done;
}

module.exports = { CRM_MIGRATIONS, orderedCrmMigrations };

// Fix IPv6 hanging issues in Node.js fetch (undici timeouts on Windows)
global.fetch = require('cross-fetch');
require('node:dns').setDefaultResultOrder('ipv4first');

const config = require('./config/env');
const { createApp } = require('./app');
const { startCrmAutomationWorker } = require('./services/crmAutomation');
const { startImportWorker, stopImportWorker } = require('./services/crm/importWorker');
const sql = require('./config/db');
const { ensureSprintDataReady } = require('./services/sprintSeed');
const { startPayrollAutomationWorker } = require('./services/payrollAutomation');
const { syncLegacyFounders } = require('./services/founderSync');
const { assertTrackingStartup } = require('./services/crm/trackingConfig');
const { ensureSchoolIntakeSchema } = require('./services/schoolIntake');
const { ensureSchoolConfigurationSchema } = require('./services/schoolConfiguration');
const { startSchoolPackageWorker, stopSchoolPackageWorker } = require('./services/schoolPackageWorker');

assertTrackingStartup();

const app = createApp();
const PORT = config.port;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  SuperAdmin Backend running on port ${PORT}\n`);
  console.log(`   Health check: http://localhost:${PORT}/  or  /health`);
  console.log(`   API prefix:   http://localhost:${PORT}/api/super-admin/`);
  console.log(`   Medical API:  http://localhost:${PORT}/api/v1/medical/\n`);
  startCrmAutomationWorker();
  startImportWorker();
  startPayrollAutomationWorker();
  syncLegacyFounders(sql).catch((err) => console.error('[server] Founder sync error:', err.message));
  ensureSprintDataReady(sql).catch((err) => console.error('[server] Sprint seed error:', err.message));
  ensureSchoolIntakeSchema().catch((err) => console.error('[server] School intake schema error:', err.message));
  ensureSchoolConfigurationSchema(sql).catch((err) => console.error('[server] School configuration schema error:', err.message));
  startSchoolPackageWorker(sql);
});

process.on('SIGTERM', () => {
  stopImportWorker();
  stopSchoolPackageWorker();
});

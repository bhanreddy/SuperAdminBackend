// Fix IPv6 hanging issues in Node.js fetch (undici timeouts on Windows)
global.fetch = require('cross-fetch');
require('node:dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const routes = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { errorHandler } = require('./middleware/errorHandler');
const { startCrmAutomationWorker } = require('./services/crmAutomation');
const sql = require('./config/db');
const { ensureSprintDataReady } = require('./services/sprintSeed');
const { startPayrollAutomationWorker } = require('./services/payrollAutomation');

const app = express();

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      // If allowedOrigins contains '*', allow any origin by echoing it back
      if (config.allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      // Otherwise strictly check against the list
      if (config.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Logging
app.use(requestLogger);

// Mount all routes
app.use('/', routes);

// Global Error Handler
app.use(errorHandler);

const PORT = config.port;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  SuperAdmin Backend running on port ${PORT}\n`);
  console.log(`   Health check: http://localhost:${PORT}/  or  /health`);
  console.log(`   API prefix:   http://localhost:${PORT}/api/super-admin/`);
  console.log(`   Medical API:  http://localhost:${PORT}/api/v1/medical/\n`);
  startCrmAutomationWorker();
  startPayrollAutomationWorker();
  ensureSprintDataReady(sql).catch((err) => console.error('[server] Sprint seed error:', err.message));
});

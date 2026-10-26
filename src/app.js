const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const routes = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  // AppSail handles preflight and adds CORS headers at the gateway. Adding
  // Express CORS there duplicates Allow-Origin and makes browser requests fail.
  if (!process.env.X_ZOHO_CATALYST_LISTEN_PORT) {
    app.use(
      cors({
        origin: (origin, callback) => {
          if (config.allowedOrigins.includes('*')) return callback(null, true);
          if (!origin) return callback(null, true);
          if (config.allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
      }),
    );
  }
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(requestLogger);
  app.use('/', routes);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

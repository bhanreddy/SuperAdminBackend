const express = require('express');
const cors = require('cors');
const config = require('./config/env');
const routes = require('./routes');
const { requestLogger } = require('./middleware/requestLogger');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
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
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(requestLogger);
  app.use('/', routes);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

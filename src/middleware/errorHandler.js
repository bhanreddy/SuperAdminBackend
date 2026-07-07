/**
 * Async handler — eliminates try-catch boilerplate in route handlers.
 * Ported from SupabaseBackend/utils/asyncHandler.js.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Global error handler middleware.
 * Ported from SupabaseBackend/utils/asyncHandler.js — logic preserved exactly.
 */
const errorHandler = (err, req, res, _next) => {
  const requestId = req.headers['x-request-id'] || 'no-id';

  // Handle known error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      details: err.errors || err.message,
      requestId,
    });
  }

  if (err.code === '23505') {
    // PostgreSQL unique violation
    return res.status(409).json({
      error: 'Duplicate Entry',
      details: err.detail || 'A record with this value already exists',
      requestId,
    });
  }

  if (err.code === '23503') {
    // PostgreSQL foreign key violation
    return res.status(400).json({
      error: 'Invalid Reference',
      details: err.detail || 'Referenced record does not exist',
      requestId,
    });
  }

  // PL/pgSQL RAISE EXCEPTION 'Unauthorized: ...'
  if (typeof err.message === 'string' && err.message.startsWith('Unauthorized:')) {
    const detail = err.message.slice('Unauthorized:'.length).trim();
    return res.status(403).json({
      error: detail || 'Forbidden',
      requestId,
    });
  }

  // Handle transient DB/network errors → 503
  const transientCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'CONNECTION_ENDED',
    'CONNECTION_CLOSED',
  ];
  if (
    transientCodes.includes(err.code) ||
    err.message?.includes('ETIMEDOUT') ||
    err.message?.includes('Connect Timeout')
  ) {
    return res.status(503).json({
      error: 'Service temporarily unavailable. Please retry.',
      requestId,
    });
  }

  // Default to 500
  const status = err.status || err.statusCode || 500;
  console.error(`❌ ${req.method} ${req.url} — ${err.message}`, err.stack);
  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.message || 'Internal Server Error',
    requestId,
  });
};

module.exports = { asyncHandler, errorHandler };

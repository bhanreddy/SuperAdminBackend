/**
 * Basic request logger middleware.
 * Logs method, URL, status code, and response time.
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();

  // Skip health check noise
  if (req.path === '/health') return next();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const icon = status < 300 ? '✅' : status < 400 ? '↪️' : status < 500 ? '⚠️' : '❌';
    const url = String(req.originalUrl || '').replace(
      /([?&])(search|phone|email|q|udise|query|at|h|attribution_context|token|handoff|nx_attr)=([^&]*)/gi,
      '$1$2=[redacted]',
    );
    console.log(
      `${icon} ${req.method.padEnd(7)} ${String(status).padEnd(3)} │ ${url}  (${ms}ms)`,
    );
  });

  next();
};

module.exports = { requestLogger };

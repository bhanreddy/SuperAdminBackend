class CrmError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.code = code || 'CRM_ERROR';
    this.details = details;
  }
}

function sendCrmError(res, err, logFields) {
  if (err instanceof CrmError) {
    const body = { error: err.message, code: err.code };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  const safe = { ...(logFields || {}) };
  delete safe.email;
  delete safe.phone;
  delete safe.message;
  delete safe.notes;
  console.error(JSON.stringify({
    component: 'crm',
    event: 'command_failed',
    error: err?.message || 'unknown',
    ...safe,
  }));
  return res.status(500).json({ error: 'CRM request failed', code: 'CRM_INTERNAL' });
}

module.exports = { CrmError, sendCrmError };

/**
 * Standard API response helpers.
 * Ported from SupabaseBackend/utils/apiResponse.js.
 *
 * SuperAdmin routes use sendResponse (no school_id envelope).
 */

/**
 * Generic response (no school_id envelope). Used by all super-admin routes.
 */
const sendResponse = (res, statusCode, data) => {
  return res.status(statusCode).json(data);
};

/**
 * Send error response.
 */
const sendError = (res, statusCode, error, details) => {
  const payload = { error };
  if (details) payload.details = details;
  return res.status(statusCode).json(payload);
};

module.exports = { sendResponse, sendError };

// Public SchoolIMS endpoint. Internal cluster/admin addresses must not enter app builds.
const DEFAULT_SCHOOL_API_URL = 'https://simsapi.nexsyrus.com/api/v1';

function schoolPublicApiUrl() {
  const value = String(process.env.SCHOOL_PUBLIC_API_URL || DEFAULT_SCHOOL_API_URL).trim().replace(/\/+$/, '');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SCHOOL_PUBLIC_API_URL must be an HTTPS API base URL without credentials, query, or fragment');
  }
  return value;
}

module.exports = { DEFAULT_SCHOOL_API_URL, schoolPublicApiUrl };

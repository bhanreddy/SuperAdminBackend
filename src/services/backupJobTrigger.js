const jwt = require('jsonwebtoken');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function parseServiceAccountJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('BACKUP_TRIGGER_SA_JSON is not valid JSON');
  }
}

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    },
    serviceAccount.private_key,
    { algorithm: 'RS256' }
  );

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(`Failed to obtain Google access token (HTTP ${response.status})`);
  }
  return payload.access_token;
}

async function triggerCloudRunBackupJob({
  projectId,
  region,
  jobName,
  serviceAccount,
  backupType = 'manual',
}) {
  const token = await getGoogleAccessToken(serviceAccount);
  const uri = `https://${region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${projectId}/jobs/${jobName}:run`;
  const response = await fetch(uri, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          {
            env: [{ name: 'BACKUP_TYPE', value: backupType }],
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    throw new Error(`Cloud Run Job execute failed (HTTP ${response.status})`);
  }

  return {
    mode: 'cloudrun',
    executionName: body.metadata?.name || body.name || null,
  };
}

function triggerLocalBackupWorker(backupType = 'manual') {
  const backupScriptPath = path.resolve(
    __dirname,
    '../../../../SchoolIMS-Backend/jobs/backup/src/index.js'
  );
  if (!fs.existsSync(backupScriptPath)) {
    throw new Error(
      'Local backup worker is not available on this host. Configure Cloud Run Job triggering instead.'
    );
  }

  const child = spawn(process.execPath, [backupScriptPath, `--type=${backupType}`], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BACKUP_TYPE: backupType,
    },
  });
  child.unref();
  return { mode: 'local', pid: child.pid };
}

/**
 * Triggers the trusted backup worker. Never accepts SQL or credentials from the caller.
 *
 * Production: Cloud Run Job execute via IAM service account.
 * Local/dev: BACKUP_TRIGGER_MODE=local spawns the isolated worker process.
 */
async function triggerManualBackup({ operator } = {}) {
  const backupType = 'manual';
  const mode = (process.env.BACKUP_TRIGGER_MODE || 'cloudrun').toLowerCase();

  if (mode === 'local') {
    const result = triggerLocalBackupWorker(backupType);
    return {
      ...result,
      backupType,
      operator: operator || 'Founder',
      message: 'Manual backup worker started locally. Status will appear in Founder Console when the job records metadata.',
    };
  }

  const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const region = process.env.GCP_REGION || 'asia-south1';
  const jobName = process.env.BACKUP_CLOUD_RUN_JOB || 'schoolims-db-backup';
  const serviceAccount = parseServiceAccountJson(process.env.BACKUP_TRIGGER_SA_JSON);

  if (!projectId || !serviceAccount?.client_email || !serviceAccount?.private_key) {
    const err = new Error(
      'Manual backup trigger is not configured. Set GCP_PROJECT_ID and BACKUP_TRIGGER_SA_JSON, or execute the Cloud Run Job with gcloud.'
    );
    err.statusCode = 503;
    throw err;
  }

  const result = await triggerCloudRunBackupJob({
    projectId,
    region,
    jobName,
    serviceAccount,
    backupType,
  });

  return {
    ...result,
    backupType,
    operator: operator || 'Founder',
    jobName,
    region,
    message: 'Manual backup job accepted. The private Cloud Run Job is executing independently of this API.',
  };
}

module.exports = {
  triggerManualBackup,
  parseServiceAccountJson,
};

const express = require('express');
const sql = require('../../config/db');
const { sendResponse } = require('../../utils/apiResponse');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { triggerManualBackup } = require('../../services/backupJobTrigger');

const router = express.Router();
const STALE_BACKUP_HOURS = Number(process.env.STALE_BACKUP_HOURS || 26);

function getAgeInHours(date) {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  return Math.max(0, Math.round((ms / (1000 * 60 * 60)) * 10) / 10);
}

// ── GET /api/super-admin/backups/stats ──────────────────────────────────────
router.get('/stats', verifySuperAdminMiddleware, async (req, res) => {
  try {
    // 1. Last successful backup
    const [lastSuccessful] = await sql`
      SELECT id, backup_id, backup_type, status, started_at, completed_at,
             duration_seconds, file_size_bytes, storage_path, checksum_sha256,
             database_version, verification_status, verified_at
      FROM public.backup_jobs
      WHERE status = 'success'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1
    `;

    // 2. Current / latest backup overall
    const [latestOverall] = await sql`
      SELECT id, backup_id, backup_type, status, started_at, completed_at,
             duration_seconds, file_size_bytes, error_message
      FROM public.backup_jobs
      ORDER BY started_at DESC
      LIMIT 1
    `;

    // 3. 30-Day Aggregates
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [stats30] = await sql`
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'success')::int AS successful_runs,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
        COALESCE(SUM(file_size_bytes) FILTER (WHERE status = 'success'), 0)::bigint AS total_storage_bytes,
        COALESCE(AVG(duration_seconds) FILTER (WHERE status = 'success'), 0)::int AS avg_duration_seconds
      FROM public.backup_jobs
      WHERE started_at >= ${thirtyDaysAgo}
    `;

    const totalRuns = stats30?.total_runs || 0;
    const successfulRuns = stats30?.successful_runs || 0;
    const successRatePercent = totalRuns > 0 ? Math.round((successfulRuns / totalRuns) * 1000) / 10 : null;

    const ageHours = lastSuccessful ? getAgeInHours(lastSuccessful.completed_at) : null;
    const staleBackup = {
      isStale: !lastSuccessful || (ageHours !== null && ageHours > STALE_BACKUP_HOURS),
      ageHours,
      thresholdHours: STALE_BACKUP_HOURS,
      message: !lastSuccessful
        ? 'No successful backup recorded'
        : ageHours > STALE_BACKUP_HOURS
          ? `No successful backup for ${ageHours} hours (threshold: ${STALE_BACKUP_HOURS}h)`
          : `Last successful backup was ${ageHours} hours ago`,
    };

    // 4. Daily timeline for last 30 days
    const dailyTimelineRows = await sql`
      SELECT
        TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
        COUNT(b.id)::int AS count,
        BOOL_OR(b.status = 'failed') AS has_failure,
        BOOL_OR(b.status = 'success') AS has_success
      FROM GENERATE_SERIES(
        CURRENT_DATE - INTERVAL '29 days',
        CURRENT_DATE,
        INTERVAL '1 day'
      ) d(day)
      LEFT JOIN public.backup_jobs b
        ON DATE_TRUNC('day', b.started_at) = d.day
      GROUP BY d.day
      ORDER BY d.day ASC
    `;

    const dailyTimeline = dailyTimelineRows.map((row) => {
      let status = 'none';
      if (row.has_failure) status = 'failed';
      else if (row.has_success) status = 'success';
      return {
        date: row.date,
        status,
        count: row.count,
      };
    });

    // 5. Recent failures (last 5)
    const recentFailures = await sql`
      SELECT id, backup_id, backup_type, status, started_at, duration_seconds,
             error_message, verification_status
      FROM public.backup_jobs
      WHERE status = 'failed'
      ORDER BY started_at DESC
      LIMIT 5
    `;

    // 6. Settings for schedule info
    const settingsRows = await sql`SELECT key, value FROM public.backup_settings`;
    const settings = {};
    for (const r of settingsRows) settings[r.key] = r.value;

    return sendResponse(res, 200, {
      lastSuccessfulBackup: lastSuccessful ? {
        ...lastSuccessful,
        age_hours: ageHours,
      } : null,
      currentStatus: latestOverall || null,
      nextScheduledBackup: settings.schedule?.timezone
        ? `Daily at ${settings.schedule.cron || '0 2 * * *'} ${settings.schedule.timezone}`
        : 'Daily at 02:00 Asia/Kolkata',
      staleBackup,
      settings,
      thirtyDayStats: {
        totalRuns,
        successfulRuns,
        failedRuns: stats30?.failed_runs || 0,
        successRatePercent,
        totalStorageBytes: Number(stats30?.total_storage_bytes || 0),
        averageDurationSeconds: stats30?.avg_duration_seconds || 0,
        dailyTimeline,
      },
      recentFailures,
    });
  } catch (err) {
    console.error('Error fetching backup stats:', err);
    return res.status(500).json({ error: 'Failed to fetch backup statistics', details: err.message });
  }
});

// ── GET /api/super-admin/backups ───────────────────────────────────────────
router.get('/', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status ? String(req.query.status).trim() : null;
    const typeFilter = req.query.type ? String(req.query.type).trim() : null;

    let countQuery;
    let dataQuery;

    if (statusFilter && typeFilter) {
      countQuery = sql`
        SELECT COUNT(*)::int AS total FROM public.backup_jobs
        WHERE status = ${statusFilter} AND backup_type = ${typeFilter}
      `;
      dataQuery = sql`
        SELECT id, backup_id, backup_type, status, started_at, completed_at,
               duration_seconds, file_size_bytes, storage_path, checksum_sha256,
               database_version, verification_status, error_message, created_at
        FROM public.backup_jobs
        WHERE status = ${statusFilter} AND backup_type = ${typeFilter}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (statusFilter) {
      countQuery = sql`
        SELECT COUNT(*)::int AS total FROM public.backup_jobs
        WHERE status = ${statusFilter}
      `;
      dataQuery = sql`
        SELECT id, backup_id, backup_type, status, started_at, completed_at,
               duration_seconds, file_size_bytes, storage_path, checksum_sha256,
               database_version, verification_status, error_message, created_at
        FROM public.backup_jobs
        WHERE status = ${statusFilter}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (typeFilter) {
      countQuery = sql`
        SELECT COUNT(*)::int AS total FROM public.backup_jobs
        WHERE backup_type = ${typeFilter}
      `;
      dataQuery = sql`
        SELECT id, backup_id, backup_type, status, started_at, completed_at,
               duration_seconds, file_size_bytes, storage_path, checksum_sha256,
               database_version, verification_status, error_message, created_at
        FROM public.backup_jobs
        WHERE backup_type = ${typeFilter}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      countQuery = sql`
        SELECT COUNT(*)::int AS total FROM public.backup_jobs
      `;
      dataQuery = sql`
        SELECT id, backup_id, backup_type, status, started_at, completed_at,
               duration_seconds, file_size_bytes, storage_path, checksum_sha256,
               database_version, verification_status, error_message, created_at
        FROM public.backup_jobs
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    const [totalRows, rows] = await Promise.all([countQuery, dataQuery]);
    const total = totalRows[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    return sendResponse(res, 200, {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (err) {
    console.error('Error fetching backup list:', err);
    return res.status(500).json({ error: 'Failed to fetch backup history', details: err.message });
  }
});

// ── GET /api/super-admin/backups/:id ───────────────────────────────────────
router.get('/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Supports query by UUID id or backup_id string
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const [job] = isUuid
      ? await sql`SELECT * FROM public.backup_jobs WHERE id = ${id} LIMIT 1`
      : await sql`SELECT * FROM public.backup_jobs WHERE backup_id = ${id} LIMIT 1`;

    if (!job) {
      return res.status(404).json({ error: 'Backup job not found' });
    }

    const events = await sql`
      SELECT id, event_type, message, metadata, created_at
      FROM public.backup_events
      WHERE backup_job_id = ${job.id}
      ORDER BY created_at ASC
    `;

    return sendResponse(res, 200, {
      job,
      events,
    });
  } catch (err) {
    console.error('Error fetching backup details:', err);
    return res.status(500).json({ error: 'Failed to fetch backup details', details: err.message });
  }
});

// ── POST /api/super-admin/backups/trigger ──────────────────────────────────
router.post('/trigger', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const operator = req.superAdmin?.email || req.founder?.email || 'Founder';
    const result = await triggerManualBackup({ operator });
    return sendResponse(res, 202, {
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error triggering manual backup:', err.message);
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: 'Failed to initiate backup job',
      details: err.message,
    });
  }
});

module.exports = router;

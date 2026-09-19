const express = require('express');
const sql = require('../../config/db');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { DAYS_META, ALL_TASKS, seedSprintDataIfNeeded } = require('../../services/sprintSeed');

const router = express.Router();

// Apply auth middleware to all sprint routes
router.use(verifySuperAdminMiddleware);

/**
 * GET /api/super-admin/sprint/state
 * Returns full live sprint cockpit state:
 * - days with per-day progress and exit gates
 * - all 100 tasks with assignees, notes, and blocker details
 * - overall and per-role metrics
 * - recent activity audit trail
 * - list of founders for assignments
 */
router.get('/state', async (req, res) => {
  try {
    // 1. Fetch days with aggregated task counts
    const days = await sql`
      SELECT 
        d.day,
        d.date_label,
        d.title,
        d.handoff,
        d.gate,
        d.gate_status,
        d.gate_notes,
        d.updated_at,
        COUNT(t.id)::int AS total_tasks,
        COUNT(CASE WHEN t.status = 'done' THEN 1 END)::int AS done_tasks,
        COUNT(CASE WHEN t.status = 'doing' THEN 1 END)::int AS doing_tasks,
        COUNT(CASE WHEN t.status = 'blocked' THEN 1 END)::int AS blocked_tasks,
        COUNT(CASE WHEN t.status = 'todo' THEN 1 END)::int AS todo_tasks
      FROM sprint_days d
      LEFT JOIN sprint_tasks t ON t.day = d.day
      GROUP BY d.day, d.date_label, d.title, d.handoff, d.gate, d.gate_status, d.gate_notes, d.updated_at
      ORDER BY d.day ASC
    `;

    // 2. Fetch all 100 tasks
    const tasks = await sql`
      SELECT 
        id,
        role,
        num,
        title,
        day,
        orig_day_label,
        status,
        assignee_id,
        assignee_name,
        blocker_reason,
        notes,
        completed_at,
        last_updated_by_name,
        last_updated_by_id,
        updated_at
      FROM sprint_tasks
      ORDER BY day ASC, role ASC, num ASC
    `;

    // 3. Compute high-level metrics
    const totalTasks = tasks.length;
    const doneTasks = tasks.filter(t => t.status === 'done').length;
    const doingTasks = tasks.filter(t => t.status === 'doing').length;
    const blockedTasks = tasks.filter(t => t.status === 'blocked').length;
    const todoTasks = tasks.filter(t => t.status === 'todo').length;
    const completionPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

    const roles = ['tech', 'acad', 'content', 'sales'];
    const roleBreakdown = {};
    for (const r of roles) {
      const rTasks = tasks.filter(t => t.role === r);
      const rDone = rTasks.filter(t => t.status === 'done').length;
      roleBreakdown[r] = {
        total: rTasks.length,
        done: rDone,
        doing: rTasks.filter(t => t.status === 'doing').length,
        blocked: rTasks.filter(t => t.status === 'blocked').length,
        todo: rTasks.filter(t => t.status === 'todo').length,
        percentage: rTasks.length > 0 ? Math.round((rDone / rTasks.length) * 100) : 0,
      };
    }

    // 4. Fetch recent activity logs (last 30)
    const recentActivity = await sql`
      SELECT 
        id,
        task_id,
        day,
        role,
        action,
        old_status,
        new_status,
        details,
        user_name,
        user_id,
        created_at
      FROM sprint_activity_logs
      ORDER BY created_at DESC
      LIMIT 30
    `;

    // 5. Fetch available founders and super-admins for assigning tasks
    let founders = [];
    try {
      founders = await sql`
        SELECT id, email, full_name, role, is_active
        FROM founders
        WHERE is_active = true
        ORDER BY full_name ASC
      `;
    } catch (e) {
      console.warn('[sprint/state] founders table read error:', e.message);
    }

    let superAdmins = [];
    try {
      superAdmins = await sql`
        SELECT id, email, full_name, 'SUPER_ADMIN' as role, is_active
        FROM super_admins
        WHERE is_active = true
        ORDER BY full_name ASC
      `;
    } catch (e) {
      console.warn('[sprint/state] super_admins table read error:', e.message);
    }

    const allMembers = [
      ...superAdmins.map(sa => ({ id: sa.id, name: sa.full_name || sa.email, email: sa.email, role: 'Super Admin' })),
      ...founders.map(f => ({ id: f.id, name: f.full_name || f.email, email: f.email, role: f.role || 'Founder' }))
    ];

    // Deduplicate by ID
    const uniqueMembers = Array.from(new Map(allMembers.map(m => [m.id, m])).values());

    return res.json({
      days,
      tasks,
      metrics: {
        total: totalTasks,
        done: doneTasks,
        doing: doingTasks,
        blocked: blockedTasks,
        todo: todoTasks,
        completionPct,
        roles: roleBreakdown,
      },
      recent_activity: recentActivity,
      members: uniqueMembers,
    });
  } catch (err) {
    console.error('[sprint/state] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch sprint cockpit state', details: err.message });
  }
});

/**
 * PATCH /api/super-admin/sprint/tasks/:id
 * Update status, assignee, blocker reason, or notes on a task.
 */
router.patch('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, assignee_id, assignee_name, blocker_reason, notes } = req.body;

    // Fetch existing task
    const [existing] = await sql`SELECT * FROM sprint_tasks WHERE id = ${id} LIMIT 1`;
    if (!existing) {
      return res.status(404).json({ error: `Task ${id} not found` });
    }

    const validStatuses = ['todo', 'doing', 'blocked', 'done'];
    const newStatus = status !== undefined ? status : existing.status;
    if (status !== undefined && !validStatuses.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status. Must be one of ${validStatuses.join(', ')}` });
    }

    const newAssigneeId = assignee_id !== undefined ? assignee_id : existing.assignee_id;
    const newAssigneeName = assignee_name !== undefined ? assignee_name : existing.assignee_name;
    const newBlocker = blocker_reason !== undefined ? blocker_reason : existing.blocker_reason;
    const newNotes = notes !== undefined ? notes : existing.notes;
    const completedAt = newStatus === 'done' 
      ? (existing.completed_at || new Date()) 
      : null;

    const updaterName = req.superAdmin?.fullName || req.superAdmin?.email || 'Founder';
    const updaterId = req.superAdmin?.id || null;

    // Update the task
    const [updated] = await sql`
      UPDATE sprint_tasks
      SET 
        status = ${newStatus},
        assignee_id = ${newAssigneeId},
        assignee_name = ${newAssigneeName},
        blocker_reason = ${newBlocker},
        notes = ${newNotes},
        completed_at = ${completedAt},
        last_updated_by_name = ${updaterName},
        last_updated_by_id = ${updaterId},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    // Record activity log if status or significant property changed
    if (newStatus !== existing.status || newBlocker !== existing.blocker_reason) {
      let action = 'status_changed';
      let details = `Status changed from ${existing.status} to ${newStatus}`;
      if (newStatus === 'blocked' && newBlocker) {
        details += ` | Blocker: ${newBlocker}`;
      } else if (newStatus === 'done') {
        details = `Completed task #${existing.num}`;
      }

      await sql`
        INSERT INTO sprint_activity_logs (
          task_id, day, role, action, old_status, new_status, details, user_name, user_id
        ) VALUES (
          ${id}, ${existing.day}, ${existing.role}, ${action}, 
          ${existing.status}, ${newStatus}, ${details}, ${updaterName}, ${updaterId}
        )
      `;
    }

    return res.json({ success: true, task: updated });
  } catch (err) {
    console.error('[sprint/tasks/:id] Error:', err);
    return res.status(500).json({ error: 'Failed to update task', details: err.message });
  }
});

/**
 * PATCH /api/super-admin/sprint/days/:day/gate
 * Update exit gate status and gate notes for a sprint day.
 */
router.patch('/days/:day/gate', async (req, res) => {
  try {
    const day = parseInt(req.params.day, 10);
    const { gate_status, gate_notes } = req.body;

    const validGateStatuses = ['pending', 'in_progress', 'passed', 'blocked'];
    if (gate_status && !validGateStatuses.includes(gate_status)) {
      return res.status(400).json({ error: `Invalid gate_status. Must be one of ${validGateStatuses.join(', ')}` });
    }

    const updaterName = req.superAdmin?.fullName || req.superAdmin?.email || 'Founder';
    const updaterId = req.superAdmin?.id || null;

    const [updated] = await sql`
      UPDATE sprint_days
      SET 
        gate_status = COALESCE(${gate_status}, gate_status),
        gate_notes = COALESCE(${gate_notes}, gate_notes),
        updated_at = now()
      WHERE day = ${day}
      RETURNING *
    `;

    if (!updated) {
      return res.status(404).json({ error: `Sprint day ${day} not found` });
    }

    // Log gate status change
    await sql`
      INSERT INTO sprint_activity_logs (
        day, action, details, user_name, user_id
      ) VALUES (
        ${day}, 'gate_updated', 
        ${`Day ${day} exit gate marked as ${gate_status || updated.gate_status}`},
        ${updaterName}, ${updaterId}
      )
    `;

    return res.json({ success: true, day: updated });
  } catch (err) {
    console.error('[sprint/days/:day/gate] Error:', err);
    return res.status(500).json({ error: 'Failed to update exit gate', details: err.message });
  }
});

/**
 * GET /api/super-admin/sprint/standup/:day
 * Formats a ready-to-paste Daily Standup report for Slack, WhatsApp, or Teams.
 */
router.get('/standup/:day', async (req, res) => {
  try {
    const day = parseInt(req.params.day, 10);

    const [dayMeta] = await sql`SELECT * FROM sprint_days WHERE day = ${day} LIMIT 1`;
    if (!dayMeta) {
      return res.status(404).json({ error: `Day ${day} not found` });
    }

    const tasks = await sql`SELECT * FROM sprint_tasks WHERE day = ${day} ORDER BY role, num ASC`;
    const [{ total, done }] = await sql`
      SELECT count(*)::int as total, count(case when status = 'done' then 1 end)::int as done 
      FROM sprint_tasks
    `;

    const pct = Math.round((done / total) * 100);

    let report = `🚀 *NEXSYRUS SPRINT STANDUP — DAY ${day}* (${dayMeta.date_label})\n`;
    report += `🎯 Focus: ${dayMeta.title}\n`;
    report += `📊 Overall Sprint Progress: ${done}/${total} Tasks Done (${pct}%)\n\n`;

    const roleConfig = [
      { key: 'tech', label: '👨‍💻 Tech Lead' },
      { key: 'acad', label: '📚 Academic Lead' },
      { key: 'content', label: '🎬 Content Lead' },
      { key: 'sales', label: '📈 Sales Lead' },
    ];

    roleConfig.forEach(r => {
      report += `${r.label}:\n`;
      const roleTasks = tasks.filter(t => t.role === r.key);
      if (roleTasks.length === 0) {
        report += `  • Continuing ongoing workflows.\n`;
      } else {
        roleTasks.forEach(t => {
          let statusIcon = '◻️ [TODO]';
          if (t.status === 'done') statusIcon = '✅ [DONE]';
          else if (t.status === 'doing') statusIcon = '⏳ [IN PROGRESS]';
          else if (t.status === 'blocked') statusIcon = '⚠️ [BLOCKED]';

          let line = `  ${statusIcon} #${t.num}: ${t.title}`;
          if (t.assignee_name) line += ` (@${t.assignee_name})`;
          if (t.status === 'blocked' && t.blocker_reason) {
            line += ` ⚠️ Blocker: ${t.blocker_reason}`;
          }
          report += `${line}\n`;
        });
      }
      report += `\n`;
    });

    report += `🔄 Inter-Lead Handoff: ${dayMeta.handoff}\n`;
    report += `🏁 EOD Exit Gate [${dayMeta.gate_status.toUpperCase()}]: ${dayMeta.gate}\n`;
    if (dayMeta.gate_notes) {
      report += `📝 Gate Notes: ${dayMeta.gate_notes}\n`;
    }

    return res.json({ report, day: dayMeta });
  } catch (err) {
    console.error('[sprint/standup/:day] Error:', err);
    return res.status(500).json({ error: 'Failed to generate standup report', details: err.message });
  }
});

/**
 * POST /api/super-admin/sprint/reset
 * Resets all sprint tasks back to 'todo' and exit gates to 'pending' (SuperAdmin action).
 */
router.post('/reset', async (req, res) => {
  try {
    await sql`
      UPDATE sprint_tasks
      SET 
        status = 'todo',
        blocker_reason = null,
        completed_at = null,
        updated_at = now()
    `;

    await sql`
      UPDATE sprint_days
      SET 
        gate_status = 'pending',
        gate_notes = null,
        updated_at = now()
    `;

    const updaterName = req.superAdmin?.fullName || req.superAdmin?.email || 'Super Admin';
    await sql`
      INSERT INTO sprint_activity_logs (action, details, user_name, user_id)
      VALUES ('sprint_reset', 'Reset all 100 sprint tasks and gates to To Do', ${updaterName}, ${req.superAdmin?.id || null})
    `;

    return res.json({ success: true, message: 'All 100 tasks reset to To Do' });
  } catch (err) {
    console.error('[sprint/reset] Error:', err);
    return res.status(500).json({ error: 'Failed to reset sprint', details: err.message });
  }
});

module.exports = router;

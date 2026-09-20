/**
 * Live RBAC integration verification with isolated, automatically-cleaned
 * fixtures. No fixed passwords or permanent demo accounts are created.
 */
const crypto = require('crypto');
const express = require('express');
const routes = require('./src/routes');
const sql = require('./src/config/db');
const { hashPassword } = require('./src/utils/passwords');
const { createSession } = require('./src/services/sessionService');
const { ALL_PERMISSIONS, getRolePermissions, ROLES, PERMISSIONS } = require('./src/config/rbac');

let server;
let baseUrl;
const fixtureIds = [];
const fixtureComplaintIds = [];

async function request(method, path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { /* response body is optional */ }
  return { status: response.status, data };
}

async function createFixture({ prefix, role, managerId = null, status = 'ACTIVE', schoolIds = [] }) {
  const password = `Rbac-${crypto.randomBytes(12).toString('hex')}!`;
  const suffix = crypto.randomBytes(5).toString('hex').toUpperCase();
  const phone = `+919${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const [user] = await sql`
    INSERT INTO internal_users (
      employee_id, full_name, email, phone, password_hash, role, manager_id,
      territory, status
    ) VALUES (
      ${`${prefix}-${suffix}`}, ${`RBAC Test ${prefix}`},
      ${`rbac-${prefix.toLowerCase()}-${suffix.toLowerCase()}@example.invalid`}, ${phone},
      ${hashPassword(password)}, ${role}, ${managerId}, 'Automated verification', ${status}
    )
    RETURNING id, employee_id, full_name, email, phone, role, token_version
  `;
  fixtureIds.push(user.id);
  for (const schoolId of schoolIds) {
    await sql`
      INSERT INTO internal_user_schools (user_id, school_id, assigned_by)
      VALUES (${user.id}, ${schoolId}, ${managerId})
    `;
  }
  return { ...user, password };
}

async function cleanup() {
  if (fixtureComplaintIds.length) {
    await sql`DELETE FROM support_ticket_notes WHERE ticket_id IN ${sql(fixtureComplaintIds)}`;
    await sql`DELETE FROM complaints WHERE id::text IN ${sql(fixtureComplaintIds)}`;
  }
  if (fixtureIds.length) {
    await sql`DELETE FROM audit_logs WHERE user_id IN ${sql(fixtureIds)}`;
    await sql`DELETE FROM internal_users WHERE id IN ${sql(fixtureIds)}`;
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await sql.end();
}

async function run() {
  let passed = 0;
  let failed = 0;
  const check = (condition, label) => {
    if (condition) { passed += 1; console.log(`PASS  ${label}`); }
    else { failed += 1; console.error(`FAIL  ${label}`); }
  };

  try {
    const schoolRows = await sql`SELECT id FROM schools ORDER BY id LIMIT 2`;
    if (schoolRows.length < 2) throw new Error('RBAC verification needs at least two schools');
    const [schoolA, schoolB] = schoolRows.map((row) => Number(row.id));

    const founder = await createFixture({ prefix: 'FDR', role: ROLES.FOUNDER });
    const salesManager = await createFixture({ prefix: 'SM', role: ROLES.SALES_MANAGER });
    const salesA = await createFixture({ prefix: 'SEA', role: ROLES.SALES_EXECUTIVE, managerId: salesManager.id, schoolIds: [schoolA] });
    const salesB = await createFixture({ prefix: 'SEB', role: ROLES.SALES_EXECUTIVE, managerId: salesManager.id, schoolIds: [schoolB] });
    const implementationExecutive = await createFixture({ prefix: 'IE', role: ROLES.IMPLEMENTATION_EXECUTIVE, schoolIds: [schoolA] });
    const supportManager = await createFixture({ prefix: 'SUPM', role: ROLES.SUPPORT_MANAGER, schoolIds: [schoolA] });
    const supportExecutive = await createFixture({ prefix: 'SUPE', role: ROLES.SUPPORT_EXECUTIVE, managerId: supportManager.id, schoolIds: [schoolA] });
    const disabled = await createFixture({ prefix: 'DIS', role: ROLES.SALES_EXECUTIVE, status: 'INACTIVE' });

    const [founderSession, salesManagerSession, salesASession, implementationSession, supportManagerSession, supportSession] = await Promise.all([
      createSession(founder), createSession(salesManager), createSession(salesA),
      createSession(implementationExecutive), createSession(supportManager), createSession(supportExecutive),
    ]);

    const app = express();
    app.use(express.json());
    app.use('/', routes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const employeeLogin = await request('POST', '/api/super-admin/auth/login', null, {
      identifier: salesA.employee_id,
      password: salesA.password,
    });
    const emailLogin = await request('POST', '/api/super-admin/auth/login', null, {
      identifier: implementationExecutive.email,
      password: implementationExecutive.password,
    });
    const phoneLogin = await request('POST', '/api/super-admin/auth/login', null, {
      identifier: salesManager.phone,
      password: salesManager.password,
    });
    check(employeeLogin.status === 200 && employeeLogin.data?.role === ROLES.SALES_EXECUTIVE,
      'Login accepts Employee ID and resolves role');
    check(emailLogin.status === 200 && emailLogin.data?.role === ROLES.IMPLEMENTATION_EXECUTIVE,
      'Login accepts email and resolves role');
    check(phoneLogin.status === 200 && phoneLogin.data?.role === ROLES.SALES_MANAGER,
      'Login accepts phone and resolves role');

    check((await request('GET', '/api/super-admin/users', founderSession.access_token)).status === 200,
      'Founder can access team management');
    const founderProfile = await request('GET', '/api/super-admin/auth/me', founderSession.access_token);
    check(
      founderProfile.status === 200 && ALL_PERMISSIONS.every((permission) => founderProfile.data?.permissions?.includes(permission)),
      'Founder receives every permission from server-side policy',
    );
    check((await request('GET', `/api/super-admin/schools/${schoolB}`, founderSession.access_token)).status === 200,
      'Founder can access an unassigned school');
    check((await request('GET', '/api/super-admin/admins', salesManagerSession.access_token)).status === 403,
      'Sales Manager cannot access founder-only administration');

    const scopedTeam = await request('GET', '/api/super-admin/users', salesManagerSession.access_token);
    const scopedIds = (scopedTeam.data?.data || []).map((user) => user.id);
    check(scopedTeam.status === 200 && scopedIds.includes(salesA.id) && scopedIds.includes(salesB.id),
      'Sales Manager can view direct reports');
    check(!scopedIds.includes(founder.id), 'Sales Manager team listing excludes Founder');

    const permissionUpdate = await request(
      'PUT',
      `/api/super-admin/users/${salesA.id}/permissions`,
      founderSession.access_token,
      { overrides: [{ permission: PERMISSIONS.BUILDS_APPROVE, effect: 'GRANT' }] },
    );
    const refreshedProfile = await request('GET', '/api/super-admin/auth/me', salesASession.access_token);
    check(
      permissionUpdate.status === 200 && refreshedProfile.data?.permissions?.includes(PERMISSIONS.BUILDS_APPROVE),
      'Founder permission override changes effective access without trusting JWT claims',
    );

    check((await request('GET', `/api/super-admin/schools/${schoolA}`, salesASession.access_token)).status === 200,
      'Sales Executive A can access assigned School A');
    check((await request('GET', `/api/super-admin/schools/${schoolB}`, salesASession.access_token)).status === 403,
      'Sales Executive A cannot access Sales Executive B school by direct API');
    check((await request('GET', `/api/super-admin/checklist/${schoolA}`, salesASession.access_token)).status === 200,
      'Sales Executive A can access assigned-school onboarding checklist');
    check((await request('GET', `/api/super-admin/checklist/${schoolB}`, salesASession.access_token)).status === 403,
      'Checklist direct API also enforces school isolation');
    check((await request('GET', '/api/super-admin/requirements', salesASession.access_token)).status === 200,
      'Assigned-school requirements endpoint is available to Sales Executive');
    check((await request('GET', '/api/super-admin/support/tickets', supportSession.access_token)).status === 200,
      'Support Executive can load the authorized ticket queue');

    const createdTicket = await request('POST', '/api/super-admin/support/tickets', supportManagerSession.access_token, {
      school_id: schoolA,
      title: 'Isolated RBAC support lifecycle verification',
      description: 'Temporary ticket deleted automatically after verification.',
      category: 'SOFTWARE_BUG',
      priority: 'MEDIUM',
      assigned_to: supportExecutive.id,
    });
    if (createdTicket.data?.data?.id) fixtureComplaintIds.push(String(createdTicket.data.data.id));
    check(createdTicket.status === 201 && createdTicket.data?.data?.assigned_to === supportExecutive.id,
      'Support Manager can assign a ticket to a direct Support Executive');
    const escalatedTicket = createdTicket.data?.data?.id
      ? await request('PATCH', `/api/super-admin/support/tickets/${createdTicket.data.data.id}`, supportSession.access_token, { status: 'ESCALATED' })
      : { status: 0, data: null };
    check(escalatedTicket.status === 200 && escalatedTicket.data?.data?.status === 'ESCALATED',
      'Assigned Support Executive can escalate a ticket');
    const reprioritizedTicket = createdTicket.data?.data?.id
      ? await request('PATCH', `/api/super-admin/support/tickets/${createdTicket.data.data.id}`, supportManagerSession.access_token, { priority: 'CRITICAL' })
      : { status: 0, data: null };
    check(reprioritizedTicket.status === 200 && reprioritizedTicket.data?.data?.priority === 'CRITICAL',
      'Support Manager can change ticket priority');

    check((await request('PATCH', `/api/super-admin/schools/${schoolA}/app-config`, implementationSession.access_token, {
      force_update_enabled: false,
    })).status === 403, 'Implementation Executive cannot modify high-level app configuration');
    check(!getRolePermissions(ROLES.IMPLEMENTATION_EXECUTIVE).includes(PERMISSIONS.BUILDS_APPROVE),
      'Implementation Executive cannot approve builds');
    check(!getRolePermissions(ROLES.IMPLEMENTATION_EXECUTIVE).includes(PERMISSIONS.DEPLOYMENTS_APPROVE),
      'Implementation Executive cannot approve deployments');

    check((await request('PATCH', `/api/super-admin/schools/${schoolA}/app-config`, supportSession.access_token, {
      force_update_enabled: false,
    })).status === 403, 'Support Executive cannot modify school configuration');

    check((await request('POST', '/api/super-admin/auth/login', null, {
      identifier: disabled.employee_id,
      password: disabled.password,
    })).status === 403, 'Disabled user cannot log in');

    const logout = await request('POST', '/api/super-admin/auth/logout', salesASession.access_token);
    const afterLogout = await request('GET', '/api/super-admin/auth/me', salesASession.access_token);
    check(logout.status === 200 && afterLogout.status === 401, 'Logout invalidates the server-side session');

    console.log(`\nRBAC verification: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  return cleanup();
});

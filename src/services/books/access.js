const { randomBytes, randomUUID } = require('node:crypto');
const { hashPassword } = require('../../utils/passwords');
const { ensure, required, uuid } = require('./domain');
const { BOOKS_MODULES, BOOKS_PERMISSIONS, validateGrants, BOOKS_PERMISSION_SET } = require('../../config/booksPermissions');
const { companiesFor, managesTeam } = require('./organizations');
function createBooksAccessService(db) {
  const actorId = actor => typeof actor === 'string' ? actor : actor?.id || null;
  async function principal(tx, actor) {
    if (!actor) return { isFounder: true, id: null }; // Trusted provisioning CLI only.
    const [row] = await tx`SELECT id,role,status FROM public.internal_users WHERE id=${uuid(actorId(actor))}`;
    ensure(row?.status === 'ACTIVE' && ['FOUNDER','SUPER_ADMIN','CA_LEAD'].includes(row.role), 'Only the Founder / Super Admin or lead CA can manage accountants', 403);
    return { ...row, isFounder: ['FOUNDER','SUPER_ADMIN'].includes(row.role) };
  }
  async function audit(tx, target, actor, action, details = {}) {
    await tx`INSERT INTO public.books_access_events(target_user_id,actor_id,action,details) VALUES(${target},${actorId(actor)},${action},${tx.json(details)})`;
  }
  async function targetUser(tx, id, actor, lock = false) {
    const a = await principal(tx, actor);
    const rows = lock ? await tx`SELECT id,role,status,employee_id,manager_id FROM public.internal_users WHERE id=${uuid(id)} FOR UPDATE` : await tx`SELECT id,role,status,employee_id,manager_id FROM public.internal_users WHERE id=${uuid(id)}`;
    const user = rows[0];
    ensure(user && ['CA','CA_LEAD'].includes(user.role), 'CA account not found', 404);
    if (!a.isFounder) ensure(user.role === 'CA' && user.manager_id === a.id && user.id !== a.id, 'You can manage only CAs reporting to you', 403);
    return { user, a };
  }
  async function manager(tx, id) {
    if (!id) return null;
    const [row] = await tx`SELECT id FROM public.internal_users WHERE id=${uuid(id)} AND role='CA_LEAD' AND status='ACTIVE'`;
    ensure(row, 'Choose an active lead CA'); return row.id;
  }
  async function grants(tx, id, input, actor, role, a) {
    let assignments = input.company_access;
    if (assignments === undefined) {
      const [company] = await tx`SELECT id FROM public.books_companies WHERE code='nexsyrus'`;
      assignments = [{ company_id: company.id, permissions: input.permissions ?? [] }];
    }
    ensure(Array.isArray(assignments), 'Choose company access');
    const visible = await companiesFor(tx, a);
    const ids = new Set(), all = new Set();
    for (const assignment of assignments) {
      const companyId = uuid(assignment.company_id);
      ensure(!ids.has(companyId), 'Duplicate company assignment'); ids.add(companyId);
      ensure(visible.some(c => c.id === companyId), 'You cannot grant access to this company', 403);
      const error = validateGrants(assignment.permissions); ensure(!error, error);
      assignment.permissions.forEach(p => all.add(p));
    }
    await tx`DELETE FROM public.books_company_access WHERE user_id=${id}`;
    for (const assignment of role === 'CA_LEAD' ? [] : assignments) await tx`INSERT INTO public.books_company_access(user_id,company_id,permissions) VALUES(${id},${assignment.company_id},${tx.json(assignment.permissions)})`;
    await tx`DELETE FROM public.internal_user_permission_overrides WHERE user_id=${id}`;
    for (const p of role === 'CA_LEAD' ? [] : all) await tx`INSERT INTO public.internal_user_permission_overrides(user_id,permission,effect) VALUES(${id},${p},'GRANT')`;
    await audit(tx, id, actor, 'permissions_changed', { role, company_access: role === 'CA_LEAD' ? 'all_companies_full_accounting' : assignments });
    return { permissions: role === 'CA_LEAD' ? BOOKS_PERMISSIONS : [...all], company_access: role === 'CA_LEAD' ? [] : assignments };
  }
  return {
    catalog: () => BOOKS_MODULES,
    async options(actor) {
      const a = await principal(db, actor);
      return { companies: await companiesFor(db, a), leads: a.isFounder ? await db`SELECT id,full_name,email FROM public.internal_users WHERE role='CA_LEAD' AND status='ACTIVE' ORDER BY full_name` : [], can_assign_lead: a.isFounder };
    },
    async list(actor) {
      const a = await principal(db, actor);
      const rows = await db`SELECT id,full_name,email,employee_id,role,manager_id,status,must_change_password,last_login,created_at FROM public.internal_users WHERE role IN ('CA','CA_LEAD') AND (${a.isFounder} OR (role='CA' AND manager_id=${a.id})) ORDER BY created_at DESC`;
      for (const row of rows) {
        row.company_access = await db`SELECT company_id,permissions FROM public.books_company_access WHERE user_id=${row.id}`;
        row.permissions = row.role === 'CA_LEAD' ? BOOKS_PERMISSIONS : [...new Set(row.company_access.flatMap(c => c.permissions))].filter(p => BOOKS_PERMISSION_SET.has(p));
      }
      return rows;
    },
    async create(input, actor = null) {
      const email = required(input.email, 'Email').toLowerCase();
      ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email');
      const name = required(input.full_name, 'Full name');
      const password = input.password || randomBytes(24).toString('base64url');
      ensure(typeof password === 'string' && password.length >= 12 && password.length <= 256, 'Use a password of 12–256 characters');
      const employeeId = input.employee_id ? required(input.employee_id, 'Employee ID').toUpperCase() : `CA-${randomUUID().slice(0,8).toUpperCase()}`;
      ensure(/^[A-Z0-9-]{3,40}$/.test(employeeId), 'Employee ID must use 3–40 letters, numbers or hyphens');
      const hash = hashPassword(password);
      const result = await db.begin(async tx => {
        const a = await principal(tx, actor), role = input.role || 'CA';
        ensure(['CA','CA_LEAD'].includes(role), 'Choose a CA role');
        ensure(role !== 'CA_LEAD' || a.isFounder, 'Only the Founder / Super Admin can appoint a lead CA', 403);
        if (!a.isFounder && input.manager_id) ensure(input.manager_id === a.id, 'Accountants you create must report to you', 403);
        const managerId = role === 'CA_LEAD' ? null : a.isFounder ? await manager(tx, input.manager_id) : a.id;
        const [existing] = await tx`SELECT id FROM public.internal_users WHERE lower(trim(email))=${email} OR upper(employee_id)=${employeeId}`;
        ensure(!existing, 'This email or employee ID already belongs to an account', 409);
        const [row] = await tx`INSERT INTO public.internal_users(full_name,email,employee_id,password_hash,role,status,must_change_password,job_title,manager_id,books_company_scoped) VALUES(${name},${email},${employeeId},${hash},${role},'ACTIVE',true,${role === 'CA_LEAD' ? 'Lead Chartered Accountant' : 'Chartered Accountant'},${managerId},true) RETURNING id,full_name,email,employee_id,role,manager_id,status,must_change_password`;
        const saved = await grants(tx, row.id, input, actor, role, a);
        await audit(tx, row.id, actor, 'account_created', { email, employee_id: employeeId, role, manager_id: managerId });
        return { ...row, ...saved };
      });
      return { ...result, temporary_password: password };
    },
    async update(id, input, actor) {
      ensure(['ACTIVE','SUSPENDED'].includes(input.status), 'Choose active or suspended status');
      return db.begin(async tx => {
        const { user, a } = await targetUser(tx, id, actor, true), role = input.role || user.role;
        ensure(['CA','CA_LEAD'].includes(role), 'Choose a CA role');
        ensure(a.isFounder || role === 'CA', 'Only the Founder / Super Admin can appoint a lead CA', 403);
        if (!a.isFounder && input.manager_id) ensure(input.manager_id === a.id, 'You cannot reassign accountants to another lead', 403);
        ensure(a.id !== id, 'You cannot change your own accounting authority', 403);
        const managerId = role === 'CA_LEAD' ? null : a.isFounder ? await manager(tx, input.manager_id === undefined ? user.manager_id : input.manager_id) : a.id;
        const saved = await grants(tx, id, input, actor, role, a);
        const changed = user.status !== input.status || user.role !== role || user.manager_id !== managerId;
        const [row] = await tx`UPDATE public.internal_users SET full_name=${required(input.full_name,'Full name')},role=${role},manager_id=${managerId},job_title=${role === 'CA_LEAD' ? 'Lead Chartered Accountant' : 'Chartered Accountant'},status=${input.status},token_version=token_version+${changed ? 1 : 0},updated_at=now() WHERE id=${id} RETURNING id,full_name,email,employee_id,role,manager_id,status,must_change_password`;
        if (changed) await tx`UPDATE public.internal_user_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
        await audit(tx, id, actor, 'account_updated', { role, status: input.status, manager_id: managerId });
        return { ...row, ...saved };
      });
    },
    async resetPassword(id, actor) {
      const password = randomBytes(24).toString('base64url'), hash = hashPassword(password);
      await db.begin(async tx => {
        await targetUser(tx, id, actor, true);
        await tx`UPDATE public.internal_users SET password_hash=${hash},must_change_password=true,token_version=token_version+1,updated_at=now() WHERE id=${id}`;
        await tx`UPDATE public.internal_user_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=${id}`;
        await audit(tx, id, actor, 'password_reset');
      });
      return { temporary_password: password };
    },
  };
}
module.exports = { createBooksAccessService };

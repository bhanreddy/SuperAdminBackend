const { AsyncLocalStorage } = require('node:async_hooks');
const { ensure, uuid } = require('./domain');
const { BOOKS_PERMISSIONS } = require('../../config/booksPermissions');
const accountingRole = role => ['CA', 'CA_LEAD'].includes(role);
const managesTeam = user => Boolean(user?.isFounder || user?.role === 'CA_LEAD');
async function companiesFor(db, user) {
  if (managesTeam(user)) return (await db`SELECT id,code,name FROM public.books_companies WHERE active ORDER BY code DESC`).map(c => ({ ...c, permissions: BOOKS_PERMISSIONS }));
  if (user.role === 'CA') return db`SELECT c.id,c.code,c.name,a.permissions FROM public.books_companies c JOIN public.books_company_access a ON a.company_id=c.id WHERE a.user_id=${user.id} AND c.active ORDER BY c.code DESC`;
  return (await db`SELECT id,code,name FROM public.books_companies WHERE active AND code='nexsyrus'`).map(c => ({ ...c, permissions: user.permissions.filter(p => p.startsWith('books.')) }));
}
// A transaction-local search_path scopes every query and trigger to one company.
// AsyncLocalStorage keeps concurrent requests independent; pooled connections are reset at commit.
function createOrganizationContext(db) {
  const context = new AsyncLocalStorage();
  const current = () => context.getStore() || db;
  function transactionAdapter(tx) {
    const adapted = (...args) => tx(...args);
    // Reuse the request transaction: journal immutability checks require the header
    // and its lines to share the top-level transaction ID, including their xmin.
    adapted.begin = fn => fn(adapted);
    adapted.json = (...args) => tx.json(...args);
    adapted.unsafe = (...args) => tx.unsafe(...args);
    return adapted;
  }
  const scoped = new Proxy((...args) => current()(...args), {
    get(_target, key) { const value = current()[key]; return typeof value === 'function' ? value.bind(current()) : value; },
  });
  async function run(req, fn) {
    const visible = await companiesFor(db, req.user);
    const requested = req.headers['x-books-company-id'];
    const id = requested ? uuid(requested) : visible[0]?.id;
    ensure(id, 'No company has been assigned to this CA account', 403);
    const company = visible.find(c => c.id === id);
    ensure(company, 'Access to this company has not been granted', 403);
    const [row] = await db`SELECT schema_name FROM public.books_companies WHERE id=${id} AND active`;
    ensure(row && /^(public|books_[a-z0-9_]+)$/.test(row.schema_name), 'Company books are unavailable', 503);
    req.booksCompany = company;
    req.user = { ...req.user, permissions: company.permissions };
    return db.begin(async tx => {
      await tx`SELECT set_config('search_path',${`"${row.schema_name}", pg_catalog`},true)`;
      return context.run(transactionAdapter(tx), fn);
    });
  }
  return { sql: scoped, run };
}
module.exports = { accountingRole, managesTeam, companiesFor, createOrganizationContext };

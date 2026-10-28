const { ensure } = require("./domain");
const sources = [
  {
    kind: "expense",
    table: "expenses",
    label: "Operating expenses",
    eligible: "status='APPROVED' AND school_id IS NULL",
    component: "accrual",
    amount: "amount",
  },
  {
    kind: "collection",
    table: "collections",
    label: "Business collections",
    eligible: "status='APPROVED'",
    component: "payment",
    amount: "amount",
  },
  {
    kind: "billing",
    table: "billing_documents",
    label: "Client invoices & receipts",
    eligible: "status='issued'",
    amount: "total_amount",
  },
  {
    kind: "payroll",
    table: "payroll_runs",
    label: "Payroll",
    eligible: "status IN ('PROCESSED','PAID') AND gross_pay>0",
    component: "accrual",
    amount: "gross_pay",
  },
];
// Identifiers below are constants; values remain SQL parameters. Never accept table names from callers.
function createFinanceConnections(db) {
  async function requireCentral() {
    const [r] = await db`SELECT current_schema() AS schema`;
    ensure(
      r.schema === "public",
      "Platform finances connect to Nexsyrus only. Switch to Nexsyrus to view connections.",
      400
    );
  }
  return {
    async overview() {
      await requireCentral();
      const summary = [];
      for (const s of sources) {
        const [row] = await db.unsafe(
          `SELECT count(*)::int AS eligible,
          count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.books_finance_links l WHERE l.source_type=$1 AND l.source_id=s.id))::int AS unlinked,
          COALESCE(sum(round(s.${s.amount}*100)) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.books_finance_links l WHERE l.source_type=$1 AND l.source_id=s.id)),0)::text AS unlinked_amount
          FROM public.${s.table} s WHERE ${s.eligible}`,
          [s.kind]
        );
        summary.push({ source_type: s.kind, label: s.label, ...row });
      }
      const rows =
        await db`SELECT l.*,j.notes FROM public.books_finance_links l JOIN public.books_journals j ON j.id=l.journal_id ORDER BY l.updated_at DESC,l.source_id LIMIT 200`;
      return { summary, rows, limit: 200 };
    },
    async importExisting(actor) {
      await requireCentral();
      // Runs inside the company request transaction; lock source rows before updating links.
      let imported = 0;
      for (const s of sources) {
        if (imported >= 200) break;
        const rows = await db.unsafe(
          `SELECT to_jsonb(s) AS data FROM public.${s.table} s
          WHERE ${s.eligible} AND NOT EXISTS(SELECT 1 FROM public.books_finance_links l WHERE l.source_type=$1 AND l.source_id=s.id)
          ORDER BY s.id LIMIT $2 FOR UPDATE OF s`,
          [s.kind, 200 - imported]
        );
        for (const row of rows) {
          await db`SELECT public.books_sync_finance(${s.kind},${db.json(
            row.data
          )})`;
          imported++;
        }
      }
      await db`INSERT INTO books_activity(entity,entity_id,action,actor,details) VALUES('finance_connection',gen_random_uuid(),'imported',${actor},${db.json(
        { imported }
      )})`;
      return { imported, ...(await this.overview()) };
    },
  };
}
module.exports = { createFinanceConnections };

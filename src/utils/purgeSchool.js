/**
 * Permanently purge a school and all tenant data.
 *
 * Schools CASCADE to most child tables, but:
 * 1) roles has triggers that block deleting seeded system roles
 * 2) several tables reference users with NO ACTION / RESTRICT, so cascading
 *    user deletes fail even when those tables also CASCADE from schools
 *    (Postgres does not guarantee sibling-cascade order)
 *
 * This helper clears those blockers, then deletes the school row.
 */
async function purgeSchool(sql, schoolId) {
  return sql.begin(async (tx) => {
    await tx`ALTER TABLE roles DISABLE TRIGGER trg_protect_system_roles_delete`;
    await tx`ALTER TABLE roles DISABLE TRIGGER trg_protect_system_roles_update`;

    try {
      const users = await tx`SELECT id FROM users WHERE school_id = ${schoolId}`;
      const userIds = users.map((u) => u.id);

      // Direct school-level NO ACTION FKs
      await tx`DELETE FROM timetable_slots WHERE school_id = ${schoolId}`;
      await tx`DELETE FROM audit_logs WHERE school_id = ${schoolId}`;
      await tx`DELETE FROM context_switch_logs WHERE school_id = ${schoolId}`;

      if (userIds.length > 0) {
        // Logs may reference school users with a different/null school_id
        await tx`DELETE FROM audit_logs WHERE user_id = ANY(${userIds})`;
        await tx`DELETE FROM context_switch_logs WHERE user_id = ANY(${userIds})`;

        const blockers = await tx`
          SELECT
            child.relname AS table_name,
            att.attname AS column_name,
            att.attnotnull AS not_null,
            EXISTS (
              SELECT 1
              FROM pg_attribute school_att
              WHERE school_att.attrelid = child.oid
                AND school_att.attname = 'school_id'
                AND NOT school_att.attisdropped
            ) AS has_school_id
          FROM pg_constraint c
          JOIN pg_class child ON child.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = child.relnamespace AND n.nspname = 'public'
          JOIN pg_class parent ON parent.oid = c.confrelid
          JOIN pg_attribute att
            ON att.attrelid = c.conrelid
           AND att.attnum = c.conkey[1]
           AND NOT att.attisdropped
          WHERE c.contype = 'f'
            AND parent.relname = 'users'
            AND c.confdeltype IN ('a', 'r') -- NO ACTION / RESTRICT
            AND array_length(c.conkey, 1) = 1
            AND child.relname NOT IN ('audit_logs', 'context_switch_logs')
          ORDER BY child.relname, att.attname
        `;

        const schoolScopedTables = new Set();

        for (const b of blockers) {
          if (!isSafeIdent(b.table_name) || !isSafeIdent(b.column_name)) {
            throw new Error(`Refusing unsafe identifier while purging school: ${b.table_name}.${b.column_name}`);
          }

          if (!b.not_null) {
            await tx.unsafe(
              `UPDATE "${b.table_name}" SET "${b.column_name}" = NULL WHERE "${b.column_name}" = ANY($1::uuid[])`,
              [userIds]
            );
            continue;
          }

          if (b.has_school_id) {
            schoolScopedTables.add(b.table_name);
            continue;
          }

          await tx.unsafe(
            `DELETE FROM "${b.table_name}" WHERE "${b.column_name}" = ANY($1::uuid[])`,
            [userIds]
          );
        }

        // Delete school-scoped rows that still hold NOT NULL user FKs.
        // Message graph first to avoid intra-tenant FK failures.
        const ordered = prioritizeSchoolScopedDeletes([...schoolScopedTables]);
        for (const tableName of ordered) {
          await tx.unsafe(`DELETE FROM "${tableName}" WHERE school_id = $1`, [schoolId]);
        }
      }

      const [row] = await tx`
        DELETE FROM schools
        WHERE id = ${schoolId}
        RETURNING *
      `;
      return row || null;
    } finally {
      await tx`ALTER TABLE roles ENABLE TRIGGER trg_protect_system_roles_delete`;
      await tx`ALTER TABLE roles ENABLE TRIGGER trg_protect_system_roles_update`;
    }
  });
}

function isSafeIdent(name) {
  return typeof name === 'string' && /^[a-z_][a-z0-9_]*$/.test(name);
}

function prioritizeSchoolScopedDeletes(tables) {
  const priority = [
    'message_typing',
    'messages',
    'message_participants',
    'message_conversations',
  ];
  const rest = tables.filter((t) => !priority.includes(t)).sort();
  return [...priority.filter((t) => tables.includes(t)), ...rest];
}

module.exports = { purgeSchool };

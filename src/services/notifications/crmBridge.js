function createCrmNotificationBridge(schoolSql, crmSql) {
  return async function copy() {
    // Bounded batch. Multiple instances may race, but the target source key is
    // unique and the source is acknowledged only after the target commits.
    const events =
      await crmSql`SELECT * FROM crm_notification_outbox WHERE copied_at IS NULL ORDER BY created_at,id LIMIT 100`;
    for (const event of events) {
      const recipients =
        await schoolSql`SELECT DISTINCT u.id FROM internal_users u
        WHERE u.id=ANY(${schoolSql.array(event.user_ids)}::uuid[]) OR u.auth_user_id=ANY(${schoolSql.array(event.user_ids)}::uuid[])
        OR EXISTS(SELECT 1 FROM founders f WHERE f.id=ANY(${schoolSql.array(event.founder_ids)}::uuid[]) AND (f.user_id=u.id OR f.user_id=u.auth_user_id))`;
      // All payloads are generic signals. CRM authorization and owner scope are
      // checked by its existing API when opening the record, never widened here.
      await schoolSql`INSERT INTO notification_events(source_key,channel,kind,title,priority,audience,created_at)
        VALUES(${`crm:${event.id}`},${event.channel},${event.kind},${event.title},${event.priority},
          ${schoolSql.json({ mode: "direct", user_ids: recipients.map((r) => r.id), include_founders: true })},${event.created_at})
        ON CONFLICT(source_key) DO NOTHING`;
      await crmSql`UPDATE crm_notification_outbox SET copied_at=now() WHERE id=${event.id}`;
    }
    return events.length;
  };
}
module.exports = { createCrmNotificationBridge };

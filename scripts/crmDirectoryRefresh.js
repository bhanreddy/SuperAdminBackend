require('../src/config/env');
const crmSql = require('../src/config/crmDb');
const schoolSql = require('../src/config/db');
const { refreshLiveDirectory } = require('../src/services/crm/customerDirectory');

refreshLiveDirectory(crmSql, schoolSql).then((report) => {
  console.log(JSON.stringify({ event: 'directory_refresh', complete: report.complete, clusters: report.clusters.map((row) => ({ cluster_id: row.cluster_id, status: row.status, fresh: row.fresh, school_count: row.school_count })) }));
  process.exit(report.complete ? 0 : 2);
}).catch((err) => {
  console.error(err.code || err.message);
  process.exit(1);
});

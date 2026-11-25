const sql = require("../../config/db");
const { createProviders } = require("./providers");
const { createNotificationService } = require("./service");
const { createNotificationWorker } = require("./worker");
const providers = createProviders();
const config = require("../../config/env");
const bridge = config.crmDatabaseUrl
  ? require("./crmBridge").createCrmNotificationBridge(
      sql,
      require("../../config/crmDb"),
    )
  : null;
module.exports = {
  service: createNotificationService(sql, providers.capabilities),
  worker: createNotificationWorker(sql, providers, bridge),
};

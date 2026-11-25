const {
  createNotificationRouter,
} = require("../../services/notifications/router");
const { service } = require("../../services/notifications");
const { authenticateUser } = require("../../middleware/rbac");
module.exports = createNotificationRouter({
  service,
  authenticate: authenticateUser,
});

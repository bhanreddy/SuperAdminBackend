const express = require("express");
const { asyncHandler } = require("../../middleware/errorHandler");
const { check } = require("./catalog");
function createNotificationRouter({ service, authenticate }) {
  const router = express.Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    // The inbox FK must never bind an unsynced legacy identity to another user.
    if (req.user.legacyDirectory)
      return res.status(409).json({
        error:
          "Your account must be synced into the employee directory before using notifications",
      });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(
    asyncHandler(async (req, res, next) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
        await service.rateLimit(req.user);
      next();
    }),
  );
  const route = (method, path, fn, status = 200) =>
    router[method](
      path,
      asyncHandler(async (req, res) =>
        res.status(status).json({ success: true, ...(await fn(req)) }),
      ),
    );
  route("get", "/bootstrap", async (req) => ({
    data: await service.bootstrap(req.user),
  }));
  route("get", "/", (req) => service.list(req.user, req.query));
  route("post", "/read-all", async (req) => ({
    data: await service.readAll(req.user, req.body),
  }));
  route("patch", "/preferences/:channel", async (req) => ({
    data: await service.setPreferences(req.user, req.params.channel, req.body),
  }));
  route(
    "post",
    "/announcements",
    async (req) => ({
      data: await service.publish(
        req.user,
        req.body,
        req.get("Idempotency-Key"),
      ),
    }),
    202,
  );
  route(
    "post",
    "/devices",
    async (req) => ({ data: await service.registerDevice(req.user, req.body) }),
    201,
  );
  route("get", "/devices/current", async (req) => ({
    data: await service.deviceStatus(req.user),
  }));
  route("delete", "/devices/current", (req) =>
    service.removeSessionDevices(req.user),
  );
  route("delete", "/devices/:id", (req) =>
    service.removeDevice(req.user, req.params.id),
  );
  route("get", "/health", async (req) => ({
    data: await service.health(req.user),
  }));
  route("post", "/events/:id/retry", async (req) => ({
    data: await service.retryEvent(req.user, req.params.id),
  }));
  route("post", "/deliveries/:id/retry", async (req) => ({
    data: await service.retry(req.user, req.params.id),
  }));
  route("patch", "/:id", async (req) => {
    check(
      req.body && typeof req.body.operation === "string",
      "An operation is required",
    );
    return {
      data: await service.update(req.user, req.params.id, req.body.operation),
    };
  });
  return router;
}
module.exports = { createNotificationRouter };

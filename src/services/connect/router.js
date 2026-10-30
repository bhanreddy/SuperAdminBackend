const express = require('express');

function createConnectRouter({
  service,
  authenticate,
  realtimeSession,
  extensions,
}) {
  const router = express.Router();
  const attempts = new Map();
  function throttle(key, limit) {
    const minute = Math.floor(Date.now() / 60000),
      old = attempts.get(key);
    const entry = old?.minute === minute ? old : { minute, count: 0 };
    entry.count++;
    attempts.set(key, entry);
    if (attempts.size > 10000) attempts.delete(attempts.keys().next().value);
    return entry.count <= limit;
  }
  router.use((req, res, next) =>
    throttle(`ip:${req.ip}`, 6000)
      ? next()
      : res.status(429).json({ error: 'Too many requests; try again shortly' }),
  );
  router.use(authenticate);
  // The shared guard supports legacy school Supabase logins too. Confidential
  // company communication requires an existing internal session, never an email match.
  router.use((req, res, next) =>
    req.user?.tokenSource === 'internal' && req.user?.sessionId
      ? next()
      : res
          .status(403)
          .json({
            error: 'Sign in with your internal employee account to use Connect',
          }),
  );
  router.use((req, res, next) =>
    throttle(`user:${req.user.id}`, 240)
      ? next()
      : res.status(429).json({ error: 'Too many requests; try again shortly' }),
  );
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const route = (method, path, fn) =>
    router[method](path, async (req, res) => {
      try {
        const value = await fn(req);
        res.json(value);
      } catch (err) {
        const status =
          err.status ||
          {
            42501: 403,
            23505: 409,
            23503: 400,
            23514: 400,
            '22P02': 400,
            22007: 400,
            22008: 400,
          }[err.code] ||
          500;
        if (status === 500) console.error('[Connect]', err.code || err.name);
        res
          .status(status)
          .json({
            error: err.status
              ? err.message
              : status === 409
                ? 'This record already exists'
                : status === 403
                  ? 'Access denied'
                  : status === 400
                    ? 'Invalid request or unavailable related record'
                    : 'Connect is temporarily unavailable',
          });
      }
    });
  route('get', '/bootstrap', (req) => service.bootstrap(req.user));
  route('get', '/employees', (req) =>
    service.employees(req.user, req.query.q, req.query.conversation_id),
  );
  route('post', '/employees/:id', (req) =>
    service.provisionEmployee(req.user, req.params.id),
  );
  route('delete', '/employees/:id', (req) =>
    service.provisionEmployee(req.user, req.params.id, true),
  );
  route('post', '/channels', (req) =>
    service.createChannel(req.user, req.body),
  );
  route('patch', '/channels/:id', (req) =>
    service.updateChannel(req.user, req.params.id, req.body),
  );
  route('get', '/channels/:id/members', (req) =>
    service.members(req.user, req.params.id),
  );
  route('put', '/channels/:id/members/:userId', (req) =>
    service.membership(
      req.user,
      req.params.id,
      req.params.userId,
      req.body.role,
    ),
  );
  route('delete', '/channels/:id/members/:userId', (req) =>
    service.membership(
      req.user,
      req.params.id,
      req.params.userId,
      'member',
      true,
    ),
  );
  route('post', '/direct-messages', (req) =>
    service.directMessage(req.user, req.body.employee_id),
  );
  route('get', '/conversations/:id/messages', (req) =>
    service.history(req.user, req.params.id, req.query),
  );
  route('post', '/conversations/:id/messages', (req) =>
    service.send(req.user, req.params.id, req.body),
  );
  route('post', '/conversations/:id/read', (req) =>
    service.markRead(req.user, req.params.id, req.body.last_sequence),
  );
  route('get', '/messages/:id', (req) =>
    service.getMessage(req.user, req.params.id),
  );
  route('patch', '/messages/:id', (req) =>
    service.edit(req.user, req.params.id, req.body),
  );
  route('delete', '/messages/:id', (req) =>
    service.edit(req.user, req.params.id, {}, true),
  );
  route('put', '/messages/:id/reactions', (req) =>
    service.react(req.user, req.params.id, req.body.emoji),
  );
  route('delete', '/messages/:id/reactions', (req) =>
    service.react(req.user, req.params.id, req.body.emoji, true),
  );
  route('get', '/notifications', (req) =>
    service.notifications(req.user, req.query.before),
  );
  route('post', '/notifications/:id/read', (req) =>
    service.readNotification(req.user, req.params.id),
  );
  route('put', '/preferences', (req) =>
    service.preferences(req.user, req.body),
  );
  route('get', '/search', (req) => service.search(req.user, req.query));
  if (extensions) {
    route('get', '/messages/:id/attachments', (req) =>
      extensions.attachments(req.user, req.params.id),
    );
    const upload = require('multer')({
      storage: require('multer').memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0 },
    }).single('file');
    router.post('/messages/:id/attachments', (req, res, next) =>
      upload(req, res, (error) =>
        error
          ? res
              .status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
              .json({ error: 'Choose one supported file up to 8 MB' })
          : next(),
      ),
    );
    route('post', '/messages/:id/attachments', (req) =>
      extensions.upload(req.user, req.params.id, req.file),
    );
    router.get('/attachments/:id/download', async (req, res) => {
      try {
        const file = await extensions.download(req.user, req.params.id);
        res
          .set({
            'Content-Type': file.mime,
            'Content-Disposition': `attachment; filename="download.${file.filename.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
          })
          .send(file.bytes);
      } catch (error) {
        res
          .status(error.status || 500)
          .json({
            error: error.status ? error.message : 'Attachment unavailable',
          });
      }
    });
    route('put', '/messages/:id/saved', (req) =>
      extensions.save(req.user, req.params.id),
    );
    route('delete', '/messages/:id/saved', (req) =>
      extensions.save(req.user, req.params.id, true),
    );
    route('get', '/saved', (req) => extensions.saved(req.user));
    route('put', '/messages/:id/pin', (req) =>
      extensions.pin(req.user, req.params.id),
    );
    route('delete', '/messages/:id/pin', (req) =>
      extensions.pin(req.user, req.params.id, true),
    );
    route('get', '/conversations/:id/pins', (req) =>
      extensions.pins(req.user, req.params.id),
    );
    route('get', '/presence', (req) => extensions.listPresence(req.user));
    route('put', '/presence', (req) => extensions.presence(req.user, req.body));
    route('post', '/messages/:id/task', (req) =>
      extensions.task(req.user, req.params.id, req.body),
    );
  }
  route('post', '/realtime-session', async (req) => {
    const context = await service.bootstrap(req.user);
    if (!realtimeSession) {
      const err = new Error('Realtime has not been configured');
      err.status = 503;
      throw err;
    }
    return realtimeSession(req.user, context);
  });
  return router;
}
module.exports = { createConnectRouter };

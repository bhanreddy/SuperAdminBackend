const express = require('express');
const crypto = require('crypto');
const crmSql = require('../config/crmDb');
const { verifyIngress, canonicalJson, signIngress } = require('../services/crm/trackingIngress');
const { resolveCode, rememberNonce } = require('../services/crm/trackingLinks');
const { currentTrackingConfig } = require('../services/crm/trackingConfig');
const { sendCrmError } = require('../services/crm/errors');

const router = express.Router();

router.post('/resolve', async (req, res) => {
  try {
    const config = currentTrackingConfig();
    const rawBody = canonicalJson(req.body || {});
    verifyIngress({
      secret: config.ingressSecret,
      timestamp: req.get('x-track-timestamp'),
      nonce: req.get('x-track-nonce'),
      method: 'POST',
      path: '/api/internal/track/resolve',
      rawBody,
      signature: req.get('x-track-signature'),
    });
    await rememberNonce(crmSql, String(req.get('x-track-nonce')));
    const result = await resolveCode(crmSql, {
      code: req.body?.code,
      request_id: req.body?.request_id,
      context_token: req.body?.context_token,
      browser_key: req.body?.consent ? req.body?.browser_key : null,
      consent: req.body?.consent === true,
      user_agent: req.body?.user_agent,
      purpose: req.body?.purpose,
      referrer: req.body?.referrer,
      site_origin: req.body?.site_origin,
      now: req.body?.now,
    });
    res.set('Cache-Control', 'no-store');
    if (!result.ok) {
      return res.status(result.public_status || 404).json({ ok: false });
    }
    const body = {
      ok: true,
      redirect: result.redirect,
      event_id: result.event_id,
      event_class: result.event_class,
      countable: result.countable,
      coverage: result.coverage,
      replay: Boolean(result.replay),
    };
    if (result.context?.token) body.context = result.context;
    return res.status(200).json(body);
  } catch (err) {
    return sendCrmError(res, err);
  }
});

router.get('/health', (req, res) => {
  const config = currentTrackingConfig();
  return res.status(config.resolve && config.publicOrigin && config.ingressSecret ? 200 : 503).json({
    resolve: config.resolve,
    origin_configured: Boolean(config.publicOrigin),
  });
});

module.exports = router;
module.exports.signForTests = (body, secret, now = Date.now()) => {
  const nonce = crypto.randomBytes(9).toString('base64url');
  const rawBody = canonicalJson(body);
  const signature = signIngress({
    secret,
    timestamp: now,
    nonce,
    method: 'POST',
    path: '/api/internal/track/resolve',
    rawBody,
  });
  return { nonce, timestamp: String(now), signature, rawBody };
};

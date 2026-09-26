const { sendResponse } = require('../../utils/apiResponse');
const { sendCrmError } = require('../../services/crm/errors');
const { resolveCrmScope } = require('../../services/crm/accessPolicy');
const { requireCrmWrite } = require('../../middleware/crmAccess');
const crmSql = require('../../config/crmDb');
const links = require('../../services/crm/trackingLinks');
const reports = require('../../services/crm/trackingReports');
const attribution = require('../../services/crm/trackingAttribution');
const { renderQr, qrUrl } = require('../../services/crm/trackingQr');
const { currentTrackingConfig } = require('../../services/crm/trackingConfig');

function mountTrackingRoutes(router) {
  router.get('/track-catalog', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      const founderId = scope.kind === 'platform' ? null : scope.founderId;
      const [channels, campaigns, founders, territories] = await Promise.all([
        crmSql`SELECT id, code, label FROM crm_acquisition_channels WHERE archived_at IS NULL ORDER BY label`,
        links.listCampaigns(crmSql, scope),
        crmSql`
          SELECT id, full_name FROM founders
          WHERE is_active = true AND (${founderId}::uuid IS NULL OR id = ${founderId})
          ORDER BY full_name
        `,
        crmSql`
          SELECT t.id, t.code, t.name FROM crm_territories t
          WHERE t.archived_at IS NULL
            AND (
              ${founderId}::uuid IS NULL
              OR EXISTS (SELECT 1 FROM crm_territory_members m WHERE m.territory_id = t.id AND m.founder_id = ${founderId})
            )
          ORDER BY t.name
        `,
      ]);
      const config = currentTrackingConfig();
      return sendResponse(res, 200, {
        channels,
        campaigns,
        founders,
        territories,
        destination_classes: ['OWNED_SITE', 'DOCUMENT', 'PLAY_STORE', 'APP_STORE', 'WEBSITE'],
        purposes: ['BROCHURE', 'DEMO', 'EVENT', 'LANDING'],
        media: ['QR', 'LINK'],
        origin_configured: Boolean(config.publicOrigin),
        privacy_notice: 'Link opens are not verified scans. Consented distinct browsers are not people. External destinations have unavailable conversion coverage.',
      });
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/track-campaigns', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 201, await links.createCampaign(crmSql, resolveCrmScope(req.superAdmin), req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-campaigns', async (req, res) => {
    try {
      return sendResponse(res, 200, await links.listCampaigns(crmSql, resolveCrmScope(req.superAdmin)));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.patch('/track-campaigns/:id', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 200, await links.updateCampaign(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/track-links', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 201, await links.createLink(crmSql, resolveCrmScope(req.superAdmin), req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/track-links/bulk', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 201, await links.createBulk(crmSql, resolveCrmScope(req.superAdmin), req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-links', async (req, res) => {
    try {
      return sendResponse(res, 200, await links.listLinks(crmSql, resolveCrmScope(req.superAdmin), req.query || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-report/export', async (req, res) => {
    try {
      const body = await reports.report(crmSql, resolveCrmScope(req.superAdmin), req.query || {});
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="track-report.csv"');
      res.set('Cache-Control', 'no-store');
      return res.status(200).send(reports.exportCsv(body));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-report', async (req, res) => {
    try {
      return sendResponse(res, 200, await reports.report(crmSql, resolveCrmScope(req.superAdmin), req.query || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-links/:id/qr', async (req, res) => {
    try {
      const link = await links.getLink(crmSql, resolveCrmScope(req.superAdmin), req.params.id);
      const image = await renderQr(qrUrl(link.short_code), req.query.format, req.query.size);
      res.set('Content-Type', image.contentType);
      res.set('Content-Disposition', `attachment; filename="${link.short_code}.${image.contentType.includes('svg') ? 'svg' : 'png'}"`);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(image.body);
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-links/:id/activity', async (req, res) => {
    try {
      return sendResponse(res, 200, await reports.activity(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.query || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/track-links/:id', async (req, res) => {
    try {
      return sendResponse(res, 200, await links.getLink(crmSql, resolveCrmScope(req.superAdmin), req.params.id));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.patch('/track-links/:id', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 200, await links.updateLink(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/track-links/:id/disable', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 200, await links.setLinkStatus(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.body || {}, 'DISABLED'));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/track-links/:id/enable', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 200, await links.setLinkStatus(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.body || {}, 'ACTIVE'));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/enquiries/:id/attribution', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 200, await attribution.attachTouch(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/enquiries/:id/attribution/retract', requireCrmWrite, async (req, res) => {
    try {
      return sendResponse(res, 200, await attribution.retractTouch(crmSql, resolveCrmScope(req.superAdmin), req.params.id, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });
}

module.exports = { mountTrackingRoutes };

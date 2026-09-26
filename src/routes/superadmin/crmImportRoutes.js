const multer = require('multer');
const { sendResponse } = require('../../utils/apiResponse');
const { sendCrmError, CrmError } = require('../../services/crm/errors');
const { resolveCrmScope, assertCrmWrite } = require('../../services/crm/accessPolicy');
const imports = require('../../services/crm/importService');
const recovery = require('../../services/crm/importRecovery');
const config = require('../../config/env');
const sql = require('../../config/crmDb');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: Math.max(config.crmImport.csvMaxBytes, config.crmImport.xlsxMaxBytes) },
});
const uploads = new Map();

function rateLimit(actorId) {
  const now = Date.now();
  const recent = (uploads.get(actorId) || []).filter((at) => now - at < 10 * 60 * 1000);
  if (recent.length >= 10) throw new CrmError(429, 'Upload rate limit reached. Retry in a few minutes.', 'RATE_LIMITED');
  recent.push(now);
  uploads.set(actorId, recent);
}

function mountImportRoutes(router) {
  router.get('/imports/template', async (req, res) => {
    try {
      resolveCrmScope(req.superAdmin);
      const header = ['school_name', 'udise', 'country', 'state', 'district', 'city', 'locality', 'organization_phone', 'organization_email', 'contact_1_name', 'contact_1_role', 'contact_1_phone', 'contact_2_name', 'contact_2_phone'];
      return sendResponse(res, 200, {
        filename: 'school-prospects-template.csv',
        csv: `${header.join(',')}\n`,
        fields: imports.templateFields(),
        limits: {
          csv_mib: 25,
          xlsx_mib: 10,
          rows: config.crmImport.maxRows,
          columns: config.crmImport.maxColumns,
        },
        features: config.crmFeatures,
        guidance: 'Save .xlsx values as text so UDISE keeps leading zeros. Do not upload formulas for UDISE, phone, or email.',
      });
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/imports', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await imports.listBatches(sql, scope, req.query || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/imports', (req, res) => {
    let scope;
    try {
      scope = resolveCrmScope(req.superAdmin);
      assertCrmWrite(scope);
      rateLimit(scope.actor.id);
    } catch (err) {
      return sendCrmError(res, err);
    }
    upload.single('file')(req, res, async (err) => {
      try {
        if (err) throw new CrmError(413, 'The file exceeds the upload limit. Split it into a smaller CSV or XLSX.', 'FILE_TOO_LARGE');
        if (!req.file) throw new CrmError(400, 'Choose a CSV or XLSX file.', 'FILE_REQUIRED');
        const batch = await imports.createBatch(sql, scope, req.file);
        return sendResponse(res, 202, batch);
      } catch (error) {
        return sendCrmError(res, error);
      }
    });
  });

  router.get('/imports/:batchId', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, imports.publicBatch(await imports.loadBatch(sql, scope, req.params.batchId)));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/imports/:batchId/rows', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await imports.listRows(sql, scope, req.params.batchId, req.query || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.put('/imports/:batchId/mapping', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await imports.setMapping(sql, scope, req.params.batchId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.patch('/imports/:batchId/rows/:rowId', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await imports.patchRow(sql, scope, req.params.batchId, req.params.rowId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.put('/imports/:batchId/decisions', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await imports.setDecisions(sql, scope, req.params.batchId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/imports/:batchId/preview', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 202, await imports.queuePreview(sql, scope, req.params.batchId));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/imports/:batchId/confirm', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 202, await imports.confirmBatch(sql, scope, req.params.batchId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/imports/:batchId/retry', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 202, await imports.retryBatch(sql, scope, req.params.batchId));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/imports/:batchId/cancel', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await imports.cancelBatch(sql, scope, req.params.batchId));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.get('/imports/:batchId/errors', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      const csv = await imports.errorCsv(sql, scope, req.params.batchId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="import-errors.csv"');
      return res.status(200).send(csv);
    } catch (err) {
      return sendCrmError(res, err);
    }
  });

  router.post('/imports/:batchId/compensate', async (req, res) => {
    try {
      const scope = resolveCrmScope(req.superAdmin);
      return sendResponse(res, 200, await recovery.compensate(sql, scope, req.params.batchId, req.body || {}));
    } catch (err) {
      return sendCrmError(res, err);
    }
  });
}

module.exports = { mountImportRoutes };

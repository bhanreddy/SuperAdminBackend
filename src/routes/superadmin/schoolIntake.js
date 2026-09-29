const express = require('express');
const { authenticateUser, requirePermission } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../config/rbac');
const {
  buildIntelligence,
  listIntakes,
  getIntake,
  submitIntake,
  resubmitIntake,
  founderDecision,
  approveIntake,
} = require('../../services/schoolIntake');

const router = express.Router();
router.use(authenticateUser);

function sendIntakeError(res, err, fallback) {
  const status = err.status || 500;
  if (!err.status || status >= 500) console.error(fallback, err);
  return res.status(status).json({
    error: err.status ? (err.message || fallback) : fallback,
    intelligence: err.intelligence || undefined,
  });
}

router.post('/preview', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const result = await buildIntelligence(req.body?.dossier || req.body || {}, req.body?.exclude_id || null);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not check this school dossier.');
  }
});

router.get('/', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const data = await listIntakes(req.user);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not load school intake.');
  }
});

router.get('/:id', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const data = await getIntake(req.params.id, req.user);
    if (!data) return res.status(404).json({ error: 'School dossier not found' });
    if (data.forbidden) return res.status(403).json({ error: 'You cannot open this dossier' });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not open this school dossier.');
  }
});

router.post('/', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    if (req.user.isFounder) {
      return res.status(403).json({ error: 'Founders onboard from the intake desk after a sales executive submits the dossier.' });
    }
    const data = await submitIntake(req.user, req.body?.dossier || req.body || {});
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not send this school for review.');
  }
});

router.patch('/:id', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const data = await resubmitIntake(req.user, req.params.id, req.body?.dossier || req.body || {});
    if (!data) return res.status(404).json({ error: 'School dossier not found' });
    if (data.forbidden) return res.status(403).json({ error: 'You cannot update this dossier' });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not resubmit this school dossier.');
  }
});

router.post('/:id/request-changes', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const data = await founderDecision(req.user, req.params.id, {
      status: 'CHANGES_REQUESTED',
      note: req.body?.note,
      eventType: 'CHANGES_REQUESTED',
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not send this dossier back.');
  }
});

router.post('/:id/reject', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const data = await founderDecision(req.user, req.params.id, {
      status: 'REJECTED',
      note: req.body?.note,
      eventType: 'REJECTED',
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not reject this dossier.');
  }
});

router.post('/:id/approve', requirePermission(PERMISSIONS.SCHOOLS_CREATE), async (req, res) => {
  try {
    const result = await approveIntake(req.user, req.params.id);
    return res.status(200).json({
      success: true,
      data: result.intake,
      temporary_password: result.temporary_password || null,
      admin_email: result.admin_email || null,
    });
  } catch (err) {
    return sendIntakeError(res, err, 'Could not onboard this school.');
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();

function sendHealth(req, res) {
  res.json({
    status: 'ok',
    service: 'superadmin-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

// GET /health (mounted under /health)
router.get('/', sendHealth);

module.exports = router;
module.exports.sendHealth = sendHealth;

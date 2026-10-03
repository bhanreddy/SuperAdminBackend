const express = require('express');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { schoolPublicApiUrl } = require('../../config/schoolPublicApi');
const router = express.Router();
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
router.use(verifySuperAdminMiddleware);
router.use(async (req, res) => {
    if (!['GET', 'POST', 'PATCH'].includes(req.method))
        return res.sendStatus(405);
    if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(req.path))
        return res.status(400).json({ success: false, error: 'Invalid media path' });
    try {
        const base = (process.env.SCHOOL_CURRICULUM_API_URL || schoolPublicApiUrl()).trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
        const target=new URL(base);
        if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw Error('Invalid canonical API base');
        const response = await fetch(`${base}/api/v1/curriculum/authoring/media${req.url}`, { method: req.method, headers: { authorization: req.headers.authorization, 'content-type': 'application/json', ...(req.headers['idempotency-key'] ? { 'idempotency-key': req.headers['idempotency-key'] } : {}) }, ...(req.method !== 'GET' ? { body: JSON.stringify(req.body) } : {}), signal: AbortSignal.timeout(25000), redirect: 'error' });
        res.set('Cache-Control', 'private, no-store');
        res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(Buffer.from(await response.arrayBuffer()));
    }
    catch {
        res.status(502).json({ success: false, code: 'MEDIA_UNREACHABLE', error: 'The canonical media service is unreachable. Try again.' });
    }
});
module.exports = router;

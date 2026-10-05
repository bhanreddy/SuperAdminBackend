const express = require('express');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { asyncHandler } = require('../../middleware/errorHandler');
const { sendResponse } = require('../../utils/apiResponse');
const sql = require('../../config/db');
const library = require('../../services/learningContentLibrary');
const images = require('../../services/learningContentImages');
const { id,text,choice,keys,fail } = require('../../services/learningContentValidation');
const router = express.Router();
router.use(verifySuperAdminMiddleware);
// Per actor, per instance. Limits apply before image processing or DB mutations.
const writes = new Map();
router.use((req,res,next) => {
  if (req.method==='GET') return next();
  const now = Date.now();
  for (const [key,bucket] of writes) if (bucket.until<=now) writes.delete(key);
  const key = String(req.user.id);
  const bucket = writes.get(key) || { count:0,until:now+60000 };
  writes.set(key,bucket);
  if (++bucket.count>30) return res.set('Retry-After',String(Math.max(1,Math.ceil((bucket.until-now)/1000)))).status(429).json({error:'Too many content writes. Wait a minute and retry.'});
  next();
});
router.get('/schema',asyncHandler(async(req,res)=>sendResponse(res,200,await library.schemaStatus())));
router.get('/',asyncHandler(async(req,res)=>{
  keys(req.query,['search','subject','grade','language','status','limit','cursor'],'Library filters');
  const filters = {};
  for (const key of ['search','subject','grade','language']) filters[key]=text(req.query[key],key,key==='search'?120:key==='grade'?40:key==='language'?10:120);
  filters.status=req.query.status ? choice(req.query.status,['draft','ready','archived'],'status') : '';
  filters.limit=req.query.limit===undefined?20:Number(req.query.limit);
  if (!Number.isSafeInteger(filters.limit)||filters.limit<1||filters.limit>50) fail('Page size must be between 1 and 50');
  if (req.query.cursor) {
    try {
      if (typeof req.query.cursor!=='string'||req.query.cursor.length>300) fail('Invalid cursor');
      filters.cursor=JSON.parse(Buffer.from(req.query.cursor,'base64url').toString());
      id(filters.cursor.id);
      if (typeof filters.cursor.at!=='string'||!Number.isFinite(Date.parse(filters.cursor.at))) fail('Invalid cursor');
    } catch { fail('Invalid page cursor'); }
  }
  return sendResponse(res,200,await library.listTopics(filters));
}));
router.post('/images/sign-upload',asyncHandler(async(req,res)=>sendResponse(res,201,await images.signUpload(req.body,String(req.user.id)))));
router.post('/images/:id/confirm',asyncHandler(async(req,res)=>{ keys(req.body,[],'Confirmation'); return sendResponse(res,200,await images.confirmUpload(id(req.params.id),String(req.user.id))); }));
router.get('/images/:id',asyncHandler(async(req,res)=>sendResponse(res,200,await images.preview(id(req.params.id)))));
router.get('/:id/revisions',asyncHandler(async(req,res)=>{
  const topicId=id(req.params.id);
  const before = req.query.before===undefined?2147483647:Number(req.query.before);
  keys(req.query,['before'],'Revision filters');
  if (!Number.isSafeInteger(before)||before<1) fail('Invalid revision cursor');
  const rows=await sql`SELECT revision,actor_id,created_at FROM learning_content_revisions WHERE topic_id=${topicId} AND revision<${before} ORDER BY revision DESC LIMIT 21`;
  return sendResponse(res,200,{data:rows.slice(0,20),next_before:rows.length>20?rows[19].revision:null});
}));
router.get('/:id/revisions/:revision',asyncHandler(async(req,res)=>{
  const revision=Number(req.params.revision);
  if (!Number.isSafeInteger(revision)||revision<1) fail('Invalid revision');
  const [snapshot]=await sql`SELECT revision,document,actor_id,created_at FROM learning_content_revisions WHERE topic_id=${id(req.params.id)} AND revision=${revision}`;
  if (!snapshot) fail('Revision not found',404);
  return sendResponse(res,200,snapshot);
}));
router.get('/:id',asyncHandler(async(req,res)=>sendResponse(res,200,await library.readTopic(sql,id(req.params.id)))));
for (const method of ['post','put']) router[method](method==='post'?'/':'/:id',asyncHandler(async(req,res)=>{
  const data=await library.saveTopic({topicId:method==='put'?id(req.params.id):null,body:req.body,actorId:String(req.user.id),requestKey:id(req.headers['idempotency-key'],'Save key')});
  return sendResponse(res,method==='post'?201:200,data);
}));
module.exports = router;

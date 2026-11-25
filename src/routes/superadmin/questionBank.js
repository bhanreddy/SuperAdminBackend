const express=require('express');
const multer=require('multer');
const crypto=require('node:crypto');
const {authenticateUser,requirePermission}=require('../../middleware/rbac');
const client=require('../../services/curriculumAuthoringClient');
const router=express.Router();
router.use(authenticateUser);
router.use((req,res,next)=>{res.setHeader('cache-control','private, no-store');req.questionBankRequestId=crypto.randomUUID();res.setHeader('x-request-id',req.questionBankRequestId);next();});
const p=name=>requirePermission(`curriculum.questions.${name}`);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:60*1024*1024,files:1,fields:2,fieldSize:4096}}).single('bundle');
const forward=async(req,res,multipart)=>{
  try{
    const result=await client.questionBank(req.method,req.url,{authorization:req.headers.authorization,body:['GET','HEAD'].includes(req.method)?undefined:req.body,idempotencyKey:req.get('Idempotency-Key'),requestId:req.questionBankRequestId,multipart});
    if(req.path.endsWith('/report'))res.setHeader('content-disposition','attachment; filename="question-import-report.json"');
    const status=req.method==='POST'&&['/imports/preview','/assets/uploads'].includes(req.path)?201:req.method==='POST'&&/^\/imports\/[a-f0-9-]+\/(commit|retry|cancel)$/i.test(req.path)?202:200;
    return res.status(status).json(result);
  }catch(e){const status=e.statusCode||503;return res.status(status).json({success:false,error:status>=500?'Question bank temporarily unavailable; retry':e.message,code:e.code||'QUESTION_BANK_UNAVAILABLE',...(e.details?{details:e.details}:{}),...(e.current?{current:e.current}:{})});}
};
router.post('/imports/preview',p('import'),(req,res,next)=>upload(req,res,e=>e?res.status(413).json({success:false,code:'UPLOAD_REJECTED',error:'Choose one ZIP/JSON under 60 MB'}):next()),async(req,res)=>{
  if(!req.file)return res.status(422).json({success:false,code:'BUNDLE_REQUIRED',error:'Choose a review bundle'});
  const form=new FormData();form.append('destination',req.body.destination||'');form.append('bundle',new Blob([req.file.buffer],{type:req.file.mimetype}),req.file.originalname);return forward(req,res,form);
});
router.use((req,res,next)=>{
  const permission=req.path.startsWith('/imports')?'import':req.method==='PUT'||req.path.startsWith('/assets/uploads')?'author':req.path.endsWith('/approved')?'approve':/\/(reviewed|changes_requested)$/.test(req.path)?'review':'read';
  return p(permission)(req,res,next);
});
router.use((req,res)=>forward(req,res));
module.exports=router;

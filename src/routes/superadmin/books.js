const express=require('express');
const {createOrganizationContext,companiesFor,managesTeam}=require('../../services/books/organizations');
const {createFinanceConnections}=require('../../services/books/financeConnections');
const {createBooksService}=require('../../services/books/service');
const {createBooksAccessService}=require('../../services/books/access');
const {printDocument}=require('../../services/books/print');
const {ensure,uuid}=require('../../services/books/domain');
const {canBooks,BOOKS_MODULES,BOOKS_PERMISSION_SET,DOCUMENT_MODULES}=require('../../config/booksPermissions');
function createBooksRouter({db,authorize}={}){
 const router=express.Router(),base=db||require('../../config/db'),organization=createOrganizationContext(base),sql=organization.sql,service=createBooksService(sql),access=createBooksAccessService(base);
 router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.use(authorize||require('../../middleware/rbac').authenticateUser);
 router.use((req,res,next)=>{
  if(!req.user)return res.status(401).json({error:'Unauthorized'});
  if(!req.user.isFounder&&!['CA','CA_LEAD'].includes(req.user.role)&&!req.user.permissions?.some(p=>BOOKS_PERMISSION_SET.has(p)))return res.status(403).json({error:'BOOKS_ACCESS_DENIED',details:'Books access has not been assigned.'});
  next();
 });
 const route=fn=>async(req,res)=>{try{const globalRoute=req.path.startsWith('/access/')||req.path==='/organizations';
  const result=await (globalRoute?fn(req,res):organization.run(req,()=>fn(req,res)));if(!res.headersSent)res.json(result);}catch(e){
  const missing=['42P01','42703'].includes(e.code),conflict=e.code==='23505';const status=e.status||(missing?503:conflict?409:500);
  if(status===500)console.error('[books]',e.message);
  res.status(status).json({error:missing?'BOOKS_SETUP_REQUIRED':conflict?'CONFLICT':status===403?'BOOKS_PERMISSION_DENIED':status===500?'BOOKS_ERROR':'VALIDATION_ERROR',details:missing?'Books database setup is required. Apply the Books migrations to the central database.':conflict?'This account or identifier already exists.':status===500?'Books could not complete the request.':e.message});
 }};
 const actor=req=>req.user.id;
 const allowed=(req,module,action='view')=>canBooks(req.user,module,action);
 const requireAccess=(req,module,action='view')=>ensure(allowed(req,module)&&allowed(req,module,action),`Access to ${module} (${action}) has not been granted`,403);
 const root=req=>ensure(managesTeam(req.user),'Only the Founder / Super Admin or lead CA can manage CA access',403);
 async function documentAccess(req,id,action='view'){
  const [row]=await sql`SELECT id,kind FROM books_documents WHERE id=${uuid(id)}`;ensure(row,'Document not found',404);requireAccess(req,row.kind,action);return row;
 }
 async function paymentAccess(req,id,action){requireAccess(req,'payments',action);const [row]=await sql`SELECT document_id FROM books_payments WHERE id=${uuid(id)}`;ensure(row,'Payment not found',404);await documentAccess(req,row.document_id);}
 const get=(path,module,fn)=>router.get(path,route(req=>{requireAccess(req,module);return fn(req);}));
 const post=(path,module,action,fn)=>router.post(path,route(req=>{requireAccess(req,module,action);return fn(req);}));
 // Team authority is role-bound; ordinary CA overrides cannot grant it.
 router.get('/organizations',route(req=>companiesFor(base,req.user)));
 router.get('/access/options',route(req=>{root(req);return access.options(req.user);}));
 router.get('/access/catalog',route(req=>{root(req);return access.catalog();}));
 router.get('/access/users',route(req=>{root(req);return access.list(req.user);}));
 router.post('/access/users',route(req=>{root(req);return access.create(req.body,req.user);}));
 router.put('/access/users/:id',route(req=>{root(req);return access.update(req.params.id,req.body,req.user);}));
 router.post('/access/users/:id/reset-password',route(req=>{root(req);return access.resetPassword(req.params.id,req.user);}));
 get('/connections','connections',()=>createFinanceConnections(sql).overview());
 post('/connections/import','connections','sync',req=>createFinanceConnections(sql).importExisting(actor(req)));
 router.get('/bootstrap',route(req=>service.bootstrap(req.user)));
 router.get('/lookups',route(req=>service.lookups(req.user)));
 router.get('/dashboard',route(async req=>{requireAccess(req,'home');const r=await service.reports(req.query);const keys=['from','to','income','expenses','profit','cash','receivables','payables','aging_as_of','cashflow'];return Object.fromEntries(keys.map(k=>[k,r[k]]));}));
 router.put('/settings',route(req=>{requireAccess(req,'settings','manage');return service.saveSettings(req.body,actor(req));}));
 get('/settings','settings',()=>service.bootstrap().then(r=>r.settings));
 router.get('/contacts',route(req=>{ensure(allowed(req,'customers')||allowed(req,'vendors'),'Contact viewing has not been granted',403);return service.contacts(req.user);}));
 async function contactAccess(req,kind){ensure(['customer','vendor','both'].includes(kind),'Invalid contact type');for(const module of kind==='both'?['customers','vendors']:[kind==='customer'?'customers':'vendors'])requireAccess(req,module,'manage');}
 router.post('/contacts',route(async req=>{await contactAccess(req,req.body.kind);return service.saveContact(req.body,actor(req));}));
 router.put('/contacts/:id',route(async req=>{const [row]=await sql`SELECT kind FROM books_contacts WHERE id=${uuid(req.params.id)}`;ensure(row,'Contact not found',404);await contactAccess(req,row.kind);await contactAccess(req,req.body.kind);return service.saveContact(req.body,actor(req),req.params.id);}));
 get('/items','items',()=>service.items());post('/items','items','manage',req=>service.saveItem(req.body,actor(req)));
 router.put('/items/:id',route(req=>{requireAccess(req,'items','manage');return service.saveItem(req.body,actor(req),req.params.id);}));
 post('/items/:id/adjust','items','adjust',req=>service.adjustStock(req.params.id,req.body,actor(req)));
 router.get('/documents',route(req=>{requireAccess(req,req.query.kind);ensure(Object.hasOwn(DOCUMENT_MODULES,req.query.kind),'Select a document type');return service.listDocuments(req.query);}));
 router.post('/documents/preview',route(req=>{requireAccess(req,req.body.kind,'manage');return service.preview(req.body);}));
 router.post('/documents',route(req=>{requireAccess(req,req.body.kind,'manage');return service.createDocument(req.body,actor(req));}));
 router.get('/documents/:id/print',route(async(req,res)=>{await documentAccess(req,req.params.id);ensure(allowed(req,'data','export'),'Print/export access has not been granted',403);res.set('Cache-Control','no-store');res.type('html').send(printDocument(await service.getDocument(req.params.id)));}));
 router.get('/documents/:id',route(async req=>{await documentAccess(req,req.params.id);const d=await service.getDocument(req.params.id);if(!allowed(req,'payments'))d.payments=[];return d;}));
 router.put('/documents/:id',route(async req=>{await documentAccess(req,req.params.id,'manage');return service.editDocument(req.params.id,req.body,actor(req));}));
 for(const [action,method] of [['post','post'],['void','voidDocument'],['convert','convert']])router.post(`/documents/:id/${action}`,route(async req=>{
  const d=await documentAccess(req,req.params.id,action==='convert'?'view':action);
  if(action==='convert')requireAccess(req,d.kind==='purchase_order'?'bill':'invoice','manage');
  return service[method](req.params.id,actor(req));
 }));
 get('/payments','payments',()=>service.payments());
 post('/payments','payments','record',async req=>{await documentAccess(req,req.body.document_id);return service.recordPayment(req.body,actor(req));});
 router.post('/payments/:id/void',route(async req=>{await paymentAccess(req,req.params.id,'void');return service.voidPayment(req.params.id,actor(req));}));
 router.post('/credits',route(async req=>{await documentAccess(req,req.body.document_id,'manage');await documentAccess(req,req.body.credit_id);return service.applyCredit(req.body,actor(req));}));
 router.delete('/credits/:id',route(async req=>{const [row]=await sql`SELECT document_id,credit_id FROM books_credit_applications WHERE id=${uuid(req.params.id)}`;ensure(row,'Credit allocation not found',404);await documentAccess(req,row.document_id,'manage');await documentAccess(req,row.credit_id);return service.removeCredit(req.params.id,actor(req));}));
 get('/accounts','accounts',()=>service.accounts());post('/accounts','accounts','manage',req=>service.addAccount(req.body));get('/accounts/:code/ledger','accounts',req=>service.ledger(req.params.code,req.query));
 get('/journals/:id','journals',req=>service.getJournal(req.params.id));get('/journals','journals',()=>service.journals());post('/journals','journals','post',req=>{requireAccess(req,'accounts');return service.manualJournal(req.body,actor(req));});
 get('/reports','reports',req=>service.reports(req.query));
 get('/bank-transactions','banking',()=>service.bankTransactions());post('/bank-transactions/import','banking','manage',req=>service.importBank(req.body,actor(req)));
 router.put('/bank-transactions/:id/match',route(req=>{requireAccess(req,'banking','manage');if(req.body.payment_id)requireAccess(req,'payments');return service.matchBank(req.params.id,req.body.payment_id);}));
 get('/projects','projects',()=>service.projects());post('/projects','projects','manage',req=>{requireAccess(req,'customers');return service.createProject(req.body);});
 post('/projects/:id/invoice','projects','invoice',req=>{requireAccess(req,'invoice','manage');requireAccess(req,'time');return service.invoiceProject(req.params.id,actor(req));});
 get('/time-entries','time',()=>service.timeEntries());post('/time-entries','time','manage',req=>{requireAccess(req,'projects');return service.addTime(req.body);});
 const readableRecurring=req=>['invoice','bill','expense'].filter(kind=>allowed(req,kind));
 get('/recurring','recurring',req=>service.recurring(readableRecurring(req)));
 post('/recurring','recurring','manage',async req=>{await documentAccess(req,req.body.template_id);return service.createRecurring(req.body);});
 router.put('/recurring/:id',route(async req=>{requireAccess(req,'recurring','manage');const [p]=await sql`SELECT template_id FROM books_recurring WHERE id=${uuid(req.params.id)}`;ensure(p,'Recurring profile not found',404);await documentAccess(req,p.template_id);return service.setRecurring(req.params.id,req.body.active);}));
 post('/recurring/run','recurring','generate',req=>{const kinds=readableRecurring(req).filter(kind=>allowed(req,kind,'manage'));ensure(kinds.length,'Grant create/edit access for the recurring document types',403);return service.runRecurring(actor(req),kinds);});
 const upload=require('multer')({storage:require('multer').memoryStorage(),limits:{fileSize:5242880,files:1,fields:1}}).single('file');
 get('/attachments','documents',async req=>{if(req.query.document_id)await documentAccess(req,req.query.document_id);return service.attachments(req.query.document_id,req.user);});
 router.post('/attachments',(req,res,next)=>{if(!allowed(req,'documents')||!allowed(req,'documents','upload'))return res.status(403).json({error:'Upload access has not been granted'});next();},(req,res,next)=>upload(req,res,e=>e?res.status(400).json({error:'UPLOAD_ERROR',details:'Choose one file up to 5 MiB.'}):next()),route(async req=>{if(req.body.document_id)await documentAccess(req,req.body.document_id);return service.addAttachment(req.file,req.body.document_id,actor(req));}));
 router.get('/attachments/:id/download',route(async(req,res)=>{requireAccess(req,'documents');ensure(allowed(req,'data','export'),'Download access has not been granted',403);const file=await service.attachment(req.params.id);if(file.document_id)await documentAccess(req,file.document_id);res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.attachment(file.filename);res.type('application/octet-stream');res.send(file.content);}));
 get('/activity','activity',()=>service.activity());
 return router;
}
const router=express.Router();let configured;router.use((req,res,next)=>{if(!configured)configured=createBooksRouter();return configured(req,res,next);});module.exports=router;module.exports.createBooksRouter=createBooksRouter;

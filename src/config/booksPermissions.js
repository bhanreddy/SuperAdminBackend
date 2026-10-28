const documents={quote:'Quotes',sales_order:'Sales orders',invoice:'Invoices',credit_note:'Credit notes',purchase_order:'Purchase orders',bill:'Bills',expense:'Expenses',vendor_credit:'Vendor credits',delivery_challan:'Delivery challans'};
const labels={view:'View',manage:'Create / edit',post:'Post / finalize',void:'Void / reverse',record:'Record payments',adjust:'Adjust stock',invoice:'Invoice time',generate:'Generate due drafts',upload:'Upload files',export:'Print / export',sync:'Import existing finances'};
const definitions=[
 ['home','Dashboard & financial totals',['view']],['customers','Customers',['view','manage']],['vendors','Vendors',['view','manage']],['items','Items & inventory',['view','manage','adjust']],
 ...Object.entries(documents).map(([key,label])=>[key,label,['view','manage','post','void']]),
 ['connections','Finance connections',['view','sync']],['payments','Payments',['view','record','void']],['banking','Banking & statement data',['view','manage']],['accounts','Chart of accounts & ledger',['view','manage']],['journals','Journals',['view','post']],
 ['projects','Projects',['view','manage','invoice']],['time','Time entries',['view','manage']],['recurring','Recurring transactions',['view','manage','generate']],['documents','Supporting documents',['view','upload']],['activity','Books activity log',['view']],['reports','Financial reports',['view']],['settings','Organization settings',['view','manage']],['data','Print & export',['export']],
];
const permission=(module,action='view')=>`books.${module}.${action}`;
const BOOKS_MODULES=definitions.map(([key,label,actions])=>({key,label,actions:actions.map(action=>({key:action,label:labels[action],permission:permission(key,action)}))}));
const BOOKS_PERMISSIONS=BOOKS_MODULES.flatMap(module=>module.actions.map(action=>action.permission));
const BOOKS_PERMISSION_SET=new Set(BOOKS_PERMISSIONS);
function canBooks(user,module,action='view'){return Boolean(user?.isFounder || user?.role==='CA_LEAD' || user?.permissions?.includes(permission(module,action)));}
function grantedModules(user){return BOOKS_MODULES.filter(m=>m.key!=='data'&&canBooks(user,m.key));}
function validateGrants(grants){
 if(!Array.isArray(grants)||grants.some(p=>typeof p!=='string'||!BOOKS_PERMISSION_SET.has(p)))return 'Choose valid Books permissions only';
 if(new Set(grants).size!==grants.length)return 'Duplicate permissions are not allowed';
 for(const p of grants){const [,module,action]=p.split('.');if(action!=='view'&&module!=='data'&&!grants.includes(permission(module)))return `Grant ${module} viewing before its actions`;}
 return null;
}
module.exports={BOOKS_MODULES,BOOKS_PERMISSIONS,BOOKS_PERMISSION_SET,DOCUMENT_MODULES:documents,permission,canBooks,grantedModules,validateGrants};

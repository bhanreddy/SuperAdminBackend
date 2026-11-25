const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const school = path.resolve(__dirname, '../../../SchoolIMS/SchoolIMS-Backend');
let policy, resolve, denied = true;
const calls=[];
const sql = async (parts,...values) => {
  const query=parts.join('?'); calls.push({query,values});
  if(query.includes('FROM public.features'))return [{key:'diary',name:'Smart Diary',category:'academics',is_active:true}];
  if(query.includes('FROM public.plans'))return [{id:'enterprise',tier_rank:4}];
  if(query.includes('FROM public.plan_features') || query.includes('FROM public.feature_rollouts'))return [];
  if(query.includes('FROM public.school_feature_overrides')) {
    const schoolId=values[0];
    if (query.includes('enabled = true')) return !denied || schoolId === 2 ? [{feature_key:'diary',enabled:true}] : [];
    return [{feature_key:'diary', enabled: !denied || schoolId === 2}];
  }
  if(query.includes('FROM public.user_feature_overrides'))return [{enabled:true}];
  return [];
};
sql.json=JSON.stringify;
test.before(async()=>{
  test.mock.module(pathToFileURL(path.join(school,'db.js')).href,{defaultExport:sql});
  policy=await import(pathToFileURL(path.join(school,'middleware/schoolFeaturePolicy.js')).href);
  resolve=(await import(pathToFileURL(path.join(school,'services/featureAccessService.js')).href)).resolveFeatureAccess;
});
test('API path policy covers smart diary, curriculum v1/v2, question bank and ignores authoring control plane',()=>{
  for(const url of ['/api/v1/diary/smart/publish','/api/v1/diary/entries']) assert.deepEqual(policy.featuresForApiPath(url),['diary']);
  for(const url of ['/api/v1/curricula/1/tree','/api/v1/assessment-attempts/1/submit','/api/v1/curriculum/published/catalog','/api/v1/question-bank/questions']) assert.ok(policy.featuresForApiPath(url).includes('curriculum_v2'),url);
  assert.deepEqual(policy.featuresForApiPath('/api/v1/curriculum/authoring/questions'),[]);
  assert.deepEqual(policy.featuresForApiPath('/api/v1/me/features'),[]);
  assert.deepEqual(policy.featuresForApiPath('/api/v1/diary-other'),[]);
});
test('school denial blocks every role and does not affect a different school; enable allows RBAC to proceed',async()=>{
  for(const role of ['admin','principal','staff','student','parent']) {
    let status,body,next=false;
    const res={status(n){status=n;return this;},json(b){body=b;return this;}};
    await policy.schoolFeaturePolicy({user:{schoolId:1,roles:[role]},originalUrl:'/api/v1/diary/smart/publish'},res,()=>{next=true;});
    assert.equal(status,403);assert.equal(body.code,'FEATURE_DISABLED');assert.equal(next,false);
  }
  let proceeded=false;
  await policy.schoolFeaturePolicy({user:{schoolId:2,roles:['staff']},originalUrl:'/api/v1/diary'}, {},()=>{proceeded=true;});
  assert.equal(proceeded,true);
  denied=false;proceeded=false;
  await policy.schoolFeaturePolicy({user:{schoolId:1,roles:['student']},originalUrl:'/api/v1/diary'}, {},()=>{proceeded=true;});
  assert.equal(proceeded,true);denied=true;
});
test('a user allow cannot bypass a school disable',async()=>{
  const result=await resolve({schoolId:1,userId:'user',role:'admin',featureKey:'diary'});
  assert.equal(result.allowed,false);assert.equal(result.state,'FEATURE_DISABLED');
  assert.ok(!calls.some(call=>call.query.includes('FROM public.user_feature_overrides')));
});

test('unconfigured school is disabled, and middleware cannot skip errors or missing tenant context', async()=>{
  let status,body,forwarded;
  const res={status(n){status=n;return this;},json(value){body=value;return this;}};
  await policy.schoolFeaturePolicy({user:{schoolId:3,roles:['admin']},originalUrl:'/api/v1/diary'},res,()=>{throw Error('Unexpected grant');});
  assert.equal(status,403);assert.equal(body.feature,'diary');
  await policy.schoolFeaturePolicy({user:{roles:['admin']},originalUrl:'/api/v1/diary'},res,()=>{throw Error('Unexpected grant');});
  assert.equal(body.code,'NO_SCHOOL_CONTEXT');
});

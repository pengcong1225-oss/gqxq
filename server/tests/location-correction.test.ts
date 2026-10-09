import assert from 'node:assert/strict';
import test, {before} from 'node:test';
process.env.DOTENV_CONFIG_PATH='nonexistent-c2.env';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_DB_PASSWORD='synthetic';process.env.GQXQ_JWT_SECRET='synthetic-c2-secret';
let service:any={};before(async()=>{try{service=await import('../src/services/locationValidationService');}catch{}});
const input=(extra:any={})=>({complaintId:'C1',expectedVersion:1,districtCode:'D1',address:'合成地址',longitude:1,latitude:1,adminGridCode:'A1',communityCode:'X1',coordinateSystem:'WGS84',coordinateSource:'操作者查阅合成WGS84资料',basis:'人工核对合成资料',...extra});
const square=(x=0)=>({type:'Polygon',coordinates:[[[x,0],[x+4,0],[x+4,4],[x,4],[x,0]],[[x+2,2],[x+3,2],[x+3,3],[x+2,3],[x+2,2]]]});
const coverage=(extra:any={})=>({code:'G1',serviceGridCode:'G1',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:['X1'],version:'2',validFrom:'2026-10-01',validTo:null,geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A1'},geometry:square()}]},coordinateSystem:'WGS84',geometrySources:['合成授权边界'],coverageState:'maintained',...extra});
const facts=(extra:any={})=>({districtName:'合成区甲',admins:[{code:'A1',name:'同名行政网格',districtCode:'D1',version:1}],communities:[{code:'X1',name:'同名小区',adminGridCode:'A1',version:1}],coverages:[coverage()],...extra});
test('strict location input rejects half pair, nonnumeric/range, missing version, unsupported CRS and missing manual basis',()=>{
 assert.equal(typeof service.parseLocationCorrectionInput,'function','location group parser is required');
 for(const patch of [{latitude:null},{longitude:NaN},{longitude:Infinity},{longitude:'1'},{longitude:181},{latitude:-91},{expectedVersion:0},{coordinateSystem:'GCJ02'},{coordinateSystem:'unknown',basis:''},{coordinateSource:''},{longitude:null,latitude:null,coordinateSystem:'WGS84'},{districtName:'伪造区名'}])assert.throws(()=>service.parseLocationCorrectionInput(input(patch)),(e:any)=>e.status===400);
 assert.equal(service.parseLocationCorrectionInput(input({address:null,longitude:null,latitude:null,coordinateSystem:null,coordinateSource:null})).address,null);
});
test('identifier relationships reject district/admin and admin/community conflicts without guessing names',()=>{
 assert.equal(typeof service.evaluateLocationEvidence,'function','location group relationship validation is required');
 assert.throws(()=>service.evaluateLocationEvidence(input({districtCode:'D2'}),facts(),'2026-10-09'),(e:any)=>e.status===400);
 assert.throws(()=>service.evaluateLocationEvidence(input({adminGridCode:null}),facts(),'2026-10-09'),(e:any)=>e.status===400);
 assert.throws(()=>service.evaluateLocationEvidence(input(),facts({communities:[{code:'X1',name:'同名小区',adminGridCode:'A2'}]}),'2026-10-09'),(e:any)=>e.status===400);
});
test('compatible sourced effective coverage proves inside, edge, hole and MultiPolygon membership',()=>{
 assert.equal(typeof service.evaluateLocationEvidence,'function');
 const check=(patch:any={},f:any=facts())=>service.evaluateLocationEvidence(input(patch),f,'2026-10-09');
 assert.equal(check().spatialStatus,'verified');assert.equal(check({longitude:0}).spatialStatus,'verified');
 for(const patch of [{longitude:5},{longitude:2.5,latitude:2.5}])assert.throws(()=>check(patch),(e:any)=>e.status===400);
 const multi={type:'MultiPolygon',coordinates:[square().coordinates,square(10).coordinates]};
 assert.equal(check({longitude:11},facts({coverages:[coverage({geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A1'},geometry:multi}]}})]})).spatialStatus,'verified');
 assert.deepEqual(check().coverageEvidence.map((v:any)=>[v.code,v.version]),[['G1','2']]);assert.equal(check().validationDate,'2026-10-09');
});
test('unknown CRS, absent point, missing geometry, draft and no effective date remain explicitly unknown',()=>{
 assert.equal(typeof service.evaluateLocationEvidence,'function');
 for(const [patch,cov] of [[{coordinateSystem:'unknown',longitude:170},coverage()],[{longitude:null,latitude:null,coordinateSystem:null,coordinateSource:null},coverage()],[{},coverage({geometry:null})],[{},coverage({coverageState:'draft'})],[{},coverage({validFrom:'2026-10-10'})],[{},coverage({validTo:'2026-10-09'})]]){
  const result=service.evaluateLocationEvidence(input(patch),facts({coverages:[cov]}),'2026-10-09');assert.equal(result.spatialStatus,'unknown');assert.ok(result.spatialReason);assert.deepEqual(result.coverageEvidence,[]);
 }
});
test('overlapping and cross-district same-name candidates retain stable identities without auto-selecting',()=>{
 assert.equal(typeof service.evaluateLocationEvidence,'function');
 const result=service.evaluateLocationEvidence(input({adminGridCode:null,communityCode:null}),facts({admins:[...facts().admins,{code:'A2',name:'同名行政网格',districtCode:'D2',version:1}],communities:[...facts().communities,{code:'X2',name:'同名小区',adminGridCode:'A2',version:1}],coverages:[coverage(),coverage({code:'G2',adminGridCodes:['A2'],communityCodes:['X2'],geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A2'},geometry:square()}]}})]}),'2026-10-09');
 assert.deepEqual(result.candidates.map((c:any)=>c.adminGridCode),['A1','A2']);assert.equal(result.spatialStatus,'unknown');
});
test('injected clock converts to Shanghai current day, including UTC previous date',()=>{
 assert.equal(typeof service.locationValidationDate,'function');assert.equal(service.locationValidationDate(()=>new Date('2026-10-08T16:00:00Z')),'2026-10-09');
});

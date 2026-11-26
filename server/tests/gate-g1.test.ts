import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateViewPolicy,hasRenderedDemoNotice} from '../scripts/gate-g1-view-policy.mjs';

const real = {mode:'real',source:'views/Example.tsx',api:'../api/example'};
const source = "import {getData} from '../api/example';";
const mixed = {...real,mode:'mixed',notices:['模拟数据，非真实业务']};
test('new views require explicit data provenance, even if they display a notice',()=>{
 assert.ok(validateViewPolicy('New','<DemoDataNotice />',undefined,()=>source).length);
});
test('real API-backed pages pass without demo labels; missing APIs fail',()=>{
 assert.deepEqual(validateViewPolicy('Example',source,real,()=>source),[]);
 assert.ok(validateViewPolicy('Example',source,real,()=>null).length);
 assert.ok(validateViewPolicy('Example',source,real,()=>"const label='../api/example';").length);
});
test('delegated source must be rendered by the page',()=>{
 const policy={...real,source:'components/Shared.tsx'};
 assert.ok(validateViewPolicy('Example',"import Shared from '../components/Shared';",policy,()=>source).length);
 assert.deepEqual(validateViewPolicy('Example','<Shared />',policy,()=>source),[]);
});
test('mixed views must render each reviewed simulation warning',()=>{
 assert.deepEqual(validateViewPolicy('Example','<Alert message="模拟数据，非真实业务" />',mixed,()=>source),[]);
 for(const text of ['', '// <Alert message="模拟数据，非真实业务" />', 'const label="模拟数据，非真实业务";', '<Alert message="真实数据" />']) {
  assert.ok(validateViewPolicy('Example',text,mixed,()=>source).length,text);
 }
});
test('demo label import/comment alone cannot unlock local demo literals',()=>{
 assert.equal(hasRenderedDemoNotice("import DemoDataNotice from './notice';"),false);
 assert.equal(hasRenderedDemoNotice('{/* <DemoDataNotice /> */}'),false);
 assert.equal(hasRenderedDemoNotice('<DemoDataNotice />'),true);
 assert.ok(validateViewPolicy('Example','',{mode:'demo'},()=>source).length);
 assert.deepEqual(validateViewPolicy('Example','<DemoDataNotice />',{mode:'demo'},()=>source),[]);
});

function runGate(viewName, content, extraFiles: Record<string, string> = {}) {
 const root=mkdtempSync(join(tmpdir(),'gqxq-gate-'));
 try {
  mkdirSync(join(root,'server/scripts'),{recursive:true});
  mkdirSync(join(root,'packages/web-admin/src/views'),{recursive:true});
  for(const file of ['gate-g1.mjs','gate-g1-view-policy.mjs']) copyFileSync(new URL('../scripts/'+file,import.meta.url),join(root,'server/scripts',file));
  writeFileSync(join(root,'packages/web-admin/src/views',viewName+'.tsx'),content);
  for (const [path, source] of Object.entries(extraFiles)) {
   const file = join(root, path);
   mkdirSync(dirname(file), { recursive: true });
   writeFileSync(file, source);
  }
  const run=spawnSync(process.execPath,[join(root,'server/scripts/gate-g1.mjs'),'--json'],{encoding:'utf8'});
  return {status:run.status,...JSON.parse(run.stdout)};
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('CLI returns nonzero for an unclassified view',()=>{
 const result=runGate('NewPage','export default function Page(){return <div/>;}');
 assert.equal(result.status,1);assert.equal(result.counts.failStructural,1);
});
test('CLI does not exempt fake data merely because a real page renders DemoDataNotice',()=>{
 const result=runGate('ComplaintList',"import {listComplaints} from '../api/complaints';\nconst mockComplaints=[];\nexport default () => <DemoDataNotice />;");
 assert.equal(result.status,1);
 assert.ok(result.violations.some(v=>v.ruleId==='mock-complaints-array'));
});
test('CLI rejects mixed pages that lose simulation disclosures',()=>{
 const result=runGate('TenderSupportView',"import {getSupportData} from '../tenderSupport/api';\nexport default () => <div/>;");
 assert.equal(result.status,1);assert.equal(result.counts.failStructural,1);
});
test('CLI still blocks fake success messages on mixed pages with valid disclosure',()=>{
 const result=runGate('TenderSupportView',"import {getSupportData} from '../tenderSupport/api';\nmessage.success('交办单已创建并推送至目标企业');\nexport default () => <Alert message=\"模拟数据专区：边界、小区、管线、事件、评价、办结和户数均为模拟\" />;");
 assert.equal(result.status,1);assert.equal(result.counts.failStructural,0);
 assert.ok(result.violations.some(v=>v.ruleId==='fake-success-toast'));
});

test('CLI accepts only the reviewed atomic complaint index replacements', () => {
 const files = {
  'server/migrations/20261120095000__complaint_stats_cover_fix_deleted.js': `exports.up = db => updateIndexes(db, [
    {
      replacement: 'alter table complaint drop index idx_complaint_stats_cover, add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code, deleted, source_system)',
    },
    {
      replacement: 'alter table complaint drop index idx_complaint_stats_district, add index idx_complaint_stats_district (source_reported_at, business_type, district_code, deleted, source_system)',
    },
  ]);`,
  'server/migrations/20261120100000__complaint_stats_cover_add_source_id.js': `exports.up = db => updateIndexes(db, [
    {
      replacement: 'alter table complaint drop index idx_complaint_stats_cover, add index idx_complaint_stats_cover (source_reported_at, business_type, minor_category_code, major_category_code, admin_grid_code, deleted, source_system, source_id)',
    },
  ]);`,
 };
 const [filtersPath, sourcePath] = Object.keys(files);
 const view = "import {listComplaints} from '../api/complaints';\nexport default () => <div/>;";
 const accepted = runGate('ComplaintList', view, files);
 assert.equal(accepted.status, 0);
 for (const rejectedFiles of [
  { [filtersPath]: files[filtersPath].replace('admin_grid_code, deleted', 'district_code, deleted') },
  { [sourcePath]: files[sourcePath].replace('add index idx_complaint_stats_cover', 'add unique index idx_complaint_stats_cover') },
  { [sourcePath]: files[sourcePath].replace('add index idx_complaint_stats_cover', 'add index another_index') },
  { [sourcePath]: files[sourcePath].replace('alter table complaint', 'alter table unrelated') },
  { [sourcePath]: files[sourcePath].replace(', add index', '; alter table complaint add index') },
  { 'server/migrations/20261126000000__other.js': files[filtersPath] },
  { [sourcePath]: files[sourcePath] + "\ndb.raw('alter table complaint drop column deleted');" },
  { [filtersPath]: "exports.up = db => db.raw('alter table complaint drop index idx_complaint_stats_cover');" },
  { 'server/src/sample.ts': files[sourcePath] },
 ]) {
  const rejected = runGate('ComplaintList', view, rejectedFiles);
  assert.equal(rejected.status, 1);
  assert.ok(rejected.violations.some(violation => violation.ruleId === 'destructive-ddl'));
 }
});

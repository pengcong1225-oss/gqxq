import assert from 'node:assert/strict';import test from 'node:test';import {existsSync} from 'node:fs';
process.env.DOTENV_CONFIG_PATH='nonexistent-b1.env';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_DB_PASSWORD='synthetic';process.env.GQXQ_JWT_SECRET='synthetic-b1-secret';
test('formal category uses major/minor/version and never maps old complaint nature',async()=>{
 assert.ok(existsSync(new URL('../src/services/categoryService.ts',import.meta.url)), 'formal category service exists');
 const {parseCategoryRef}=await import('../src/services/categoryService');
 assert.deepEqual(parseCategoryRef({majorCode:'fee',minorCode:null,dictionaryVersion:'2'}),{majorCode:'fee',minorCode:null,dictionaryVersion:'2'});
 assert.throws(()=>parseCategoryRef({majorCode:'complaint'}),/分类/);
 const {rowToDetail}=await import('../src/repositories/complaintMapper');
 const row=rowToDetail({complaint_id:'legacy',complaint_type:'complaint',effective_field_state:null} as any);
 assert.equal(row.category,null);assert.equal(row.sourceCategory,null);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { assertIsolatedDatabase } from './helpers/isolated-database.ts';
const database = assertIsolatedDatabase();
assert.equal(database,'gqxq_rehearsal_20261003');
assert.ok(process.env.GQXQ_TEST_DB_DATADIR,'setup requires expected isolated MySQL datadir');
const connection = {host:process.env.GQXQ_DB_HOST,port:Number(process.env.GQXQ_DB_PORT),user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD ?? ''};
const admin = knex({client:'mysql2',connection,pool:{min:0,max:1}});
let db;
try {
 const [[server]] = await admin.raw('select @@datadir as datadir');
 const normalize = (s:string) => s.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
 assert.equal(normalize(server.datadir),normalize(process.env.GQXQ_TEST_DB_DATADIR!));
 await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci',[database]);
 db = knex({client:'mysql2',connection:{...connection,database,multipleStatements:true},pool:{min:0,max:1},migrations:{directory:fileURLToPath(new URL('../migrations',import.meta.url)),tableName:'knex_migrations',disableTransactions:true}});
 await db.raw(readFileSync(new URL('./fixtures/external-baseline-ddl.sql',import.meta.url),'utf8'));
 const [,completed] = await db.migrate.latest();
 await db('complaint').insert({complaint_id:'REHEARSAL-C1',complaint_no:'REHEARSAL-C1',title:'合成回调验收诉求',business_type:'gas',complaint_type:'complaint',urgency_level:'normal',enterprise_code:'E1'});
 await db('dict_item').insert({item_id:'SYNTHETIC-SW1',dict_type:'sensitive_word',item_value:'爆管',item_label:'爆管',status:'enabled'});
 console.log('Created synthetic callback fixture',database,'migrations',completed.length);
} finally { if(db) await db.destroy(); await admin.destroy(); }

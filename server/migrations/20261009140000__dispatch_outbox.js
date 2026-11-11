// Durable scheduling metadata only. Immutable bytes remain in dispatch_push_snapshot.
const fields = {
 request_id:['varchar(128)',false],assignment_id:['varchar(128)',false],complaint_id:['varchar(64)',false],payload_hash:['varchar(64)',false],
 transport_identity:['text',false],recovery_mode:['varchar(32)',false],contract_version:['varchar(128)',false],state:['varchar(16)',false],
 attempts:['int unsigned',false],has_unknown:['tinyint',false],next_attempt_at:['datetime(3)',true],lease_token:['varchar(64)',true],lease_expires_at:['datetime(3)',true],
 initiator_id:['varchar(64)',false],initiator_name:['varchar(128)',true],client_ip:['varchar(64)',true],scope_version:['bigint unsigned',false],authorization_version:['bigint unsigned',false],
 last_result:['varchar(32)',true],last_http_status:['int',true],last_error_code:['varchar(64)',true],task_id:['varchar(128)',true],created_at:['datetime(3)',false],updated_at:['datetime(3)',false],
};
async function check(knex){
 if(!await knex.schema.hasTable('dispatch_push_snapshot'))throw Error('C4 requires immutable dispatch_push_snapshot');
 if(!await knex.schema.hasTable('dispatch_outbox'))return false;
 const [columns]=await knex.raw('show columns from dispatch_outbox');
 for(const [name,[type,nullable]] of Object.entries(fields)){
  const column=columns.find(c=>c.Field===name);
  const normalized=column?.Type.toLowerCase().replace(/\b(int|bigint|tinyint)\(\d+\)/g,'$1');
  if(!column||normalized!==type||(column.Null==='YES')!==nullable)throw Error('C4 incompatible column dispatch_outbox.'+name);
 }
 const [indexes]=await knex.raw('show index from dispatch_outbox');
 for(const key of [['request_id'],['assignment_id']]){
  const names=[...new Set(indexes.filter(r=>Number(r.Non_unique)===0).map(r=>r.Key_name))];
  if(!names.some(name=>{const entries=indexes.filter(r=>r.Key_name===name).sort((a,b)=>Number(a.Seq_in_index)-Number(b.Seq_in_index));return entries.length===key.length&&entries.every((r,i)=>r.Column_name===key[i]&&r.Sub_part==null);}))throw Error('C4 incompatible full identity key dispatch_outbox.'+key.join(','));
 }
 const [tables]=await knex.raw('select engine from information_schema.tables where table_schema=database() and table_name=?',['dispatch_outbox']);
 if(String(tables[0]?.ENGINE??tables[0]?.engine).toLowerCase()!=='innodb')throw Error('C4 requires InnoDB dispatch_outbox');
 return true;
}
exports.up=async knex=>{
 if(await check(knex))return;
 const definitions=Object.entries(fields).map(([name,[type,nullable]])=>'`'+name+'` '+type+(nullable?' null':' not null')+(name==='attempts'||name==='has_unknown'? ' default 0':''));
 await knex.raw('create table dispatch_outbox ('+definitions.join(',')+', primary key(request_id),unique key uk_delivery_assignment(assignment_id),key idx_delivery_due(state,next_attempt_at),key idx_delivery_lease(state,lease_expires_at)) engine=InnoDB default charset=utf8mb4');
};
exports.down=async knex=>{await knex.schema.dropTable('dispatch_outbox');};

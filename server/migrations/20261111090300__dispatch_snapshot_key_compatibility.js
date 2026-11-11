// Retain the necessary ca92f4e snapshot-key compatibility repair. No payload or
// identifiers are rewritten; unsupported column shapes fail before any DDL.
// Historical order.assignment_id is varchar(64), snapshot uses varchar(128);
// retain that deliberate wider capacity while aligning only the collation.
exports.up=async db=>{
 const columns=async table=>(await db.raw('select COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME from information_schema.columns where table_schema=database() and table_name=?',[table]))[0];
 const order=await columns('dispatch_order'),snapshot=await columns('dispatch_push_snapshot');
 const plans=[];
 for(const name of ['assignment_id','request_id']){
  const target=order.find(c=>c.COLUMN_NAME===name),current=snapshot.find(c=>c.COLUMN_NAME===name);
  if(!target||!current||target.CHARACTER_SET_NAME!=='utf8mb4'||current.CHARACTER_SET_NAME!=='utf8mb4'||!/^utf8mb4_[a-z0-9_]+$/.test(target.COLLATION_NAME)||!/^varchar\([0-9]+\)$/.test(current.COLUMN_TYPE)||!(target.COLUMN_TYPE===current.COLUMN_TYPE||(name==='assignment_id'&&target.COLUMN_TYPE==='varchar(64)'&&current.COLUMN_TYPE==='varchar(128)'))||current.EXTRA||current.COLUMN_DEFAULT!=null)throw Error('Unsupported dispatch snapshot key metadata: '+name);
  if(current.COLLATION_NAME!==target.COLLATION_NAME)plans.push(['alter table dispatch_push_snapshot modify column ?? '+current.COLUMN_TYPE+' character set utf8mb4 collate '+target.COLLATION_NAME+(current.IS_NULLABLE==='YES'?' null':' not null'),[name]]);
 }
 for(const [sql,args] of plans)await db.raw(sql,args);
};
exports.down=async()=>{throw Error('Restore key collation only from verified schema evidence');};

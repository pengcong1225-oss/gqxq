// Necessary delivery fields from ca92f4e, adopted without duplicate-column DDL,
// ambiguous dashboard aliases, destructive rollback, or source data backfills.
const {checkColumn}=require('./20261111090000__backend_schema_consolidation')._test;
const specs={
 complaint:{source_deadline_at:'datetime(3)',source_completed_at:'datetime(3)',source_process_received_at:'datetime(3)'},
 source_process_stream:{ingress_version:'bigint unsigned',ingress_hash:'varchar(64)'},
 source_process_revision:{contact_phone:'varchar(64)'},
 source_business_head:{followup_binding:'json'},source_business_revision:{followup_binding:'json'}
};
exports.up=async db=>{
 const plans=[];
 for(const [table,columns] of Object.entries(specs)){
  const [tables]=await db.raw('select ENGINE,TABLE_COLLATION from information_schema.tables where table_schema=database() and table_name=?',[table]);
  if(tables[0]?.ENGINE!=='InnoDB')throw Error('Delivery fields require InnoDB '+table);
  const [actual]=await db.raw('select COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME,CHARACTER_SET_NAME,COLUMN_DEFAULT,EXTRA from information_schema.columns where table_schema=database() and table_name=?',[table]);
  for(const [name,type] of Object.entries(columns)){
   const existing=actual.find(c=>c.COLUMN_NAME===name);
   if(existing)checkColumn(table,name,{type,nullable:true},existing,tables[0].TABLE_COLLATION);
   else plans.push('alter table `'+table+'` add column `'+name+'` '+type+' null default null');
  }
 }
 for(const sql of plans)await db.raw(sql);
};
exports.down=async()=>{throw Error('Delivery facts must be retained; restore only from reviewed backup');};

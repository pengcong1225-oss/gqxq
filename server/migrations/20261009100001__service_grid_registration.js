// Explicit new draft identity state. Existing rows stay legacy; no guessed
// coverage, empty effective interval or rewritten B3 history.
exports.up=async db=>{
 for(const c of ['grid_code','grid_name','business_type','version'])if(!await db.schema.hasColumn('service_grid',c))throw Error('B4 registration requires service_grid.'+c);
 if(await db.schema.hasColumn('service_grid','import_state')){
  const [rows]=await db.raw("select data_type,character_maximum_length,is_nullable,column_default from information_schema.columns where table_schema=database() and table_name='service_grid' and column_name='import_state'");const c=rows[0];if(c.DATA_TYPE!=='varchar'||Number(c.CHARACTER_MAXIMUM_LENGTH)<16||c.IS_NULLABLE!=='NO'||c.COLUMN_DEFAULT!=='legacy')throw Error('B4 incompatible service_grid.import_state');
  const [invalid]=await db.raw("select grid_code from service_grid where import_state not in ('legacy','draft','published') limit 1");if(invalid.length)throw Error('B4 unsupported registration state');return;
 }
 await db.raw("alter table service_grid add column import_state varchar(16) not null default 'legacy'");
};
exports.down=async()=>{throw Error('B4 registration state/history requires evidence-preserving restoration');};

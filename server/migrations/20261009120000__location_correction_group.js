// C2 additive metadata. Existing coordinates keep unknown provenance; no bulk relabelling.
const columns={admin_grid_code:64,community_code:64,location_coordinate_system:16,location_coordinate_source:500};
exports.up=async db=>{
 const [tables]=await db.raw("select ENGINE from information_schema.tables where table_schema=database() and table_name='complaint'");
 if(tables.length!==1||tables[0].ENGINE!=='InnoDB')throw Error('C2 requires existing InnoDB complaint');
 const [existing]=await db.raw("select COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE from information_schema.columns where table_schema=database() and table_name='complaint'");
 // Complete preflight before first DDL, preserving incompatible existing structures.
 for(const [name,length] of Object.entries(columns)){
  const found=existing.find(c=>c.COLUMN_NAME===name);
  if(found&&(found.DATA_TYPE!=='varchar'||Number(found.CHARACTER_MAXIMUM_LENGTH)<length||found.IS_NULLABLE!=='YES'))throw Error('C2 incompatible complaint.'+name);
 }
 const missing=Object.entries(columns).filter(([name])=>!existing.some(c=>c.COLUMN_NAME===name));
 if(missing.length)await db.raw('alter table complaint '+missing.map(([name,length])=>'add column '+name+' varchar('+length+') null').join(', '));
};
exports.down=async()=>{throw Error('C2 rollback requires explicit evidence-preserving restoration');};

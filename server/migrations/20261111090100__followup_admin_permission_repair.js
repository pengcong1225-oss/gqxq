// Restore only missing grants on the protected administrator. Never seed handler
// or custom roles here, and never erase historical role permissions.
exports.up=async db=>{
 for(const table of ['platform_role','platform_permission','platform_role_permission','platform_authorization_state']){
  const [rows]=await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?',[table]);
  if(rows[0]?.ENGINE!=='InnoDB')throw Error('Followup administrator repair requires InnoDB '+table);
 }
 await db.transaction(async tx=>{
  const state=await tx('platform_authorization_state').where('id',1).forUpdate().first();
  if(!state)throw Error('Followup administrator repair requires authorization state id=1');
  const admin=await tx('platform_role').where({role_code:'admin',built_in:1}).forUpdate().first();
  if(!admin)return;
  let changed=false;
  for(const code of ['followup.create','followup.conclude']){
   if(!await tx('platform_permission').where('permission_code',code).first())throw Error('Missing baseline permission '+code);
   if(!await tx('platform_role_permission').where({role_code:'admin',permission_code:code}).first()){
    await tx('platform_role_permission').insert({role_code:'admin',permission_code:code});changed=true;
   }
  }
  if(changed){await tx('platform_role').where('role_code','admin').increment('version',1);await tx('platform_authorization_state').where('id',1).increment('version',1);}
 });
};
exports.down=async()=>{throw Error('Do not automatically revoke administrator or historical followup grants');};

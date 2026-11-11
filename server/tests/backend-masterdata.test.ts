import test from 'node:test';
import assert from 'node:assert/strict';
import {EnterpriseService,enterpriseWriteSchema,householdWriteSchema,calculatePerTenThousand} from '../src/services/enterpriseService';
import {ServiceGridService,serviceGridSchema} from '../src/services/serviceGridService';
import {readGridIn,readCoverageIn} from '../src/repositories/serviceGridRepo';
import {householdsToWan,wanToHouseholds} from '../../packages/web-admin/src/utils/householdUnits';

const ctx:any={userId:'manager',userName:'管理员',clientIp:null,permissionCodes:['enterprise.manage','grid.manage'],access:{rules:[{kind:'all'}]}};
const enterprise={id:1,enterprise_code:'E1',enterprise_name:'登记企业',business_type:'water',status:'enabled',version:2,display_on_screen:null,screen_name:null};
function dbFor(grid=false,enterpriseRow=enterprise){
 const writes:{sql:string;args:any[]}[]=[];
 const query=async(sql:string,args:any[]=[])=>{
  let rows:any[]=[];
  if(sql.includes(' from dict_type '))rows=[{code:args[0],name:'字典',status:'enabled',version:1,published:1}];
  else if(sql.includes(' from dict_item '))rows=[{itemId:'water',code:'water',label:'供水',status:'enabled',version:1,published:1}];
  else if(sql.includes(' from pu_enterprise_binding '))rows=[]; // Local fixture has no PU source binding.
  else if(sql.includes(' from enterprise '))rows=[enterpriseRow];
  else if(sql.includes(' from admin_grid '))rows=[{code:'A1',name:'行政网格',district_code:'420502',version:1,geometry:null,coordinate_system:null,geometry_source:null}];
  else if(sql.includes(' from service_grid g '))rows=grid?[{grid_code:'G1',grid_name:'既有网格',business_type:'water',version:0,import_state:'legacy',enterprise_code:'E1',manager_name:null,manager_phone:null}]:[];
  else if(sql.includes(' from service_grid_admin '))rows=[];
  else if(sql.includes(' from service_grid_revision '))rows=[];
  else throw Error(sql);
  return [rows,[]];
 };
 const execute=async(sql:string,args:any[]=[])=>{writes.push({sql,args});return [{insertId:1},[]];};
 return {query,execute,writes} as any;
}
test('enterprise display configuration is validated, saved, snapshotted and audited with version checks',async()=>{
 const db=dbFor();const input:any={enterpriseCode:'E1',enterpriseName:'登记企业',businessType:'water',status:'enabled',expectedVersion:2,displayOnScreen:true,screenName:'展示简称'};
 assert.equal(enterpriseWriteSchema.safeParse(input).success,true);
 const service=new EnterpriseService();const saved=await service.saveInTx(db,input,ctx);
 assert.equal(saved.value.displayOnScreen,true);assert.equal(saved.value.screenName,'展示简称');assert.equal(saved.version,3);
 assert.ok(db.writes.some((w:any)=>w.sql.startsWith('update enterprise')&&w.sql.includes('display_on_screen')&&w.args.includes('展示简称')));
 const snapshot=db.writes.find((w:any)=>w.sql.startsWith('insert into enterprise_revision'));assert.equal(JSON.parse(snapshot.args[2]).screenName,'展示简称');
 assert.equal(db.writes.filter((w:any)=>w.sql.startsWith('insert into operation_audit_log')).length,1);
 await assert.rejects(()=>service.saveInTx(db,{...input,expectedVersion:1},ctx),/版本/);
 await assert.rejects(()=>service.saveInTx(db,input,{...ctx,permissionCodes:[]}),/权限/);
});
test('legacy grid identity reads with unknown managers and new metadata persists in coverage snapshots',async()=>{
 const db=dbFor(true);const row=await readGridIn(db,'G1');const old:any=await readCoverageIn(db,row!);
 assert.equal(old.name,'既有网格');assert.equal(old.managerName,null);assert.equal(old.managerPhone,null);
 const input:any={code:'G1',name:'企业责任网格',managerName:'网格员',managerPhone:'0717-1234567',enterpriseCode:'E1',businessType:'water',adminGridCodes:['A1'],communityCodes:[],validFrom:'2026-11-10',validTo:null,expectedVersion:0};
 assert.equal(serviceGridSchema.safeParse(input).success,true);
 const service=new ServiceGridService();const saved=await service.saveInTx(db,input,ctx);
 assert.equal(saved.value.name,input.name);assert.equal(saved.value.managerName,input.managerName);assert.equal(saved.value.managerPhone,input.managerPhone);
 assert.ok(db.writes.some((w:any)=>w.sql.startsWith('update service_grid')&&w.sql.includes('manager_phone')));
 const snapshot=db.writes.find((w:any)=>w.sql.startsWith('insert into service_grid_revision'));assert.equal(JSON.parse(snapshot.args[4]).managerName,'网格员');
 await assert.rejects(()=>service.saveInTx(db,{...input,expectedVersion:99},ctx),/版本/);
 await assert.rejects(()=>service.saveInTx(db,input,{...ctx,permissionCodes:[]}),/权限/);
});
test('households remain raw integer counts and unknown never becomes zero',()=>{
 assert.equal(householdsToWan(12345),1.2345);assert.equal(wanToHouseholds(1.2345),12345);
 assert.equal(householdsToWan(null),null);assert.equal(wanToHouseholds(null),null);assert.equal(wanToHouseholds(0),0);
 assert.throws(()=>wanToHouseholds(1.23456),/四位|整数/);assert.throws(()=>wanToHouseholds(-1),/非负/);
 assert.equal(householdWriteSchema.safeParse({enterpriseCode:'E1',households:12345,validFrom:'2026-11-10',validTo:null,expectedVersion:2}).success,true);
 assert.equal(householdWriteSchema.safeParse({enterpriseCode:'E1',households:1.2345,validFrom:'2026-11-10',validTo:null,expectedVersion:2}).success,false);
 assert.deepEqual(calculatePerTenThousand(10,null),{value:null,reason:'UNKNOWN_HOUSEHOLDS'});
 assert.equal(calculatePerTenThousand(10,10000).value,10);
});
test('legacy historical snapshots do not acquire the current grid name or manager',async()=>{
 const row:any={grid_code:'G1',grid_name:'现名称',manager_name:'现网格员',manager_phone:'现电话',business_type:'water',version:2,enterprise_code:'E1',import_state:'published'};
 const snapshot={code:'G1',serviceGridCode:'G1',enterpriseCode:'E1',businessType:'water',version:'1',adminGridCodes:['A1'],communityCodes:[],validFrom:'2026-01-01',validTo:null,geometry:null,coordinateSystem:null,geometrySources:[],coverageState:'maintained'};
 const db:any={query:async()=>[[{version:1,valid_from:'2026-01-01',valid_to:'2026-11-10',snapshot:JSON.stringify(snapshot)}],[]]};
 const historical=await readCoverageIn(db,row,'2026-02-01');
 assert.equal(historical?.name,undefined);assert.equal(historical?.managerName,null);assert.equal(historical?.managerPhone,null);
});
test('older enterprise clients preserve display settings when the optional fields are omitted',async()=>{
 const db=dbFor(false,{...enterprise,display_on_screen:1,screen_name:'已有简称'} as any);
 const service=new EnterpriseService();
 const saved=await service.saveInTx(db,{enterpriseCode:'E1',enterpriseName:'登记企业',businessType:'water',status:'enabled',expectedVersion:2},ctx);
 assert.equal(saved.changed,false);assert.equal(saved.value.displayOnScreen,true);assert.equal(saved.value.screenName,'已有简称');assert.equal(db.writes.length,0);
 assert.equal(enterpriseWriteSchema.safeParse({enterpriseCode:'E1',enterpriseName:'登记企业',businessType:'water',status:'enabled',displayOnScreen:'yes'}).success,false);
});

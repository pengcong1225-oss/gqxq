import regions from '../data/yichangTownships.snapshot.json';
import type {Tx} from '../db/tx';
import {pool} from '../db/pool';
import {parseFieldState} from '../domain/effectiveFieldPolicy';
import {cachedLocation,locationCandidates} from '../domain/locationCandidates';
import {recognizedCommunity,type CommunityPoint} from '../domain/communityRecognition';
import {insertAudit} from '../repositories/auditLogRepo';
export async function recognizeCommunityIn(tx:Tx,id:string):Promise<boolean>{
 const [[row]]=await tx.query<any[]>('select * from complaint where complaint_id=? and coalesce(deleted,0)=0 for update',[id]);
 if(!row)return false;
 const existingStates=parseFieldState(row.effective_field_state);
 const previouslyAccepted=String(row.location_coordinate_source??'').startsWith('系统自动认可：')&&['address','district_name','district_code','location_lng','location_lat','location_coordinate_system','location_coordinate_source'].every(k=>existingStates[k]?.resolution==='no_correction'&&existingStates[k]?.reason?.startsWith('系统自动认可：'));
 if(!previouslyAccepted&&!String(row.location_coordinate_source??'').startsWith('待纠偏：'))return false;
 const evaluation=previouslyAccepted?{...row,effective_field_state:Object.fromEntries(Object.entries(existingStates).map(([k,v])=>[k,{...v,resolution:'unresolved'}]))}:row;
 const point=cachedLocation(row) as (CommunityPoint|null);
 if(!point||!recognizedCommunity(evaluation,locationCandidates(evaluation),point))return false;
 const [items]=await tx.query<any[]>("select * from correction_item where complaint_id=? and field_name in ('district_name','address','location_lng','location_lat') for update",[id]);
 if(previouslyAccepted&&!items.length)return false;
 if(items.some(i=>i.status!=='pending'||i.confirmer_id||i.confirmed_at||i.basis))return false;
 const districtCode=row.district_code||point.districtCode,districtName=row.district_name||regions.counties.find(c=>c.code===districtCode)?.name;
 if(!districtName)return false;
 const reason=`系统自动认可：明确小区${point.name}，高德兴趣点匹配${point.score}分且区县一致；小区级定位，非楼栋门牌，不需重复人工确认`;
 const address=row.address||point.name,states=parseFieldState(row.effective_field_state),version=Number(row.edit_version)+1;
 for(const [field,value] of Object.entries({address,district_name:districtName,district_code:districtCode,location_lng:Number(row.location_lng),location_lat:Number(row.location_lat),location_coordinate_system:row.location_coordinate_system,location_coordinate_source:reason}))states[field]={resolution:'no_correction',value,version,reason};
 await tx.query('update complaint set address=?,district_code=?,district_name=?,location_coordinate_source=?,effective_field_state=?,edit_version=? where complaint_id=?',[address,districtCode,districtName,reason,JSON.stringify(states),version,id]);
 for(const i of items){const value=i.field_name==='address'?address:i.field_name==='district_name'?districtName:row[i.field_name];await tx.query("update correction_item set status='confirmed',new_value=?,basis=?,confirmer_id=null,confirmer_name='系统自动匹配',confirmed_at=now() where correction_id=? and status='pending'",[String(value??''),reason,i.correction_id]);}
 await tx.query("update complaint_location_initialization set state='matched',reason=?,updated_at=now() where complaint_id=?",[reason,id]);
 const analysis=items.length?await (await import('./correctionService')).maybeEnterAnalysis(tx,{complaintId:id,operatorId:null,operatorName:'系统自动匹配',now:new Date()}):null;
 await insertAudit(tx,{userId:null,appCode:'gqxq',resourceCode:'location',action:'LOCATION_COMMUNITY_AUTO_ACCEPT',bizType:'complaint',bizId:id,result:'success',clientIp:null,createdAt:new Date(),detail:{name:point.name,precision:'community',humanConfirmed:false,previousSource:row.location_coordinate_source,completedItems:items.length,analysisEntered:analysis?.entered??false}});
 return true;
}
export async function recognizeCommunities(limit=100,afterId=0){
 const [rows]=await pool.query<any[]>("select id,complaint_id from complaint where id>? and location_coordinate_source like '待纠偏：%实际精度兴趣点%' and coalesce(deleted,0)=0 order by id limit ?",[afterId,limit]);let accepted=0;
 for(const r of rows){const tx=await pool.getConnection();try{await tx.beginTransaction();if(await recognizeCommunityIn(tx,r.complaint_id))accepted++;await tx.commit();}catch(e){await tx.rollback();throw e;}finally{tx.release();}}
 return {checked:rows.length,accepted,nextId:rows.length?Number(rows[rows.length-1].id):null};
}

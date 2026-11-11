import type {StatisticsComplaint} from '../types/statistics';

// A display grid over the Yichang area, not administrative boundaries. Never persisted as membership.
export function simulatedYichangMembers(rows:StatisticsComplaint[]){
 const cells=new Map<string,{code:string;name:string;rows:Map<string,StatisticsComplaint>;ring:number[][]}>();
 for(const r of rows){
  const x=r.longitude,y=r.latitude;
  if(r.coordinateSystem!=='WGS84'||!r.coordinateSource||x===null||y===null||!Number.isFinite(x)||!Number.isFinite(y)||x<110||x>=112.5||y<29.8||y>=31.7)continue;
  const col=Math.floor((Math.round(x*1e8)-110e8)/2e6),line=Math.floor((Math.round(y*1e8)-29.8e8)/2e6);
  const code=`SIM-YC-${col}-${line}`,west=Number((110+col*.02).toFixed(2)),south=Number((29.8+line*.02).toFixed(2));
  const east=Number((west+.02).toFixed(2)),north=Number((south+.02).toFixed(2));
  const cell=cells.get(code)??{code,name:`宜昌模拟网格 ${col}-${line}`,rows:new Map<string,StatisticsComplaint>(),ring:[[west,south],[east,south],[east,north],[west,north],[west,south]]};
  cell.rows.set(r.complaintId,r);cells.set(code,cell);
 }
 return cells;
}

export const SIMULATED_HEAT_COEFFICIENTS=['0.03','0.10','0.30','1.00','3.00'];

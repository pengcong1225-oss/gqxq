import {extractLocation} from '../services/rules/locationExtract';
import {isRejectedLocationContext} from '../services/rules/locationContext';
import centers from '../data/yichangDistrictCenters.json';
export interface InitialPoint {longitude:number;latitude:number;score:number;level:string;coordinateSystem:'WGS84'|'CGCS2000';source:string}
// GCJ-02 -> approximate WGS84; district representative points only, never survey/parcel positions.
function approximateWgs84(lng:number,lat:number):[number,number]{
 const x=lng-105,y=lat-35,pi=Math.PI;
 let a=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));
 let b=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
 const common=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
 a+=common+(20*Math.sin(y*pi)+40*Math.sin(y/3*pi))*2/3+(160*Math.sin(y/12*pi)+320*Math.sin(y*pi/30))*2/3;
 b+=common+(20*Math.sin(x*pi)+40*Math.sin(x/3*pi))*2/3+(150*Math.sin(x/12*pi)+300*Math.sin(x/30*pi))*2/3;
 const rad=lat*pi/180,magic=1-.00669342162296594323*Math.sin(rad)**2,sqrt=Math.sqrt(magic);
 return [lng-b*180/(6378245/sqrt*Math.cos(rad)*pi),lat-a*180/((6378245*(1-.00669342162296594323))/(magic*sqrt)*pi)];
}
export function fallbackLocation(row:Record<string,unknown>):InitialPoint|null{
 const code=String(row.district_code??'').trim(),name=String(row.district_name??'').trim(),address=String(row.address??'').trim();
 const byCode=centers.find(c=>c.code===code),byName=centers.find(c=>c.name===name);
 if(code&&!byCode||name&&!byName||byCode&&byName&&byCode.code!==byName.code)return null;
 const title=String(row.title??''),content=String(row.content??'');
 const extracted=extractLocation({title,content});
 const localText=[address,title,content];
 const inferred=centers.filter(c=>localText.some(t=>{const i=t.indexOf(c.name);return i>=0&&!isRejectedLocationContext(t,i);})||extracted.clues.some(clue=>clue.districtCode===c.code));
 const mentions=centers.filter(c=>address.includes(c.name));
 if(!byCode&&!byName){if(extracted.conflict||inferred.length!==1)return null;mentions.push(...inferred.filter(c=>!mentions.includes(c)));}
 const chosen=byCode??byName??(mentions.length===1?mentions[0]:null);
 if(!chosen||mentions.some(c=>c.code!==chosen.code))return null;
 const [longitude,latitude]=approximateWgs84(chosen.center[0],chosen.center[1]);
 return {longitude,latitude,score:0,level:'区县代表点',coordinateSystem:'WGS84',source:`待纠偏：${chosen.name}区县代表点，非诉求实际发生位置；DataV行政区中心GCJ02近似转换WGS84；https://geo.datav.aliyun.com/areas_v3/bound/420500_full.json`};
}
export function acceptApproximateGeocode(f:any,r:any,row:Record<string,unknown>):InitialPoint|null{
 const p=f?.location,c=r?.result?.addressComponent;
 if(String(f?.status)!=='0'||String(r?.status)!=='0'||c?.city!=='宜昌市')return null;
 if(row.district_code&&!String(c.county_code??'').endsWith(String(row.district_code))||row.district_name&&c.county!==row.district_name)return null;
 const longitude=Number(p?.lon),latitude=Number(p?.lat),score=Number(p?.score);
 if(p?.lon==null||p?.lat==null||!Number.isFinite(longitude)||!Number.isFinite(latitude)||longitude<110||longitude>112.3||latitude<29.5||latitude>31.8||!Number.isFinite(score)||score<0||score>100)return null;
 return {longitude,latitude,score,level:String(p.level??'近似地址'),coordinateSystem:'WGS84',source:`待纠偏：高德近似地址定位，分数${score}，级别${String(p.level??'未知')}，已核对宜昌市及区县；非人工核验`};
}
export function confirmedCoordinateSource(source:string|null):string|null {
 return source?.replace(/待纠偏/g,'已人工核验（原近似来源）').slice(0,500)??null;
}

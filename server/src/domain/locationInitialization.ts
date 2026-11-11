import {parseFieldState} from './effectiveFieldPolicy';
export function mayInitialize(row:Record<string,unknown>):boolean {
 if(row.location_lng!=null||row.location_lat!=null)return false;
 const state=parseFieldState(row.effective_field_state);
 return !['location_lng','location_lat','location_coordinate_system','location_coordinate_source'].some(k=>state[k]&&state[k].resolution!=='unresolved');
}
export function locationQuery(row:Record<string,unknown>):string|null {
 const address=String(row.address??'').trim();const district=String(row.district_name??'').trim();
 if(!address||address.length>100||/[\r\n，。！？；]|\d{7,}|投诉|反映|联系|处理|解决|希望|电话|先生|女士/.test(address))return null;
 const specific=address.replace(/湖北省|宜昌市/g,'').replace(district,'').trim();
 if(specific.length<3||/^[\u4e00-\u9fff]{2,8}[区县市乡镇]$/.test(specific)||!/[路街巷号院楼苑园村小区广场大厦中心花城]/.test(specific))return null;
 if(address.includes('宜昌市'))return address;
 return '湖北省宜昌市'+(district&&!address.includes(district)?district:'')+address;
}
export function acceptGeocode(forward:any,reverse:any,expected:Record<string,unknown>):{longitude:number;latitude:number;score:number;level:string}|null {
 const p=forward?.location,component=reverse?.result?.addressComponent;
 if(String(forward?.status)!=='0'||String(reverse?.status)!=='0'||!component||component.city!=='宜昌市')return null;
 const longitude=Number(p?.lon),latitude=Number(p?.lat),score=Number(p?.score),level=String(p?.level??'');
 if(!Number.isFinite(longitude)||!Number.isFinite(latitude)||longitude<110||longitude>112.3||latitude<29.5||latitude>31.8||!Number.isFinite(score)||score<95||score>100)return null;
 if(!['兴趣点','门址','门牌号','地址','建筑物','门牌'].includes(level))return null;
 const district=String(expected.district_code??'');const name=String(expected.district_name??'');
 if(district&&!String(component.county_code??'').endsWith(district))return null;
 if(!district&&name&&component.county!==name)return null;
 return {longitude,latitude,score,level};
}

export function initializationAddress(row:Record<string,unknown>):unknown {
 if(row.address)return row.address;
 const state=parseFieldState(row.effective_field_state);
 if(row.parent_match==='conflict'||state.address&&state.address.resolution!=='unresolved')return null;
 return row.candidate_text??null;
}

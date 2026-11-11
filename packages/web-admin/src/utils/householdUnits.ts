/** Presentation uses 万户; API/storage and statistical denominators remain 户. */
export function householdsToWan(value:number|null|undefined):number|null {
 return value==null?null:value/10000;
}
export function wanToHouseholds(value:number|null|undefined):number|null {
 if(value==null)return null;
 if(!Number.isFinite(value)||value<0)throw Error('服务户数须为非负数');
 const raw=value*10000,rounded=Math.round(raw);
 if(!Number.isSafeInteger(rounded)||Math.abs(raw-rounded)>1e-6)throw Error('万户最多保留四位小数，折算户数须为安全整数');
 return rounded;
}

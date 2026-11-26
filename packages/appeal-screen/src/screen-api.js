/**
 * 真实数据 API 基址（与 realSource.ts 的 resolveRealBase 同一套推导规则）：
 *   开发 `/api/v1`（vite proxy 转发）· 生产 `/gqxq/api/v1`（大屏挂在 /gqxq/screen/ 下）
 */
function resolveApiBase(){
  const override=import.meta.env.VITE_API_BASE
  if(override) return String(override).replace(/\/$/,'')
  const pagePath=location.pathname.replace(/\/[^/]*$/,'/').replace(/\/$/,'')
  const m=pagePath.match(/^(.*?)\/screen$/)
  return `${m?m[1]:''}/api/v1`
}
export const apiBase=resolveApiBase()
export async function screenRequest(path,params={},signal){
 const q=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==''&&v!=null));
 const screenMarker=sessionStorage.getItem('gqxq-token');
 const token=screenMarker?.startsWith('oidc-cookie:')?screenMarker:localStorage.getItem('token');
 const res=await fetch(`${apiBase}${path}?${q}`,{signal,credentials:'same-origin',headers:token?{Authorization:`Bearer ${token}`}:{}});
 let json;try{json=await res.json()}catch{throw new Error(`服务响应异常 (${res.status})`)}
 if(!res.ok||json.code!==200){const e=new Error(json.message||`请求失败 (${res.status})`);e.status=res.status;throw e}return json.data
}
export async function screenLogin(username,password){
 const res=await fetch(`${apiBase}/auth/login`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 const body=await res.json();if(!res.ok||body.code!==200)throw Error(body.message||'登录失败');return body.data
}

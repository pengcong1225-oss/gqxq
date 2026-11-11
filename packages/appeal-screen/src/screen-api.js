export const apiBase=import.meta.env.VITE_API_BASE||'/api/v1'
export async function screenRequest(path,params={},signal){
 const q=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==''&&v!=null));
 const token=localStorage.getItem('token');
 const res=await fetch(`${apiBase}${path}?${q}`,{signal,credentials:'same-origin',headers:token?{Authorization:`Bearer ${token}`}:{}});
 let json;try{json=await res.json()}catch{throw new Error(`服务响应异常 (${res.status})`)}
 if(!res.ok||json.code!==200){const e=new Error(json.message||`请求失败 (${res.status})`);e.status=res.status;throw e}return json.data
}
export async function screenLogin(username,password){
 const res=await fetch(`${apiBase}/auth/login`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 const body=await res.json();if(!res.ok||body.code!==200)throw Error(body.message||'登录失败');return body.data
}

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""community_address_mining.py —— 从诉求标题/内容/事发地提炼 ambiguous 小区的地址并补点。

只对 location_state='ambiguous' 的小区；证据来源：
  1) 同小区名同现的 complaint.address；
  2) 标题/内容中小区名前的地址片段（区/路/街/号/社区）。
地理编码后仍要求：宜昌市范围、逆地理 city=宜昌市、区县与 community.district_code 一致；
区县不一致的只记录为 conflict 供人工裁决，不写库、不改区划。
"""
import argparse, json, os, re, sys, time
from datetime import datetime
import pymysql, requests, urllib3
urllib3.disable_warnings()
HERE=os.path.dirname(os.path.abspath(__file__)); SERVER=os.path.abspath(os.path.join(HERE,'..','..'))
OUT=os.path.join(SERVER,'.dev-logs','import-2025-2026','reports')
DISTRICT={'420502':'西陵区','420503':'伍家岗区','420504':'点军区','420505':'猇亭区','420506':'夷陵区','420525':'远安县','420526':'兴山县','420527':'秭归县','420528':'长阳土家族自治县','420529':'五峰土家族自治县','420581':'宜都市','420582':'当阳市','420583':'枝江市','420507':'高新区'}
LNG_MIN,LNG_MAX,LAT_MIN,LAT_MAX=110.0,112.3,29.5,31.8
GEO_LEVELS={'兴趣点','门址','门牌号','地址','建筑物','门牌'}

def env(path):
    e={}
    for line in open(path,encoding='utf-8'):
        line=line.strip()
        if line and not line.startswith('#') and '=' in line:
            k,v=line.split('=',1); e[k.strip()]=v.strip()
    return e
E=env(os.path.join(SERVER,'.env')); KEY=E.get('GQXQ_TIANDITU_KEY','')
HDR={'Referer':'https://ai.mockr.com.cn/','User-Agent':'Mozilla/5.0'}

def db():
    return pymysql.connect(host=E.get('GQXQ_DB_HOST','127.0.0.1'),port=int(E.get('GQXQ_DB_PORT','3306')),user=E.get('GQXQ_DB_USER','root'),password=E.get('GQXQ_DB_PASSWORD',''),database=E.get('GQXQ_DB_NAME','gqxq_service'),charset='utf8mb4',autocommit=False,cursorclass=pymysql.cursors.DictCursor)

def get(url,params):
    last=None
    for i in range(3):
        try:
            r=requests.get(url,params=params,headers=HDR,timeout=15)
            if r.status_code==200: return r.json()
        except Exception as exc: last=exc
        time.sleep(0.3*(i+1))
    return {}

def geocode(addr):
    query=addr if addr.startswith(('湖北省','宜昌市')) else '湖北省宜昌市'+addr
    f=get('https://api.tianditu.gov.cn/geocoder',{'ds':json.dumps({'keyWord':query}),'tk':KEY})
    if str(f.get('status'))!='0' or not f.get('location'): return None
    loc=f['location']
    try:
        lng,lat=float(loc['lon']),float(loc['lat']); score=float(loc.get('score') or 0)
    except Exception: return None
    level=str(loc.get('level') or '')
    if not (LNG_MIN<=lng<=LNG_MAX and LAT_MIN<=lat<=LAT_MAX): return None
    if score<85 or level not in GEO_LEVELS: return None
    rev=get('https://api.tianditu.gov.cn/geocoder',{'postStr':json.dumps({'lon':lng,'lat':lat,'ver':1}),'type':'geocode','tk':KEY})
    comp=(rev.get('result') or {}).get('addressComponent') or {}
    if str(rev.get('status'))!='0' or comp.get('city')!='宜昌市': return None
    return {'lng':lng,'lat':lat,'score':score,'level':level,'county_code':str(comp.get('county_code') or ''),'county':str(comp.get('county') or ''),'address':str(comp.get('address') or ''),'poi':str(comp.get('poi') or '')}

def candidates(conn,name,district):
    core=name[:-2] if name.endswith('小区') else name
    out=[]; seen=set()
    with conn.cursor() as cur:
        cur.execute("""select address,title,coalesce(content,'') content from complaint
          where source_system='宜接就办' and source_id regexp '^[0-9]{14}$'
          and (address like concat('%%',%s,'%%') or title like concat('%%',%s,'%%') or content like concat('%%',%s,'%%'))
          order by id desc limit 30""",[core,core,core])
        rows=cur.fetchall()
    for r in rows:
        a=(r['address'] or '').strip()
        if a and 6<=len(a)<=100 and (core in a or name in a):
            out.append((a,3 if ('区' in a and ('路' in a or '街' in a or '号' in a)) else 2))
        for text in [(r['title'] or ''),(r['content'] or '')]:
            idx=text.find(name)
            if idx<0:
                idx=text.find(core) if len(core)>=3 else -1
            if idx<0: continue
            start=max(0,idx-55); window=text[start:idx+len(name)]
            window=re.split(r'[，。；;、\n\r]',window)[-1]
            window=re.sub(r'^(我是|反映|关于|位于|家住|住在|现住|地址[:：]?|投诉|举报)','',window.strip())
            if 5<=len(window)<=80 and ('区' in window or '路' in window or '街' in window or '号' in window or '社区' in window):
                out.append((window,2 if ('路' in window or '街' in window or '号' in window) else 1))
    out.sort(key=lambda x:-x[1])
    res=[]
    for a,s in out:
        a=a.strip(' ,，。；;、')
        if a in seen: continue
        seen.add(a); res.append((a,s))
        if len(res)>=5: break
    return res

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--limit',type=int,default=0); ap.add_argument('--shard',default=''); ap.add_argument('--dry-run',action='store_true'); ap.add_argument('--report',default=os.path.join(OUT,'community-address-mining.json'))
    a=ap.parse_args()
    if not KEY: print('[error] no tianditu key'); return 2
    os.makedirs(OUT,exist_ok=True)
    conn=db()
    with conn.cursor() as cur:
        cur.execute("select code,name,district_code from community where location_state='ambiguous' order by code")
        rows=cur.fetchall()
    if a.shard:
        import zlib
        i,n=[int(x) for x in a.shard.split('/')]
        rows=[r for r in rows if zlib.crc32(str(r['code']).encode())%n==i]
    if a.limit: rows=rows[:a.limit]
    stats={'total':len(rows),'located':0,'conflict':0,'unlocated':0,'no_candidate':0}
    details=[]; conflicts=[]
    for idx,r in enumerate(rows,1):
        cands=candidates(conn,r['name'],r['district_code'])
        if not cands:
            stats['no_candidate']+=1; details.append({'code':r['code'],'name':r['name'],'state':'no_candidate'}); continue
        placed=False; local_conf=[]
        for addr,prio in cands:
            g=geocode(addr)
            if not g: continue
            match=(g['county_code'].endswith(r['district_code'])) if r['district_code']!='420507' else g['county_code'].endswith('4205')
            if match:
                src='待纠偏：按诉求标题/内容/事发地提炼地址定位（%s），天地图分数%.1f、级别%s；坐标系CGCS2000，非人工核验'%(addr[:80],g['score'],g['level'])
                details.append({'code':r['code'],'name':r['name'],'state':'located','address':addr,'lng':g['lng'],'lat':g['lat'],'county':g['county'],'source':src})
                if not a.dry_run:
                    with conn.cursor() as cur:
                        cur.execute("update community set location_lng=%s,location_lat=%s,location_coordinate_system='CGCS2000',location_source=%s,location_state='located',location_at=now() where code=%s",[g['lng'],g['lat'],src[:500],r['code']])
                    conn.commit()
                stats['located']+=1; placed=True; break
            local_conf.append({'address':addr,'county':g['county'],'countyCode':g['county_code'],'score':g['score'],'level':g['level']})
        if placed: continue
        if local_conf:
            stats['conflict']+=1; conflicts.append({'code':r['code'],'name':r['name'],'districtCode':r['district_code'],'districtName':DISTRICT.get(r['district_code'],''),'candidates':local_conf[:3]})
            details.append({'code':r['code'],'name':r['name'],'state':'conflict','candidates':local_conf[:3]})
        else:
            stats['unlocated']+=1; details.append({'code':r['code'],'name':r['name'],'state':'unlocated'})
        if idx%20==0: print('[mine] %d/%d %s'%(idx,len(rows),json.dumps(stats,ensure_ascii=False)),flush=True)
        time.sleep(0.1)
    with open(a.report,'w',encoding='utf-8') as fh: json.dump({'generatedAt':datetime.now().isoformat(),'stats':stats,'details':details,'conflicts':conflicts},fh,ensure_ascii=False,indent=1)
    print('[done]',json.dumps(stats,ensure_ascii=False),'->',a.report)
    conn.close(); return 0

if __name__=='__main__': sys.exit(main())

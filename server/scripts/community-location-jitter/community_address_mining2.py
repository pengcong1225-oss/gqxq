#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""community_address_mining2.py —— 用诉求标题/内容/事发地提炼小区地址（增强版）。

证据链：
  1) 同小区名同现的 complaint.address（含同音/异体写法，如 常刘馨苑 vs 常浏馨苑）；
  2) 地址中的「道路+门牌号」（常刘路39号）——门址级定位；
  3) 地址/标题中的名称变体 → 天地图 POI 检索。
所有结果仍要求：宜昌市范围、逆地理 city=宜昌市、区县与 community.district_code 一致；
区县不一致只记 conflict，不写库、不改区划。
"""
import argparse, json, os, re, sys, time
from datetime import datetime
import pymysql, requests, urllib3
urllib3.disable_warnings()
HERE=os.path.dirname(os.path.abspath(__file__)); SERVER=os.path.abspath(os.path.join(HERE,'..','..'))
OUT=os.path.join(SERVER,'.dev-logs','import-2025-2026','reports')
DISTRICT={'420502':'西陵区','420503':'伍家岗区','420504':'点军区','420505':'猇亭区','420506':'夷陵区','420525':'远安县','420526':'兴山县','420527':'秭归县','420528':'长阳土家族自治县','420529':'五峰土家族自治县','420581':'宜都市','420582':'当阳市','420583':'枝江市','420507':'高新区'}
LNG_MIN,LNG_MAX,LAT_MIN,LAT_MAX=110.0,112.3,29.5,31.8
LEVEL_OK={'兴趣点','门址','门牌号','地址','建筑物','门牌'}
ROAD=re.compile(r'([\u4e00-\u9fa5]{2,12}(?:路|街|大道|巷|道)[0-9]{1,4}(?:-[0-9]{1,3})?号)')
TOKEN=re.compile(r'([\u4e00-\u9fa5A-Za-z·]{2,14}?)(?:[0-9]{1,3}栋|[0-9]{1,3}单元|[0-9]{1,3}号|$)',re.S)

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
    for i in range(3):
        try:
            r=requests.get(url,params=params,headers=HDR,timeout=15)
            if r.status_code==200: return r.json()
        except Exception: pass
        time.sleep(0.3*(i+1))
    return {}
def reverse(lng,lat):
    rev=get('https://api.tianditu.gov.cn/geocoder',{'postStr':json.dumps({'lon':lng,'lat':lat,'ver':1}),'type':'geocode','tk':KEY})
    comp=(rev.get('result') or {}).get('addressComponent') or {}
    if str(rev.get('status'))!='0' or comp.get('city')!='宜昌市': return None
    return comp
def geocode(addr):
    q=addr if addr.startswith(('湖北省','宜昌市')) else '湖北省宜昌市'+addr
    f=get('https://api.tianditu.gov.cn/geocoder',{'ds':json.dumps({'keyWord':q}),'tk':KEY})
    if str(f.get('status'))!='0' or not f.get('location'): return None
    loc=f['location']
    try: lng,lat=float(loc['lon']),float(loc['lat']); score=float(loc.get('score') or 0)
    except Exception: return None
    level=str(loc.get('level') or '')
    if not (LNG_MIN<=lng<=LNG_MAX and LAT_MIN<=lat<=LAT_MAX): return None
    if level not in LEVEL_OK or score<85: return None
    comp=reverse(lng,lat)
    if not comp: return None
    return {'lng':lng,'lat':lat,'score':score,'level':level,'county':str(comp.get('county') or ''),'countyCode':str(comp.get('county_code') or ''),'address':str(comp.get('address') or ''),'poi':str(comp.get('poi') or '')}
def poi_search(kw):
    post=json.dumps({'keyWord':kw,'level':12,'mapBound':'110.6,29.5,112.3,31.8','queryType':1,'start':0,'count':10})
    r=get('https://api.tianditu.gov.cn/v2/search',{'postStr':post,'type':'query','tk':KEY})
    return r.get('pois') or []
def candidates(conn,name):
    core=name[:-2] if name.endswith('小区') else name
    with conn.cursor() as cur:
        cur.execute("""select address,title,coalesce(content,'') content from complaint
          where source_system='宜接就办' and source_id regexp '^[0-9]{14}$'
          and (address like concat('%%',%s,'%%') or title like concat('%%',%s,'%%') or content like concat('%%',%s,'%%'))
          order by id desc limit 80""",[core,core,core])
        rows=cur.fetchall()
    addrs=[]; names=[]
    for r in rows:
        a=(r['address'] or '').strip()
        if 6<=len(a)<=120:
            addrs.append(a)
            m=ROAD.search(a)
            if m: addrs.append(m.group(1))
            t=TOKEN.search(a)
            if t: names.append(t.group(1).strip('（）() '))
        for text in [(r['title'] or ''),(r['content'] or '')]:
            for m in ROAD.finditer(text):
                addrs.append(m.group(1))
    # name variants: original, core, address tokens that look like the community
    variants=[name,core]+[n for n in names if 3<=len(n)<=14]
    seen=set(); A=[]; N=[]
    for a in addrs:
        a=a.strip(' ,，。；;、')
        if a and a not in seen and len(a)>=5: seen.add(a); A.append(a)
    seen=set()
    for n in variants:
        n=n.replace('·','').strip()
        if n and n not in seen and len(n)>=3: seen.add(n); N.append(n)
    return A[:12],N[:8]
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--limit',type=int,default=0); ap.add_argument('--shard',default=''); ap.add_argument('--dry-run',action='store_true'); ap.add_argument('--report',default=os.path.join(OUT,'community-address-mining2.json'))
    a=ap.parse_args()
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
        A,N=candidates(conn,r['name'])
        placed=False; conf=[]
        # 1) POI name variants
        for kw in N:
            for p in poi_search(kw):
                nm=str(p.get('name') or '')
                core=r['name'][:-2] if r['name'].endswith('小区') else r['name']
                if not (kw in nm or nm in kw or core in nm or (len(nm)>=3 and nm[:6] in r['name'])): continue
                if any(x in nm for x in ['停车场','公交站','-门','出入口','委员会','社区']): continue
                try: lng,lat=[float(x) for x in str(p.get('lonlat','')).split(',')]
                except Exception: continue
                if not (LNG_MIN<=lng<=LNG_MAX and LAT_MIN<=lat<=LAT_MAX): continue
                comp=reverse(lng,lat)
                if not comp: continue
                cc=str(comp.get('county_code') or '')
                c6=cc[-6:]
                match=(c6[:4]=='4205') if r['district_code']=='420507' else c6==r['district_code']
                if not match: conf.append({'address':kw,'poi':nm,'county':str(comp.get('county') or ''),'countyCode':cc}); continue
                src='待纠偏：按诉求标题/内容提炼名称「%s」天地图POI命中「%s」；坐标系CGCS2000，非人工核验'%(kw,nm)
                details.append({'code':r['code'],'name':r['name'],'state':'located','via':'poi','keyword':kw,'poi':nm,'lng':lng,'lat':lat,'source':src})
                if not a.dry_run:
                    with conn.cursor() as cur: cur.execute("update community set location_lng=%s,location_lat=%s,location_coordinate_system='CGCS2000',location_source=%s,location_state='located',location_at=now() where code=%s",[lng,lat,src[:500],r['code']])
                    conn.commit()
                stats['located']+=1; placed=True; break
            if placed: break
        if placed: continue
        # 2) address geocode
        for addr in A:
            g=geocode(addr)
            if not g: continue
            c6=g['countyCode'][-6:]
            match=(c6[:4]=='4205') if r['district_code']=='420507' else c6==r['district_code']
            if not match: conf.append({'address':addr,'county':g['county'],'countyCode':g['countyCode'],'score':g['score'],'level':g['level']}); continue
            src='待纠偏：按同小区诉求事发地/标题内容提炼地址「%s」定位，天地图分数%.1f、级别%s；坐标系CGCS2000，非人工核验'%(addr[:80],g['score'],g['level'])
            details.append({'code':r['code'],'name':r['name'],'state':'located','via':'address','address':addr,'lng':g['lng'],'lat':g['lat'],'county':g['county'],'source':src})
            if not a.dry_run:
                with conn.cursor() as cur: cur.execute("update community set location_lng=%s,location_lat=%s,location_coordinate_system='CGCS2000',location_source=%s,location_state='located',location_at=now() where code=%s",[g['lng'],g['lat'],src[:500],r['code']])
                conn.commit()
            stats['located']+=1; placed=True; break
        if placed: continue
        if conf: stats['conflict']+=1; conflicts.append({'code':r['code'],'name':r['name'],'districtCode':r['district_code'],'candidates':conf[:3]}); details.append({'code':r['code'],'name':r['name'],'state':'conflict','candidates':conf[:3]})
        else: stats['unlocated']+=1; details.append({'code':r['code'],'name':r['name'],'state':'unlocated'})
        if idx%10==0: print('[mine2] %d/%d %s'%(idx,len(rows),json.dumps(stats,ensure_ascii=False)),flush=True)
        time.sleep(0.08)
    with open(a.report,'w',encoding='utf-8') as fh: json.dump({'generatedAt':datetime.now().isoformat(),'stats':stats,'details':details,'conflicts':conflicts},fh,ensure_ascii=False,indent=1)
    print('[done]',json.dumps(stats,ensure_ascii=False),'->',a.report)
    conn.close(); return 0
if __name__=='__main__': sys.exit(main())

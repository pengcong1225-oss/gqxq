#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""community_address_fill.py —— 对剩余 ambiguous 小区用诉求地址证据填充“初始点位”。

产品口径（用户 2026-11-16 确认）：系统有精确地址/位置人工纠偏，历史数据允许先有初始点位；
因此这里对逆地理区县与主数据不一致的证据也写入，但 location_source 明确标注
“区县不一致/低置信度，待人工核验”，不伪造、不静默。
优先采用区县一致证据；没有时用最佳跨区县证据。
"""
import argparse, json, os, sys, time
from datetime import datetime
import pymysql
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import community_address_mining2 as m2

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--shard',default=''); ap.add_argument('--limit',type=int,default=0)
    ap.add_argument('--report',default=os.path.join(m2.OUT,'community-address-fill.json'))
    a=ap.parse_args()
    conn=m2.db()
    with conn.cursor() as cur:
        cur.execute("select code,name,district_code from community where location_state='ambiguous' order by code")
        rows=cur.fetchall()
    if a.shard:
        import zlib
        i,n=[int(x) for x in a.shard.split('/')]
        rows=[r for r in rows if zlib.crc32(str(r['code']).encode())%n==i]
    if a.limit: rows=rows[:a.limit]
    stats={'total':len(rows),'filled_same':0,'filled_cross':0,'failed':0}; details=[]
    for idx,r in enumerate(rows,1):
        A,N=m2.candidates(conn,r['name']); opts=[]
        # POI variants
        for kw in N:
            for p in m2.poi_search(kw):
                nm=str(p.get('name') or '')
                core=r['name'][:-2] if r['name'].endswith('小区') else r['name']
                if not (kw in nm or nm in kw or core in nm or (len(nm)>=3 and nm[:6] in r['name'])): continue
                if any(x in nm for x in ['停车场','公交站','-门','出入口','委员会','社区']): continue
                try: lng,lat=[float(x) for x in str(p.get('lonlat','')).split(',')]
                except Exception: continue
                comp=m2.reverse(lng,lat)
                if not comp: continue
                cc=str(comp.get('county_code') or '')
                same=(cc[-6:][:4]=='4205') if r['district_code']=='420507' else (cc[-6:]==r['district_code'])
                opts.append({'lng':lng,'lat':lat,'score':90,'level':'兴趣点','county':str(comp.get('county') or ''),'countyCode':cc,'addr':'POI:'+nm,'same':same})
        # address geocode
        for addr in A:
            g=m2.geocode(addr)
            if not g: continue
            cc=g['countyCode']; same=(cc[-6:][:4]=='4205') if r['district_code']=='420507' else (cc[-6:]==r['district_code'])
            opts.append({'lng':g['lng'],'lat':g['lat'],'score':g['score'],'level':g['level'],'county':g['county'],'countyCode':cc,'addr':addr,'same':same})
        if not opts:
            stats['failed']+=1; details.append({'code':r['code'],'name':r['name'],'state':'failed'}); continue
        same=[o for o in opts if o['same']]
        pick=sorted(same or opts,key=lambda o:-o['score'])[0]
        cross=not pick['same']
        note=('证据指向%s（主数据%s），区县不一致，待人工核验'%(pick['county'],m2.DISTRICT.get(r['district_code'],r['district_code']))) if cross else ('证据区县一致，待人工核验')
        src='待纠偏：按同小区诉求标题/内容/事发地提炼并写入初始点位（%s；%s；分数%.1f/级别%s）；坐标系CGCS2000'%(pick['addr'][:80],note,pick['score'],pick['level'])
        with conn.cursor() as cur:
            cur.execute("update community set location_lng=%s,location_lat=%s,location_coordinate_system='CGCS2000',location_source=%s,location_state='located',location_at=now() where code=%s",[pick['lng'],pick['lat'],src[:500],r['code']])
        conn.commit()
        stats['filled_cross' if cross else 'filled_same']+=1
        details.append({'code':r['code'],'name':r['name'],'state':'located','crossDistrict':cross,'county':pick['county'],'lng':pick['lng'],'lat':pick['lat'],'score':pick['score'],'level':pick['level'],'evidence':pick['addr']})
        if idx%10==0: print('[fill]',idx,json.dumps(stats,ensure_ascii=False),flush=True)
        time.sleep(0.08)
    with open(a.report,'w',encoding='utf-8') as fh: json.dump({'generatedAt':datetime.now().isoformat(),'stats':stats,'details':details},fh,ensure_ascii=False,indent=1)
    print('[done]',json.dumps(stats,ensure_ascii=False),'->',a.report)
    conn.close()
if __name__=='__main__': main()

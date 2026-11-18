#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""community_poi_locate.py —— 用天地图 POI 检索补点仍为 ambiguous 的小区。

约束：名字命中、逆地理确认宜昌市、区县一致；不满足的保留 ambiguous，不伪造。
抖动由 community_location_jitter.py --jitter 增量执行。
"""
import argparse, json, os, re, sys, time
from datetime import datetime
import pymysql, requests, urllib3
urllib3.disable_warnings()
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(SERVER, '.dev-logs', 'import-2025-2026', 'reports')
LNG_MIN, LNG_MAX, LAT_MIN, LAT_MAX = 110.0, 112.3, 29.5, 31.8
BAD = re.compile(r'[-－]?(门|出入口|停车场|公交站|站|委员会|居委会|便民服务站|超市|银行|公司|营业厅|派出所|学校|幼儿园|医院|药店|酒店|宾馆|餐馆|饭店|加油站|充电站|快递|驿站)$')


def env(path):
    e = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            e[k.strip()] = v.strip()
    return e


E = env(os.path.join(SERVER, '.env'))
KEY = E.get('GQXQ_TIANDITU_KEY', '')
HDR = {'Referer': 'https://ai.mockr.com.cn/', 'User-Agent': 'Mozilla/5.0'}


def db():
    return pymysql.connect(host=E.get('GQXQ_DB_HOST', '127.0.0.1'), port=int(E.get('GQXQ_DB_PORT', '3306')),
                           user=E.get('GQXQ_DB_USER', 'root'), password=E.get('GQXQ_DB_PASSWORD', ''),
                           database=E.get('GQXQ_DB_NAME', 'gqxq_service'), charset='utf8mb4',
                           autocommit=False, cursorclass=pymysql.cursors.DictCursor)


def search(kw):
    post = json.dumps({'keyWord': kw, 'level': 12, 'mapBound': '110.6,29.5,112.3,31.8', 'queryType': 1, 'start': 0, 'count': 10})
    for attempt in range(2):
        try:
            r = requests.get('https://api.tianditu.gov.cn/v2/search', params={'postStr': post, 'type': 'query', 'tk': KEY}, headers=HDR, timeout=8)
            if r.status_code == 200:
                return r.json().get('pois') or []
        except Exception:
            pass
        time.sleep(0.4 * (attempt + 1))
    return []


def reverse(lng, lat):
    for attempt in range(3):
        try:
            r = requests.get('https://api.tianditu.gov.cn/geocoder', params={'postStr': json.dumps({'lon': lng, 'lat': lat, 'ver': 1}), 'type': 'geocode', 'tk': KEY}, headers=HDR, timeout=15)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(0.4 * (attempt + 1))
    return {}


def poi_score(poi, name):
    nm = str(poi.get('name') or '')
    core = name[:-2] if name.endswith('小区') else name
    if BAD.search(nm):
        return -1
    if nm == name:
        return 5
    if nm == core:
        return 4
    if nm.startswith(core) and len(nm) - len(core) <= 4:
        return 3
    if core in nm and len(core) >= 3:
        return 2
    if nm in name and len(nm) >= 3:
        return 1
    return -1


def locate(name, district):
    core = name[:-2] if name.endswith('小区') else name
    keywords = [name]
    if core != name:
        keywords.append(core)
    seen = set()
    for kw in keywords:
        if kw in seen:
            continue
        seen.add(kw)
        pois = search(kw)
        ranked = sorted([(poi_score(p, name), p) for p in pois], key=lambda x: -x[0])
        for sc, p in ranked[:3]:
            if sc <= 0:
                continue
            try:
                lng, lat = [float(x) for x in str(p.get('lonlat', '')).split(',')]
            except Exception:
                continue
            if not (LNG_MIN <= lng <= LNG_MAX and LAT_MIN <= lat <= LAT_MAX):
                continue
            rev = reverse(lng, lat)
            comp = (rev.get('result') or {}).get('addressComponent') or {}
            if str(rev.get('status')) != '0' or comp.get('city') != '宜昌市':
                continue
            cc = str(comp.get('county_code') or '')
            if district and district != '420507' and not cc.endswith(district):
                continue
            if district == '420507' and not cc.endswith('4205'):
                continue
            source = '待纠偏：天地图POI检索命中「%s」，命中分%d，%s%s；坐标系CGCS2000，非人工核验' % (
                p.get('name'), sc, comp.get('county') or '', str(comp.get('address') or '')[:70])
            return lng, lat, source[:500]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--shard', default='')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--report', default=os.path.join(OUT, 'community-poi-locate.json'))
    a = ap.parse_args()
    if not KEY:
        print('[error] GQXQ_TIANDITU_KEY missing')
        return 2
    os.makedirs(OUT, exist_ok=True)
    conn = db()
    with conn.cursor() as cur:
        cur.execute("select code,name,district_code from community where location_state='ambiguous' order by code")
        rows = cur.fetchall()
    if a.shard:
        import zlib
        i, n = [int(x) for x in a.shard.split('/')]
        rows = [r for r in rows if zlib.crc32(str(r['code']).encode('utf-8')) % n == i]
    if a.limit:
        rows = rows[:a.limit]
    stats = {'total': len(rows), 'located': 0, 'ambiguous': 0, 'error': 0}
    details = []
    for idx, r in enumerate(rows, 1):
        try:
            found = locate(r['name'], r['district_code'])
        except Exception:
            found = None
            stats['error'] += 1
        if found:
            stats['located'] += 1
            details.append({'code': r['code'], 'name': r['name'], 'state': 'located', 'lng': found[0], 'lat': found[1], 'source': found[2]})
            if not a.dry_run:
                with conn.cursor() as cur:
                    cur.execute("update community set location_lng=%s,location_lat=%s,location_coordinate_system='CGCS2000',location_source=%s,location_state='located',location_at=now() where code=%s",
                                [found[0], found[1], found[2], r['code']])
                conn.commit()
        else:
            stats['ambiguous'] += 1
            details.append({'code': r['code'], 'name': r['name'], 'state': 'ambiguous'})
        if idx % 20 == 0 or idx == len(rows):
            print('[poi] %d/%d %s' % (idx, len(rows), json.dumps(stats, ensure_ascii=False)), flush=True)
        time.sleep(0.12)
    with open(a.report, 'w', encoding='utf-8') as fh:
        json.dump({'generatedAt': datetime.now().isoformat(), 'stats': stats, 'details': details}, fh, ensure_ascii=False, indent=1)
    print('[done]', json.dumps(stats, ensure_ascii=False), '->', a.report)
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""community_location_jitter.py —— 小区主数据定位与坐标抖动（初始化/运维工具）。

边界（与《数据抖动服务技术说明》一致）：
  1. location_lng/location_lat 是小区定位结果，来自天地图地理编码，保留原值；
  2. jitter_lng/jitter_lat 是数据服务中心返回的展示坐标，**只用于地图展示**，
     绝不覆盖 location_*，也不参与面积/叠加/查询条件；
  3. 抖动失败不伪造成功：保留 jitter_state=failed 与错误原因；
  4. 不输出任何诉求人姓名/电话（本脚本只处理小区主数据）。

用法（在 server 目录执行）：
  python scripts/community-location-jitter/community_location_jitter.py --dry-run
  python scripts/community-location-jitter/community_location_jitter.py --geocode
  python scripts/community-location-jitter/community_location_jitter.py --jitter
  python scripts/community-location-jitter/community_location_jitter.py --geocode --jitter --limit 200
  # 报告默认写 .dev-logs/import-2025-2026/reports/community-location-jitter.json
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
from datetime import datetime

import pymysql
import requests
import urllib3

urllib3.disable_warnings()
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..', '..'))
REPORT_DIR = os.path.join(SERVER, '.dev-logs', 'import-2025-2026', 'reports')

DISTRICT_NAME = {
    '420502': '西陵区', '420503': '伍家岗区', '420504': '点军区', '420505': '猇亭区',
    '420506': '夷陵区', '420525': '远安县', '420526': '兴山县', '420527': '秭归县',
    '420528': '长阳土家族自治县', '420529': '五峰土家族自治县', '420581': '宜都市',
    '420582': '当阳市', '420583': '枝江市', '420507': '高新区',
}
COUNTY_CODE = {v: k for k, v in DISTRICT_NAME.items()}
LNG_MIN, LNG_MAX, LAT_MIN, LAT_MAX = 110.0, 112.3, 29.5, 31.8
GEO_LEVELS = {'兴趣点', '门址', '门牌号', '地址', '建筑物', '门牌'}


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env(os.path.join(SERVER, '.env'))


def opt(name, fallback=''):
    v = ENV.get(name)
    return fallback if v is None or v == '' else v


def db():
    return pymysql.connect(host=opt('GQXQ_DB_HOST', '127.0.0.1'), port=int(opt('GQXQ_DB_PORT', '3306')),
                           user=opt('GQXQ_DB_USER', 'root'), password=opt('GQXQ_DB_PASSWORD', ''),
                           database=opt('GQXQ_DB_NAME', 'gqxq_service'), charset='utf8mb4', autocommit=False,
                           cursorclass=pymysql.cursors.DictCursor)


TIANDITU_KEY = opt('GQXQ_TIANDITU_KEY')
GEO_HEADERS = {'Referer': 'https://ai.mockr.com.cn/', 'User-Agent': 'Mozilla/5.0'}


def http_get(url, params, timeout=15, verify=True):
    last = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=GEO_HEADERS, timeout=timeout, verify=verify)
            if r.status_code == 200:
                return r.json()
            last = 'HTTP %s' % r.status_code
        except Exception as exc:  # noqa: BLE001
            last = type(exc).__name__ + ':' + str(exc)[:120]
        time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(last or 'request failed')


def geocode_one(name, district_code):
    """返回 (state, lng, lat, source)。state=located/ambiguous/unlocated。"""
    district_name = DISTRICT_NAME.get(district_code or '', '')
    query = '湖北省宜昌市' + (name if district_code == '420507' else (district_name + name))
    forward = http_get('https://api.tianditu.gov.cn/geocoder', {'ds': json.dumps({'keyWord': query}), 'tk': TIANDITU_KEY})
    if str(forward.get('status')) != '0' or not forward.get('location'):
        return 'unlocated', None, None, '天地图未返回可用结果'
    loc = forward['location']
    try:
        lng, lat = float(loc['lon']), float(loc['lat'])
        score = float(loc.get('score') or 0)
    except (KeyError, TypeError, ValueError):
        return 'unlocated', None, None, '天地图结果字段无效'
    level = str(loc.get('level') or '')
    if not (LNG_MIN <= lng <= LNG_MAX and LAT_MIN <= lat <= LAT_MAX):
        return 'ambiguous', None, None, '天地图结果超出宜昌范围'
    strict = score >= 95 and level in GEO_LEVELS
    relaxed = (not strict) and score >= 90 and level == '兴趣点'
    if not strict and not relaxed:
        return 'ambiguous', None, None, '天地图匹配分数%s、级别%s，未达兴趣点阈值' % (score, level or '未知')
    reverse = http_get('https://api.tianditu.gov.cn/geocoder', {
        'postStr': json.dumps({'lon': lng, 'lat': lat, 'ver': 1}), 'type': 'geocode', 'tk': TIANDITU_KEY})
    comp = (reverse.get('result') or {}).get('addressComponent') or {}
    if str(reverse.get('status')) != '0' or comp.get('city') != '宜昌市':
        return 'ambiguous', None, None, '天地图逆地理未确认宜昌市'
    county_code = str(comp.get('county_code') or '')
    county = str(comp.get('county') or '')
    if district_code and district_code != '420507':
        if not county_code.endswith(district_code):
            return 'ambiguous', None, None, '逆地理区县%s与主数据区划%s不一致' % (county or '未知', district_name or district_code)
    elif district_code == '420507':
        if not county_code.endswith('4205'):
            return 'ambiguous', None, None, '逆地理不在宜昌市辖区'
    if relaxed:
        core = name[:-2] if name.endswith('小区') else name
        poi = str(comp.get('poi') or '')
        formatted = str((reverse.get('result') or {}).get('formatted_address') or '')
        matched = bool(core) and (core in poi or core in formatted or (len(poi) >= 3 and poi[:6] in name))
        if not matched:
            return 'ambiguous', None, None, '天地图90分档兴趣点名称未匹配（逆地理POI=%s）' % (poi or '无')[:120]
    source = '待纠偏：天地图兴趣点匹配%s，分数%.1f，级别%s，逆地理POI%s，%s；坐标系CGCS2000，非人工核验' % (
        '(90分档)' if relaxed else '', score, level or '未知', str(comp.get('poi') or '')[:40], str(comp.get('address') or '')[:80])
    return 'located', lng, lat, source[:500]




def candidate_addresses(conn, name, district_code, limit=3):
    """用与小区名同现的诉求事发地作为定位证据；只取非空、长度合理的地址。"""
    core = name[:-2] if name.endswith('小区') else name
    with conn.cursor() as cur:
        cur.execute("select address,count(*) c from complaint where source_system='宜接就办' and address is not null and char_length(address) between 6 and 100 and (address like concat('%%',%s,'%%') or title like concat('%%',%s,'%%') or content like concat('%%',%s,'%%')) group by address order by c desc limit %s", [core, core, core, limit])
        return [r['address'].strip() for r in cur.fetchall() if r['address'] and r['address'].strip()]


def geocode_address(address, district_code):
    """按事发地地址定位；仍要求宜昌市 + 区县一致，分数>=90，不猜区县。"""
    query = address if ('宜昌市' in address or '湖北省' in address) else ('湖北省宜昌市' + address)
    if not query.startswith('湖北省') and not query.startswith('宜昌市'):
        query = '湖北省宜昌市' + query
    forward = http_get('https://api.tianditu.gov.cn/geocoder', {'ds': json.dumps({'keyWord': query}), 'tk': TIANDITU_KEY})
    if str(forward.get('status')) != '0' or not forward.get('location'):
        return None
    loc = forward['location']
    try:
        lng, lat = float(loc['lon']), float(loc['lat'])
        score = float(loc.get('score') or 0)
    except (KeyError, TypeError, ValueError):
        return None
    level = str(loc.get('level') or '')
    if not (LNG_MIN <= lng <= LNG_MAX and LAT_MIN <= lat <= LAT_MAX):
        return None
    if score < 90 or level not in GEO_LEVELS:
        return None
    reverse = http_get('https://api.tianditu.gov.cn/geocoder', {
        'postStr': json.dumps({'lon': lng, 'lat': lat, 'ver': 1}), 'type': 'geocode', 'tk': TIANDITU_KEY})
    comp = (reverse.get('result') or {}).get('addressComponent') or {}
    if str(reverse.get('status')) != '0' or comp.get('city') != '宜昌市':
        return None
    county_code = str(comp.get('county_code') or '')
    if district_code and district_code != '420507' and not county_code.endswith(district_code):
        return None
    if district_code == '420507' and not county_code.endswith('4205'):
        return None
    source = '待纠偏：按诉求事发地定位，分数%.1f，级别%s，逆地理%s%s；坐标系CGCS2000，非人工核验' % (
        score, level or '未知', str(comp.get('county') or ''), str(comp.get('address') or '')[:80])
    return lng, lat, source[:500]


def cmd_geocode(args, conn):
    with conn.cursor() as cur:
        cur.execute('''select c.code,c.name,c.admin_grid_code,a.district_code,a.name as grid_name
                       from community c left join admin_grid a on a.code=c.admin_grid_code
                       where c.location_state is null or c.location_state in ('unlocated','ambiguous','failed')
                       order by c.code''')
        rows = cur.fetchall()
    if args.shard:
        import zlib
        i, n = [int(x) for x in args.shard.split('/')]
        rows = [r for r in rows if zlib.crc32(str(r['code']).encode('utf-8')) % n == i]
    if args.limit:
        rows = rows[:args.limit]
    stats = {'total': len(rows), 'located': 0, 'ambiguous': 0, 'unlocated': 0, 'error': 0}
    details = []
    for i, row in enumerate(rows, 1):
        code = row['code']; name = row['name']; dcode = row['district_code']
        try:
            state, lng, lat, source = geocode_one(name, dcode)
        except Exception as exc:  # noqa: BLE001
            state, lng, lat, source = 'failed', None, None, '天地图调用失败：' + str(exc)[:200]
        if state != 'located' and getattr(args, 'address_fallback', True):
            for address in candidate_addresses(conn, name, dcode):
                try:
                    found = geocode_address(address, dcode)
                except Exception:  # noqa: BLE001
                    found = None
                if found:
                    state, lng, lat, source = 'located', found[0], found[1], found[2] + '；事发地=' + address[:120]
                    break
        stats[state if state in stats else 'error'] += 1
        details.append({'code': code, 'name': name, 'districtCode': dcode, 'state': state, 'lng': lng, 'lat': lat, 'source': source})
        if not args.dry_run:
            with conn.cursor() as cur:
                if state == 'located':
                    cur.execute('''update community set district_code=coalesce(district_code,%s), location_lng=%s,location_lat=%s,
                                   location_coordinate_system='CGCS2000',location_source=%s,location_state='located',location_at=now()
                                   where code=%s''', [dcode, lng, lat, source, code])
                else:
                    cur.execute('''update community set district_code=coalesce(district_code,%s),location_state=%s,location_source=%s,location_at=now()
                                   where code=%s''', [dcode, state, source, code])
            conn.commit()
        if i % 25 == 0 or i == len(rows):
            print('[geocode] %d/%d %s' % (i, len(rows), json.dumps(stats, ensure_ascii=False)), flush=True)
        time.sleep(float(opt('GQXQ_GEOCODE_INTERVAL_MS', '150')) / 1000.0)
    return stats, details


def jitter_api(method, path, body=None, headers=None):
    base = opt('GQXQ_JITTER_BASE_URL', '').rstrip('/')
    if not base:
        raise RuntimeError('GQXQ_JITTER_BASE_URL 未配置')
    h = {'X-App-Id': opt('GQXQ_JITTER_APP_ID'), 'X-API-Key': opt('GQXQ_JITTER_API_KEY'),
         'Content-Type': 'application/json'}
    if headers:
        h.update(headers)
    verify = opt('GQXQ_JITTER_INSECURE_TLS', 'false') != 'true'
    r = requests.request(method, base + path, headers=h, json=body, timeout=60, verify=verify)
    if r.status_code >= 400:
        raise RuntimeError('jitter HTTP %s %s' % (r.status_code, r.text[:300]))
    return r.json()


def submit_batch(points, idem):
    body = {'crs': 'EPSG:4326', 'items': [{'business_id': p['code'], 'longitude': float(p.get('lng', p.get('location_lng'))), 'latitude': float(p.get('lat', p.get('location_lat')))} for p in points]}
    job = jitter_api('POST', '/api/v1/jitter/jobs', body, {'Idempotency-Key': idem})
    jid = job['job_id']
    poll_ms = int(opt('GQXQ_JITTER_POLL_MS', '2000')); poll_max = int(opt('GQXQ_JITTER_POLL_MAX', '120'))
    status = job.get('status')
    for _ in range(poll_max):
        if status in ('succeeded', 'partial_failed', 'failed', 'interrupted'):
            break
        time.sleep(poll_ms / 1000.0)
        status = jitter_api('GET', '/api/v1/jitter/jobs/' + jid).get('status')
    items = []
    if status in ('succeeded', 'partial_failed'):
        page = 1
        while True:
            res = jitter_api('GET', '/api/v1/jitter/jobs/%s/results?page=%d&page_size=100' % (jid, page))
            items.extend(res.get('items') or [])
            if len(items) >= int(res.get('total') or 0) or not res.get('items'):
                break
            page += 1
    return jid, status, items


def cmd_jitter(args, conn):
    # 抖动前后必须可证明原始定位未被覆盖：先落快照，供独立核对比较。
    with conn.cursor() as cur:
        cur.execute("select code,location_lng,location_lat from community where location_lng is not null order by code")
        snapshot = [{'code': r['code'], 'lng': None if r['location_lng'] is None else str(r['location_lng']),
                     'lat': None if r['location_lat'] is None else str(r['location_lat'])} for r in cur.fetchall()]
    snap_path = os.path.join(REPORT_DIR, 'community-location-before-jitter.json')
    with open(snap_path, 'w', encoding='utf-8') as fh:
        json.dump({'capturedAt': datetime.now().isoformat(), 'rows': snapshot}, fh, ensure_ascii=False)
    with conn.cursor() as cur:
        cur.execute('''select code,location_lng,location_lat from community
                       where location_state='located' and location_lng is not null and location_lat is not null
                         and (jitter_state is null or jitter_state in ('failed','interrupted'))
                       order by code''')
        rows = cur.fetchall()
    if args.limit:
        rows = rows[:args.limit]
    batch_size = int(opt('GQXQ_JITTER_BATCH_SIZE', '200'))
    stats = {'total': len(rows), 'succeeded': 0, 'failed': 0, 'jobs': [], 'errors': [], 'locationSnapshot': snap_path}
    for start in range(0, len(rows), batch_size):
        points = rows[start:start + batch_size]
        idem = 'community-jitter-%s-%03d' % (datetime.now().strftime('%Y%m%d%H%M%S'), start // batch_size)
        try:
            jid, status, items = submit_batch(points, idem)
            stats['jobs'].append({'jobId': jid, 'status': status, 'points': len(points)})
            by_id = {str(it.get('business_id')): it for it in items}
            with conn.cursor() as cur:
                for p in points:
                    it = by_id.get(p['code'])
                    if it and it.get('status') == 'success' and it.get('output'):
                        lon = float(it['output']['longitude']); lat = float(it['output']['latitude'])
                        if LNG_MIN <= lon <= LNG_MAX and LAT_MIN <= lat <= LAT_MAX:
                            cur.execute('''update community set jitter_lng=%s,jitter_lat=%s,jitter_state='succeeded',jitter_job_id=%s,jitter_at=now(),jitter_message=null where code=%s''',
                                        [lon, lat, jid, p['code']])
                            stats['succeeded'] += 1
                        else:
                            cur.execute('''update community set jitter_state='failed',jitter_job_id=%s,jitter_at=now(),jitter_message=%s where code=%s''',
                                        [jid, '抖动结果超出宜昌范围', p['code']])
                            stats['failed'] += 1
                    else:
                        msg = (it or {}).get('error') or ('任务状态 ' + str(status))
                        cur.execute('''update community set jitter_state='failed',jitter_job_id=%s,jitter_at=now(),jitter_message=%s where code=%s''',
                                    [jid, str(msg)[:500], p['code']])
                        stats['failed'] += 1
            conn.commit()
            print('[jitter] job=%s status=%s %d/%d' % (jid, status, min(start + batch_size, len(rows)), len(rows)), flush=True)
        except Exception as exc:  # noqa: BLE001
            stats['errors'].append({'start': start, 'error': str(exc)[:300]})
            print('[jitter] batch %d 失败：%s' % (start, str(exc)[:200]), flush=True)
    return stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--geocode', action='store_true')
    parser.add_argument('--jitter', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--shard', default='', help='i/n 仅处理 crc32(code)%n==i 的小区，用于并行')
    parser.add_argument('--no-address-fallback', dest='address_fallback', action='store_false', help='关闭按事发地兜底定位')
    parser.add_argument('--report', default=os.path.join(REPORT_DIR, 'community-location-jitter.json'))
    args = parser.parse_args()
    if not args.geocode and not args.jitter:
        args.geocode = True; args.jitter = True
    if not TIANDITU_KEY:
        print('[error] GQXQ_TIANDITU_KEY 未配置'); return 2
    os.makedirs(REPORT_DIR, exist_ok=True)
    conn = db()
    result = {'startedAt': datetime.now().isoformat(), 'dryRun': args.dry_run}
    try:
        if args.geocode:
            stats, details = cmd_geocode(args, conn)
            result['geocode'] = {'stats': stats, 'details': details}
        if args.jitter:
            result['jitter'] = cmd_jitter(args, conn)
    finally:
        conn.close()
    result['finishedAt'] = datetime.now().isoformat()
    with open(args.report, 'w', encoding='utf-8') as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print('[done] report=' + args.report)
    return 0


if __name__ == '__main__':
    sys.exit(main())

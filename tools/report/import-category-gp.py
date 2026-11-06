#!/usr/bin/env python3
# 類別毛利匯入（2026-11-06）：把私有 CSV（/Users/kai/lixue-data/category-gp/{店}.csv，不在公開 repo）寫進
# Firestore stores/{店}/categoryGp/{YYYY-MM}。每月各類別成本、零售加總必須跟合計列差 0，否則整份不寫。
# 用法：python3 tools/report/import-category-gp.py <csv> <店名> [YYYY-MM ...]   （不給月份＝全部；加 --dry 只驗算）
import csv, json, subprocess, sys, urllib.request, urllib.parse, datetime
args = [a for a in sys.argv[1:] if a != '--dry']; dry = '--dry' in sys.argv
path, store, only = args[0], args[1], set(args[2:])
R = list(csv.DictReader(open(path, encoding='utf-8')))
num = lambda r: {'code': r['code'], 'name': r['name'], 'cost': int(r['cost']), 'retail': int(r['retail']), 'share': float(r['share']),
                 'gp': float(r['gp']), 'contrib': float(r['contrib']), 'yoy_gp': float(r['yoy_gp']), 'yoy_contrib': float(r['yoy_contrib'])}
docs = {}
for r in R:
    if only and r['month'] not in only: continue
    d = docs.setdefault(r['month'], {'month': r['month'], 'rows': [], 'total': None})
    if r['code'] == 'TOTAL': t = num(r); t.pop('code'); t.pop('name'); d['total'] = t
    else: d['rows'].append(num(r))
bad = False
for m, d in sorted(docs.items()):
    t = d['total']
    dc = sum(x['cost'] for x in d['rows']) - t['cost'] if t else None
    dr = sum(x['retail'] for x in d['rows']) - t['retail'] if t else None
    print(m, len(d['rows']), '類', '成本差', dc, '零售差', dr)
    if t is None or dc != 0 or dr != 0: bad = True
if bad: sys.exit('❌ 加總對不上，沒有寫入')
if dry: sys.exit(0)
tok = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True, timeout=30).strip()
BASE = 'https://firestore.googleapis.com/v1/projects/store-schedule-3b056/databases/(default)/documents/'
def fv(v):
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [fv(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: fv(x) for k, x in v.items()}}}
    return {'nullValue': None}
now = datetime.datetime.utcnow().isoformat() + 'Z'
for m, d in sorted(docs.items()):
    d = dict(d, source='photo:PSR501D', importedAt=now)
    url = BASE + urllib.parse.quote(f'stores/{store}/categoryGp/{m}')
    req = urllib.request.Request(url, data=json.dumps({'fields': {k: fv(v) for k, v in d.items()}}).encode(), method='PATCH',
                                 headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    urllib.request.urlopen(req).read(); print('✅ 寫入', store, m)

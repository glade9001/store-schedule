#!/usr/bin/env python3
# 每人使用盤點（唯讀）：近 30 天開啟、推播、LINE、薪資簽收、打卡、缺卡、補登、劃休。
# 用法：python3 tools/report/usage-report.py 2026-10   輸出含員工姓名，只印在本機，不要 commit 結果。
import collections, datetime as dt, json, subprocess, sys, urllib.parse, urllib.request

ym = sys.argv[1] if len(sys.argv) > 1 else (dt.date.today().replace(day=1) - dt.timedelta(1)).strftime('%Y-%m')
y, m = int(ym[:4]), int(ym[5:])
prev = f'{y - 1}-12' if m == 1 else f'{y}-{m - 1:02d}'  # 這個月發的是上個月的薪資
tok = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True, timeout=30).strip()
BASE = 'https://firestore.googleapis.com/v1/projects/store-schedule-3b056/databases/(default)/documents/'
STORES = ['美德', '聯鑫', '錦花']

def val(x):
    if 'integerValue' in x: return int(x['integerValue'])
    if 'mapValue' in x: return {k: val(v) for k, v in x['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in x: return [val(v) for v in x['arrayValue'].get('values', [])]
    for k in ('stringValue', 'doubleValue', 'booleanValue', 'timestampValue'):
        if k in x: return x[k]
    return None

def rows(path):
    out, page = [], ''
    while True:
        url = BASE + urllib.parse.quote(path, safe='/') + '?pageSize=300' + (f'&pageToken={page}' if page else '')
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Bearer ' + tok}), timeout=25))
        out += [dict(id=x['name'].split('/')[-1], **{k: val(v) for k, v in x.get('fields', {}).items()}) for x in d.get('documents', [])]
        page = d.get('nextPageToken')
        if not page: return out

users = [u for u in rows('users') if u.get('store') in STORES and u.get('empName')]
push = {p.get('uid') or p['id'].split('_')[0] for p in rows('pushSubs')}
line = {b.get('uid') or b['id'] for b in rows('lineBindings')}
ack = {a['id'] for a in rows('salaryAck') if a.get('month') == prev}
now = dt.datetime.now(dt.timezone.utc)
seen = set()
for s in STORES:
    emp = {e['id'] for e in rows(f'stores/{s}/employees') if e.get('status') in (None, '在職')}
    att = rows(f'stores/{s}/attendance'); req = rows(f'stores/{s}/attendanceRequests'); leave = rows(f'stores/{s}/leaveRequests')
    print(f'\n== {s}')
    print('姓名|職位|幾天前開|模式|推播|LINE|簽收|卡|缺卡|補登|劃休')
    for u in sorted(users, key=lambda x: x.get('displayName') or ''):
        n = u['empName']
        if u['store'] != s or n not in emp or (s, n) in seen and not u.get('appUsage'): continue
        if (s, n) in seen: continue
        seen.add((s, n))
        ap = u.get('appUsage') or {}
        last = max([x for x in (ap.get('lastStandaloneAt'), ap.get('lastBrowserAt')) if x], default=None)
        days = (now - dt.datetime.fromisoformat(last.replace('Z', '+00:00'))).days if last else '—'
        a = [r for r in att if r.get('empName') == n and str(r.get('shiftDate') or r.get('date'))[:7] == ym and not r.get('voided')]
        c = collections.Counter(r.get('type') for r in a)
        print('|'.join(map(str, [u.get('displayName') or n, u.get('role'), days, ap.get('lastMode') or '—', '✓' if u['id'] in push else '✗', '✓' if u['id'] in line else '✗',
                                 '✓' if f"{u['id']}_{prev}" in ack else '✗', c['上班'] + c['下班'], c['缺卡'],
                                 sum(1 for r in req if r.get('empName') == n and str(r.get('targetDate'))[:7] == ym),
                                 sum(1 for r in leave if r.get('empName') == n and str(r.get('createdAt'))[:7] == ym)])))

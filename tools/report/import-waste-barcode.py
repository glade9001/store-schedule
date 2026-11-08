#!/usr/bin/env python3
# 報廢條碼表匯入（2026-11-08）：私有 TSV（/Users/kai/lixue-data/waste-barcode/items.tsv：cat name code barcode）
# → Firestore settings/wasteBarcode。每一筆條碼檢查碼（EAN-8／EAN-13）都要對、條碼不可重複，否則整份不寫。
# 用法：python3 tools/report/import-waste-barcode.py <tsv> <表的版本，例 2026/08> [--dry]
import csv, json, subprocess, sys, urllib.request, urllib.parse, datetime
args = [a for a in sys.argv[1:] if a != '--dry']; dry = '--dry' in sys.argv
path, sheet = args[0], args[1]
def ok(b):
    if not b.isdigit() or len(b) not in (8, 13): return False
    d = [int(x) for x in b]; body = d[:-1]
    s = sum(x * (3 if (i % 2 == 0 if len(b) == 8 else i % 2 == 1) else 1) for i, x in enumerate(body))
    return (10 - s % 10) % 10 == d[-1]
R = list(csv.DictReader(open(path, encoding='utf-8'), delimiter='\t'))
bad = [r for r in R if not ok(r['barcode']) or not r['code'].isdigit() or not r['name'].strip()]
dup = {r['barcode'] for r in R if sum(1 for x in R if x['barcode'] == r['barcode']) > 1}
print('共', len(R), '筆；檢查碼／欄位錯', len(bad), '；條碼重複', len(dup))
for r in bad: print('  ❌', r)
if bad or dup: sys.exit('❌ 沒有寫入')
if dry: sys.exit(0)
items = [{'cat': r['cat'], 'name': r['name'].strip(), 'code': r['code'], 'barcode': r['barcode']} for r in R]
tok = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True, timeout=30).strip()
def fv(v):
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [fv(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: fv(x) for k, x in v.items()}}}
doc = {'items': items, 'sheet': sheet, 'updatedAt': datetime.datetime.utcnow().isoformat() + 'Z', 'source': 'photo'}
url = 'https://firestore.googleapis.com/v1/projects/store-schedule-3b056/databases/(default)/documents/settings/wasteBarcode'
req = urllib.request.Request(url, data=json.dumps({'fields': {k: fv(v) for k, v in doc.items()}}).encode(), method='PATCH',
                             headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
urllib.request.urlopen(req).read(); print('✅ 寫入 settings/wasteBarcode', len(items), '項，版本', sheet)

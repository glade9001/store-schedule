#!/bin/zsh
# ② 權限規則：用模擬器載入 repo 的 firestore.rules 跑 rules-cases.js（需要 Java：brew install openjdk@21）
HERE=${0:A:h}; ROOT=${HERE:h:h}; TMP=$(mktemp -d)
cp "$ROOT/firestore.rules" "$TMP/firestore.rules"
print '{"firestore":{"rules":"firestore.rules"}}' > "$TMP/firebase.json"
cd "$TMP"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
echo "② 權限規則（模擬器）"
firebase emulators:exec --only firestore --project demo-rt "node '$HERE/rules-cases.js'" > "$TMP/out.txt" 2>&1
code=$?
grep -E "✅|❌|全部符合|項不符" "$TMP/out.txt" | sed 's/^/  /'
cd / && trash "$TMP"   # 暫存資料夾移到廢紙簍
exit $code

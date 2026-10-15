#!/bin/zsh
# 上線前檢查：① 語法與載入 ② 權限規則（模擬器，改到 firestore.rules 或加 --full 才跑）③ 畫面試算 ④ 資料健檢
# 用法：zsh tools/check/run.sh [--full]    任何一項 ❌ 就 exit 1（tools/deploy.sh 會停止上線）
HERE=${0:A:h}; ROOT=${HERE:h:h}; cd "$ROOT"
fail=0
node tools/check/syntax.js || fail=1
echo
if [[ "$1" == "--full" ]] || ! git diff --quiet HEAD -- firestore.rules || git diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q firestore.rules; then
  zsh tools/check/rules-test.sh || fail=1; echo
fi
node tools/check/smoke.js || fail=1
echo
node tools/check/data-health.js || fail=1
echo
(( fail )) && echo "❌ 上線前檢查沒過，先修好再上線" || echo "✅ 上線前檢查全部通過"
exit $fail

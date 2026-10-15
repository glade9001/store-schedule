#!/bin/zsh
# 上線：先跑上線前檢查 → 通過才 firebase deploy → 確認 web.app 與 github.io 兩個網址都是新版
# 用法：zsh tools/deploy.sh hosting
#       zsh tools/deploy.sh functions:onSchedulePublishedPush,functions:scheduledAutoPublishPush
#       zsh tools/deploy.sh firestore:rules
# ⚠️ functions 一律指定函式名稱，不要整包部署（另一個視窗可能有還沒 commit 的改動）；不加 --force（不刪雲端的函式）。
# ⚠️ 要先 commit＋push：github.io 是 push 自動更新，web.app 才是這支部署的。
HERE=${0:A:h}; ROOT=${HERE:h}; cd "$ROOT"
[[ -z "$1" ]] && { echo "用法：zsh tools/deploy.sh hosting | functions:名稱,... | firestore:rules"; exit 2; }
if ! git diff --quiet HEAD -- . ':!firestore-debug.log' 2>/dev/null; then echo "⚠️ 還有沒 commit 的改動（可能是另一個視窗的），確認過再部署："; git status --short | grep -v DS_Store; fi
git fetch -q && [[ $(git rev-parse HEAD) != $(git rev-parse @{u}) ]] && { echo "❌ 本機跟 GitHub 不同步，先 push／pull"; exit 1; }
zsh tools/check/run.sh || exit 1
firebase deploy --only "$1" --project store-schedule-3b056 2>&1 | grep -E "✔|Error|error|⚠" || exit 1
if [[ "$1" == *hosting* ]]; then
  # 上一個 commit 改到的前端檔，兩個網址都要拿到跟本機一樣的內容（CDN 可能要等一下，最多 2 分鐘）
  files=($(git diff --name-only HEAD~1 HEAD -- '*.js' '*.html' '*.css' | grep -v -E '^(functions|tools|docs)/'))
  for host in https://store-schedule-3b056.web.app https://glade9001.github.io/store-schedule; do
    for f in $files; do
      want=$(shasum "$f" | cut -c1-40); got=""
      for i in {1..24}; do got=$(curl -s "$host/$f?x=$RANDOM" | shasum | cut -c1-40); [[ "$got" == "$want" ]] && break; sleep 5; done
      [[ "$got" == "$want" ]] && echo "  ✅ $host/$f" || echo "  ❌ $host/$f 還是舊版"
    done
  done
fi

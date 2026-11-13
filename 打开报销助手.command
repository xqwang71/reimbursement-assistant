#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 22.13 或更新版本。'
  read '?按回车关闭。'
  exit 1
fi
node scripts/start.mjs "$@" || { read '?按回车关闭。'; exit 1; }

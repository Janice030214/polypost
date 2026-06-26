#!/bin/bash
# Polypost 一键停止 — 双击运行

PORT=4000
RED='\033[0;31m'
GREEN='\033[0;32m'
PURPLE='\033[0;35m'
NC='\033[0m'

echo ""
echo -e "${PURPLE}╔════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║     🛑  停止 Polypost                  ║${NC}"
echo -e "${PURPLE}╚════════════════════════════════════════╝${NC}"
echo ""

PIDS=$(lsof -ti :$PORT)
if [ -z "$PIDS" ]; then
  echo "ℹ️   Polypost 没有在运行（端口 $PORT 空闲）"
else
  echo "🛑  正在停止进程：$PIDS"
  kill $PIDS 2>/dev/null
  sleep 1
  # 还活着就强杀
  REMAINING=$(lsof -ti :$PORT)
  if [ -n "$REMAINING" ]; then
    kill -9 $REMAINING 2>/dev/null
  fi
  echo -e "${GREEN}✅ 已停止${NC}"
fi

echo ""
sleep 2
exit 0

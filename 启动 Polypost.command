#!/bin/bash
# Polypost 一键启动 — 双击运行
#
# 用法：
#   1. 直接在项目目录里双击此文件即可
#   2. 也可以「右键 → 制作替身」把替身拖到桌面，双击替身效果一样
#   3. 如果你打算把这个文件复制（不是替身）到别处，请把下面的 PROJECT_DIR
#      改成项目目录的绝对路径

# === 自动找到项目目录（跟随替身 / symlink）===
# 如果失败，可以把下面这行注释掉，手动指定 PROJECT_DIR=
SCRIPT_REAL_PATH="$(perl -MCwd=abs_path -le 'print abs_path readlink($ARGV[0]) || $ARGV[0]' "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(dirname "$SCRIPT_REAL_PATH")"
# PROJECT_DIR="/Users/你的用户名/path/to/polypost"   # ← 失败时手动改这里

PORT=4000

# 颜色
PURPLE='\033[0;35m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${PURPLE}╔════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║     🚀  启动 Polypost                  ║${NC}"
echo -e "${PURPLE}╚════════════════════════════════════════╝${NC}"
echo ""

# 1. 检查项目目录
if [ ! -f "$PROJECT_DIR/server.js" ]; then
  echo -e "${RED}❌ 找不到项目目录${NC}"
  echo "   检测到：$PROJECT_DIR"
  echo "   里面没有 server.js"
  echo ""
  echo "   请编辑这个脚本，把 PROJECT_DIR 改成 Polypost 项目的绝对路径"
  echo ""
  read -p "按回车键关闭窗口..."
  exit 1
fi
cd "$PROJECT_DIR" || exit 1
echo "📁  项目目录：$PROJECT_DIR"
echo ""

# 2. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}❌ Node.js 没装${NC}"
  echo "   去 https://nodejs.org/ 下载安装"
  echo ""
  read -p "按回车键关闭窗口..."
  exit 1
fi

# 3. 检查 .env
if [ ! -f ".env" ]; then
  echo -e "${RED}❌ 没找到 .env 配置文件${NC}"
  echo "   请按照 安装教程.md 创建并填写 .env 文件"
  echo ""
  read -p "按回车键关闭窗口..."
  exit 1
fi

# 4. 检查依赖
if [ ! -d "node_modules" ]; then
  echo "📦  第一次启动，正在装依赖（30-60 秒）..."
  npm install
  if [ $? -ne 0 ]; then
    echo -e "${RED}❌ 装依赖失败${NC}"
    read -p "按回车键关闭窗口..."
    exit 1
  fi
fi

# 5. 是否已在运行
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo -e "${GREEN}✅ Polypost 已经在运行${NC}（端口 $PORT）"
else
  echo "🚀  启动 Polypost..."
  nohup npm start > /tmp/polypost.log 2>&1 &

  echo -n "    等待启动"
  for i in {1..15}; do
    if lsof -ti :$PORT >/dev/null 2>&1; then
      echo ""
      echo -e "${GREEN}✅ 启动成功${NC}"
      break
    fi
    echo -n "."
    sleep 1
  done

  if ! lsof -ti :$PORT >/dev/null 2>&1; then
    echo ""
    echo -e "${RED}❌ 启动失败，日志：${NC}"
    tail -20 /tmp/polypost.log
    read -p "按回车键关闭窗口..."
    exit 1
  fi
fi

# 6. 打开浏览器
echo ""
echo "🌐  打开浏览器：http://localhost:$PORT"
sleep 1
open "http://localhost:$PORT"

# 7. 提示
echo ""
echo -e "${PURPLE}────────────────────────────────────────${NC}"
echo "📝  小贴士："
echo "   • Polypost 在后台跑着，关掉这个窗口不会停掉它"
echo "   • 想停掉它：双击「停止 Polypost.command」"
echo "   • 出错看日志：tail -20 /tmp/polypost.log"
echo -e "${PURPLE}────────────────────────────────────────${NC}"
echo ""

sleep 3
exit 0

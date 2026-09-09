#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "拒绝远程管道安装：请先克隆或打开已审阅的 imgen fork，再从仓库内运行 install-skill.sh。" >&2
  exit 2
fi

PROJECT_DIR="$SCRIPT_DIR"
SKILL_DIR="$HOME/.agents/skills/imgen"
SYNC_SHARED_SKILLS="$HOME/.local/bin/sync-shared-skills"

echo "==> Installing locked dependencies..."
cd "$PROJECT_DIR"
npm ci

echo "==> Testing and building imgen..."
npm test
npm run build

echo "==> Linking imgen CLI globally..."
npm link

install_skill() {
  local skill_dir="$1"
  if [ -L "$skill_dir" ]; then
    unlink "$skill_dir"
  elif [ -e "$skill_dir" ]; then
    echo "拒绝覆盖非符号链接：$skill_dir" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$skill_dir")"
  ln -s "$PROJECT_DIR" "$skill_dir"
  echo "  $skill_dir -> $PROJECT_DIR"
}

echo "==> Installing the canonical personal skill..."
install_skill "$SKILL_DIR"

if [ -x "$SYNC_SHARED_SKILLS" ]; then
  "$SYNC_SHARED_SKILLS" --adopt
else
  echo "Warning: 未找到 $SYNC_SHARED_SKILLS；个人技能已安装，但共享技能尚未同步。" >&2
fi

echo ""
echo "Done. imgen CLI: $(command -v imgen)"
echo "Skill: $SKILL_DIR -> $PROJECT_DIR"

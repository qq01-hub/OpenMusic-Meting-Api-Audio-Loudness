#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/meting-api-audio-loudness}"
REPO_URL="${METING_AUDIO_LOUDNESS_REPO:-}"
BRANCH="${METING_AUDIO_LOUDNESS_BRANCH:-main}"

if [ -z "$REPO_URL" ]; then
    echo '请设置 METING_AUDIO_LOUDNESS_REPO 为 meting-api-audio-loudness 项目的 Git 仓库地址。' >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo '未检测到 Docker，请先安装 Docker。' >&2
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo '未检测到 Docker Compose v2，请先安装 Docker Compose。' >&2
    exit 1
fi

if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif command -v git >/dev/null 2>&1; then
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
    echo '未检测到 git，无法下载辅助项目。' >&2
    exit 1
fi

cd "$APP_DIR"
docker compose up -d --build

for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 2 http://localhost:3100/healthz >/dev/null; then
        echo "部署成功: http://localhost:3100"
        exit 0
    fi
    sleep 1
done

docker compose logs --tail 100
echo '部署失败：健康检查未通过。' >&2
exit 1

#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/meting-api-audio-loudness}"
COMPOSE_URL='https://raw.githubusercontent.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness/main/docker-compose.yml'

if ! command -v docker >/dev/null 2>&1; then
    echo '未检测到 Docker，请先安装 Docker。' >&2
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo '未检测到 Docker Compose v2，请先安装 Docker Compose。' >&2
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    echo '未检测到 curl，请先安装 curl。' >&2
    exit 1
fi

mkdir -p "$APP_DIR"
curl -fsSL "$COMPOSE_URL" -o "$APP_DIR/docker-compose.yml"
cd "$APP_DIR"
docker compose pull
docker compose up -d

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

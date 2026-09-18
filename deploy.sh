#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

docker compose up -d --build

for attempt in $(seq 1 15); do
    if curl --fail --silent --show-error --max-time 2 http://localhost:3100/healthz >/dev/null; then
        echo '部署成功: http://localhost:3100'
        echo '响度接口: GET /analyze?url=<encoded-audio-url>'
        exit 0
    fi
    sleep 1
done

docker compose logs --tail 80
echo '容器已启动，但健康检查失败: http://localhost:3100/healthz' >&2
exit 1

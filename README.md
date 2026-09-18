<div align="center">

# 🎚️ [OpenMusic-Meting-Api-Audio-Loudness](https://github.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness)

<p><strong>Meting-API 的音频响度分析辅助服务</strong></p>

<p>
  流式音频分析 · RMS 响度计算 · 峰值检测 · Redis 缓存 · Docker 部署
</p>

</div>

> 本项目是 [Meting-API](https://github.com/qq01-hub/Meting-API) 的辅助服务，负责分析音频 URL 并返回统一的 `gain` 与 `peak` 响度字段。

## 🚀 快速开始

### 前置依赖

| 依赖 | 必填 | 说明 |
|:---|:---:|:---|
| Docker | 是 | 推荐部署方式 |
| Docker Compose v2 | 是 | 一键启动应用与 Redis |
| `curl` | 是 | 仅远程一键部署需要 |
| [Meting-API](https://github.com/qq01-hub/Meting-API) | 是 | 提供音频 URL；需要鉴权时配置 Token |
| Node.js `>=22`、`ffmpeg`、Redis | 源码部署 | Docker 部署无需单独安装 |

> Docker Compose 已内置 Redis 和 `ffmpeg`。Meting-API 作为上游服务使用，不包含在本项目镜像中。

### Docker 一键部署（推荐）

服务器安装 Docker、Docker Compose v2 和 `curl` 后，执行一条命令即可完成下载、构建、启动和健康检查：

```bash
curl -fsSL https://raw.githubusercontent.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness/main/install.sh | bash
```

默认安装目录：`/opt/meting-api-audio-loudness`  
默认服务地址：`http://localhost:3100`

### Windows 一键部署

在 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy.ps1
```

## 📡 API

### `GET /analyze`

```text
http://localhost:3100/analyze?id=song-123&url=https%3A%2F%2Fexample.com%2Faudio.mp3
```

| 参数 | 必填 | 说明 |
|:---|:---:|:---|
| `url` | ✅ | 音频 URL；完整 URL 必须进行 URL 编码 |
| `id` / `songId` | — | 歌曲 ID；传入后启用 Redis 缓存 |
| `key` | — | Meting-API 鉴权 Token |

响应示例：

```json
{
  "loudness": {
    "gain": -10.1234,
    "peak": 0.9876
  },
  "source": "url",
  "decoder": "ffmpeg",
  "cacheHit": false
}
```

> `gain` 为 RMS dBFS，`peak` 为线性峰值，均保留 4 位小数。外层 `url` 参数必须编码完整的 Meting URL，避免其中的 `&server=...` 被误解析。

### Token 配置

```powershell
$env:UPSTREAM_API_TOKEN = '你的 Meting API Token'
docker compose up -d --build
```

## ⚙️ 配置项

| 环境变量 | 默认值 | 说明 |
|:---|:---:|:---|
| `PORT` | `3100` | 服务端口 |
| `UPSTREAM_API_TOKEN` | 空 | 默认 Meting-API Token |
| `MAX_DOWNLOAD_BYTES` | `67108864` | 单个音频最大下载大小（字节） |
| `REQUEST_TIMEOUT_MS` | `30000` | 音频请求超时时间（毫秒） |

健康检查：`http://localhost:3100/healthz`

## 🐳 Docker 镜像

每次向 GitHub 仓库推送代码，GitHub Actions 会自动构建并推送 Docker 镜像到 GHCR，不需要创建 GitHub Release。

```text
ghcr.io/qq01-hub/openmusic-meting-api-audio-loudness:latest
```

工作流文件：`.github/workflows/docker-publish.yml`

## 🧪 源码运行

```powershell
npm install
npm start
```

## 📄 许可证

本项目为 [Meting-API](https://github.com/qq01-hub/Meting-API) 提供音频响度分析辅助能力。

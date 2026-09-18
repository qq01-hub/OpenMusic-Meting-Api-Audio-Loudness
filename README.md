# [OpenMusic-Meting-Api-Audio-Loudness](https://github.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness)

这是 [Meting-API](https://github.com/qq01-hub/Meting-API) 项目的辅助服务。

服务接收 Meting 返回的音频 URL，使用流式 `ffmpeg` 计算音频响度，并返回统一的 `gain` 与 `peak` 字段。

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 响度分析 | 计算全音频 PCM RMS 的 dBFS（`gain`）和线性峰值（`peak`） |
| Redis 缓存 | 按歌曲 ID 缓存分析结果，默认保留 30 天，避免重复下载和分析 |
| 流式处理 | 不缓存解码后的 PCM，降低内存占用 |
| 安全限制 | 默认限制下载大小为 64 MiB，请求超时为 30 秒 |
| 容器化部署 | 支持 Docker、Docker Compose，以及 Windows / Linux 一键部署 |

## 快速开始

### 本地运行

环境要求：Node.js 22+、`ffmpeg`、Redis。

```powershell
npm install
npm start
```

服务默认监听 `3100` 端口。

### 请求示例

```text
GET http://localhost:3100/analyze?id=song-123&url=https%3A%2F%2Fexample.com%2Faudio.mp3
```

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

其中：

- `gain`：全音频 PCM RMS 的 dBFS，保留 4 位小数。
- `peak`：全音频 PCM 的线性峰值，保留 4 位小数。
- `cacheHit`：是否直接命中 Redis 缓存。

## API 使用说明

### `/analyze`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 音频 URL；如果 URL 中包含 `&`，必须对完整 URL 进行编码 |
| `id` / `songId` | 否 | 歌曲 ID。传入后启用 Redis 缓存 |
| `key` | 否 | 访问需要鉴权的 Meting API 时使用的 Token |

示例：

```text
/analyze?key=你的Token&id=test-001&url=编码后的音频链接
```

> 注意：外层 `url` 参数必须对完整的 Meting URL 做 URL 编码，避免其中的 `&server=...` 被本服务解析为自己的参数。

### 鉴权 Token

可以通过请求参数传入 Token，也可以设置环境变量作为默认 Token：

```powershell
$env:UPSTREAM_API_TOKEN = '你的 Meting API Token'
docker compose up -d --build
```

## Docker 部署

### Docker Compose（推荐）

```powershell
docker compose up -d --build
```

启动后检查健康状态：

```text
http://localhost:3100/healthz
```

### 单容器运行

```powershell
docker build -t openmusic-meting-api .
docker run --rm -p 3100:3100 --memory=256m openmusic-meting-api
```

## 一键部署

### Windows

在 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy.ps1
```

脚本会自动构建镜像、启动服务，并等待 `http://localhost:3100/healthz` 通过。重复执行会复用并更新同一个 Compose 服务。

### Linux

需要预先安装 Docker、Docker Compose v2 和 `curl`：

```bash
bash deploy.sh
```

脚本会自动构建镜像、启动服务，并等待健康检查通过。

如果项目已发布到 GitHub，也可以使用远程安装脚本：

```bash
export METING_AUDIO_LOUDNESS_REPO=https://github.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness.git
curl -fsSL https://raw.githubusercontent.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness/main/install.sh | bash
```

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | 服务监听端口 |
| `UPSTREAM_API_TOKEN` | 空 | 默认的 Meting API Token |
| `MAX_DOWNLOAD_BYTES` | `67108864` | 单个音频最大下载大小（字节） |
| `REQUEST_TIMEOUT_MS` | `30000` | 音频请求超时时间（毫秒） |

Compose 中 Redis 最大内存为 64 MiB，应用容器最大内存为 256 MiB。

## 开发与测试

```powershell
npm install
npm test
```

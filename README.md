<div align="center">

# 🎵 [OpenMusic-Meting-Api-Audio-Loudness](https://github.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness)

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
| Docker | 是 | 推荐部署方式；需提前安装 |
| Docker Compose v2 | 是 | 一键启动应用与 Redis |
| `curl` | 是 | 仅远程一键部署需要 |
| [Meting-API](https://github.com/qq01-hub/Meting-API) | 是 | 提供歌曲音频直链 |
| Node.js `>=22` | 源码部署 | Docker 部署无需单独安装 |

> Docker Compose 已内置 Redis 和 `ffmpeg`，Redis 使用华为云镜像 `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/redis:7-alpine`。Meting-API 作为上游服务使用，不包含在本项目镜像中。

### Docker 一键部署（推荐）

服务器安装 Docker、Docker Compose v2 和 `curl` 后，执行一条命令即可下载 Compose 配置、拉取最新镜像、启动服务并完成健康检查：

```bash
curl -fsSL https://raw.githubusercontent.com/qq01-hub/OpenMusic-Meting-Api-Audio-Loudness/main/install.sh | bash
```

默认安装目录：`/opt/meting-api-audio-loudness`  
默认服务地址：`http://localhost:3100`

> 一键部署不需要 Git。GHCR 镜像需要设置为公开；如果镜像为私有，请先执行 `docker login ghcr.io`。

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

响应示例：

```json
{
  "loudness": {
    "gain": -14.2000,
    "peak": 0.8913
  },
  "source": "url",
  "decoder": "ffmpeg",
  "cacheHit": false
}
```

> `url` 必须是歌曲音频直链，而不是 Meting-API 的接口地址；`gain` 为全曲 Integrated LUFS，`peak` 为 True Peak 转换后的线性值，均保留 4 位小数。URL 中如果包含 `&`，请先对完整 URL 进行编码。

## ⚙️ 配置项

| 环境变量 | 默认值 | 说明 |
|:---|:---:|:---|
| `PORT` | `3100` | 服务端口 |
| `IMAGE_TAG` | `latest` | Docker 镜像标签 |
| `MAX_DOWNLOAD_BYTES` | `67108864` | 单个音频最大下载大小（字节） |
| `REQUEST_TIMEOUT_MS` | `30000` | 音频请求超时时间（毫秒） |

健康检查：`http://localhost:3100/healthz`

## 🧪 源码运行

```powershell
npm install
npm start
```

## 📄 许可证

本项目为 [Meting-API](https://github.com/qq01-hub/Meting-API) 提供音频响度分析辅助能力。

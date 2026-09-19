import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Hono } from 'hono'
import { createRedisCache } from './cache.js'

const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES || 64 * 1024 * 1024)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30_000)
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe'
const TARGET_LUFS = Number(process.env.TARGET_LUFS || -14)
export const getAnalysisWindow = (duration) => {
    if (!Number.isFinite(duration) || duration > 60) return { start: 60, duration: 30 }
    return { start: Math.max(0, duration - 30), duration: Math.min(30, Math.max(0, duration)) }
}

export const createFfmpegArgs = ({ start = 60, duration = 30 } = {}) => [
    '-hide_banner', '-loglevel', 'info', '-i', 'pipe:0', '-ss', String(start), '-t', String(duration),
    '-vn', '-af', 'ebur128=framelog=quiet:peak=true', '-f', 'null', '-',
]

const round4 = (value) => Math.round(value * 10000) / 10000

export const parseEbur128Summary = (stderr) => {
    const lufsMatch = String(stderr).match(/Integrated loudness:[\s\S]*?\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i)
    const truePeakMatch = String(stderr).match(/True peak:[\s\S]*?\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/i)
    if (!lufsMatch) return undefined
    const lufs = Number(lufsMatch[1])
    const truePeak = truePeakMatch ? Number(truePeakMatch[1]) : undefined
    return {
        lufs: round4(lufs),
        ...(truePeak === undefined ? {} : { truePeak: round4(truePeak), peak: round4(10 ** (truePeak / 20)) }),
    }
}

export const extractAudioUrl = (requestUrl) => {
    const marker = 'url='
    const markerIndex = String(requestUrl).indexOf(marker)
    if (markerIndex < 0) return ''
    const rawValue = String(requestUrl).slice(markerIndex + marker.length).split('#')[0]
    try { return decodeURIComponent(rawValue) } catch { return rawValue }
}

export const describeRequestError = (error) => {
    const cause = error?.cause
    const detail = cause?.code || cause?.message
    return detail ? `${error?.message || 'request failed'} (${detail})` : error?.message || 'request failed'
}

export const fetchAudioResponse = async (target, options = {}) => {
    let current = new URL(target)
    let headers = options.headers || { 'User-Agent': process.env.UPSTREAM_USER_AGENT || 'meting-api-audio-loudness/1.0' }
    for (let redirect = 0; redirect <= 5; redirect += 1) {
        const response = await fetch(current, { ...options, headers, redirect: 'manual' })
        if (response.status < 300 || response.status >= 400) return response
        const location = response.headers.get('location')
        if (!location) return response
        current = new URL(location, current)
        headers = { 'User-Agent': 'meting-api-audio-loudness/1.0', Connection: 'close' }
    }
    throw new Error('too many audio redirects')
}

const isClosedStdinError = (error) => error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED'

const endStdin = (stdin, value) => new Promise((resolve, reject) => {
    let settled = false
    let fallback
    const finish = (error) => {
        if (settled) return
        settled = true
        if (fallback) clearImmediate(fallback)
        stdin.removeListener?.('error', onError)
        if (!error || isClosedStdinError(error)) resolve()
        else reject(error)
    }
    const onError = (error) => finish(error)
    stdin.on?.('error', onError)
    try {
        stdin.end(value, finish)
        fallback = setImmediate(finish)
    } catch (error) {
        finish(error)
    }
})

export const pipeResponseToStdin = async (response, stdin, maxBytes = MAX_DOWNLOAD_BYTES) => {
    const reader = response.body?.getReader()
    if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > maxBytes) throw new Error(`audio exceeds ${maxBytes} bytes`)
        await endStdin(stdin, buffer)
        return
    }
    let size = 0
    let stopped = false
    let streamError
    const onError = (error) => {
        if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') stopped = true
        else streamError = error
    }
    stdin.on?.('error', onError)
    try {
        while (true) {
            if (stopped || streamError) break
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxBytes) throw new Error(`audio exceeds ${maxBytes} bytes`)
            if (!stdin.write(Buffer.from(value))) await once(stdin, 'drain')
        }
    } finally {
        reader.releaseLock()
        stdin.removeListener?.('error', onError)
    }
    if (streamError) throw streamError
    if (stopped) return
    await endStdin(stdin)
}

const readResponse = async (response) => {
    const chunks = []
    let size = 0
    const reader = response.body?.getReader()
    if (!reader) return Buffer.from(await response.arrayBuffer())
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_DOWNLOAD_BYTES) throw new Error(`audio exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
            chunks.push(Buffer.from(value))
        }
    } finally {
        reader.releaseLock()
    }
    return Buffer.concat(chunks, size)
}

const probeDuration = (buffer) => new Promise((resolve) => {
    const child = spawn(FFPROBE_BIN, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', '-i', 'pipe:0',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => {
        const duration = Number.parseFloat(stdout.trim())
        resolve(code === 0 && Number.isFinite(duration) ? duration : undefined)
    })
    endStdin(child.stdin, buffer).catch(() => {})
})

const analyzeWithFfmpeg = (input, window) => new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, createFfmpegArgs(window), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
        else {
            const summary = parseEbur128Summary(stderr)
            if (!summary) return resolve(undefined)
            const gain = round4(TARGET_LUFS - summary.lufs)
            resolve({ gain, peak: summary.peak === undefined ? undefined : round4(summary.peak * (10 ** (gain / 20))) })
        }
    })
    const inputPromise = Buffer.isBuffer(input)
        ? endStdin(child.stdin, input)
        : pipeResponseToStdin(input, child.stdin)
    inputPromise.catch((error) => {
        if (isClosedStdinError(error)) return
        child.stdin.destroy(error)
        child.kill()
        reject(error)
    })
})

export const analyzeBuffer = async (buffer, contentType = '') => {
    const duration = await probeDuration(buffer)
    const loudness = await analyzeWithFfmpeg(buffer, getAnalysisWindow(duration))
    return { loudness, decoder: 'ffmpeg', contentType }
}

export const analyzeResponse = async (response, contentType = '') => {
    return analyzeBuffer(await readResponse(response), contentType)
}

export const createApp = ({ cache = createRedisCache() } = {}) => {
    const app = new Hono()
    app.get('/healthz', (c) => c.json({ ok: true }))
    app.get('/analyze', async (c) => {
        const url = extractAudioUrl(c.req.url) || c.req.query('url')
        if (!url) return c.json({ error: 'url is required' }, 400)
        let parsed
        try { parsed = new URL(url) } catch { return c.json({ error: 'url must be valid' }, 400) }
        if (!['http:', 'https:'].includes(parsed.protocol)) return c.json({ error: 'only direct http and https audio URLs are supported' }, 400)
        const songId = c.req.query('id') || c.req.query('songId')
        if (songId) {
            try {
                const cached = await cache.get(songId)
                if (cached?.loudness) return c.json({ ...cached, source: 'cache', cacheHit: true })
            } catch (error) { console.warn('[AudioLoudness] Redis read skipped:', error?.message || error) }
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await fetchAudioResponse(parsed, { signal: controller.signal })
            if (!response.ok) return c.json({ error: `audio download failed with status ${response.status}` }, 502)
            const result = await analyzeResponse(response, response.headers.get('content-type') || '')
            if (!result.loudness) return c.json({ error: 'unable to decode audio' }, 422)
            const payload = { loudness: result.loudness, ...(result.duration ? { duration: result.duration } : {}), source: 'url', decoder: result.decoder, cacheHit: false }
            if (songId) {
                try { await cache.set(songId, payload) } catch (error) { console.warn('[AudioLoudness] Redis write skipped:', error?.message || error) }
            }
            return c.json(payload)
        } catch (error) {
            const message = error?.name === 'AbortError' ? 'audio download timed out' : describeRequestError(error)
            return c.json({ error: message }, 502)
        } finally { clearTimeout(timeout) }
    })
    return app
}

export const app = createApp()

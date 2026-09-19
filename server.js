import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Hono } from 'hono'
import { createRedisCache } from './cache.js'

const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES || 64 * 1024 * 1024)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30_000)
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'
const TARGET_LUFS = Number(process.env.TARGET_LUFS || -14)
const ANALYSIS_DURATION_SECONDS = Number(process.env.ANALYSIS_DURATION_SECONDS || 10)
const ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY || 2))
const ANALYSIS_QUEUE_LIMIT = Math.max(0, Number(process.env.ANALYSIS_QUEUE_LIMIT || 16))
const ANALYSIS_QUEUE_TIMEOUT_MS = Number(process.env.ANALYSIS_QUEUE_TIMEOUT_MS || 2_000)
const CACHE_OPERATION_TIMEOUT_MS = Number(process.env.CACHE_OPERATION_TIMEOUT_MS || 500)

export const attachSocketErrorHandler = (server, onUnexpectedError = console.error) => {
    server.on('connection', (socket) => {
        socket.on('error', (error) => {
            if (error?.code === 'EPIPE' || error?.code === 'ECONNRESET' || error?.code === 'ERR_STREAM_DESTROYED') return
            onUnexpectedError(error)
        })
    })
    return server
}

export const getAnalysisWindow = (duration) => {
    if (!Number.isFinite(duration)) return { start: 30, duration: ANALYSIS_DURATION_SECONDS }
    const safeDuration = Math.max(0, duration)
    const start = Math.min(30, Math.max(0, safeDuration - ANALYSIS_DURATION_SECONDS))
    return { start, duration: Math.min(ANALYSIS_DURATION_SECONDS, safeDuration - start) }
}

export const createFfmpegArgs = ({ source = 'pipe:0', start = 30, duration = ANALYSIS_DURATION_SECONDS } = {}) => {
    const inputArgs = source === 'pipe:0'
        ? ['-i', source, '-ss', String(start), '-t', String(duration)]
        : ['-ss', String(start), '-t', String(duration), '-i', source]
    return [
        '-hide_banner', '-loglevel', 'info', '-threads', '1', ...inputArgs,
        '-vn', '-af', 'ebur128=framelog=quiet:peak=true', '-f', 'null', '-',
    ]
}

export const createAnalysisLimiter = ({ concurrency = ANALYSIS_CONCURRENCY, queueLimit = ANALYSIS_QUEUE_LIMIT } = {}) => {
    const maxConcurrency = Math.max(1, Math.floor(concurrency))
    const maxQueue = Math.max(0, Math.floor(queueLimit))
    let active = 0
    const queue = []

    const createRelease = () => {
        let released = false
        return () => {
            if (released) return
            released = true
            active -= 1
            while (queue.length) {
                const next = queue.shift()
                if (next.signal?.aborted) {
                    next.reject(Object.assign(new Error('analysis queue wait was aborted'), { code: 'ANALYSIS_QUEUE_ABORTED' }))
                    continue
                }
                next.signal?.removeEventListener('abort', next.onAbort)
                active += 1
                next.resolve(createRelease())
                break
            }
        }
    }

    const abortError = () => Object.assign(new Error('analysis queue wait was aborted'), { code: 'ANALYSIS_QUEUE_ABORTED' })

    return {
        acquire({ signal } = {}) {
            if (signal?.aborted) return Promise.reject(abortError())
            if (active < maxConcurrency) {
                active += 1
                return Promise.resolve(createRelease())
            }
            if (queue.length >= maxQueue) {
                const error = new Error('analysis queue is full')
                error.code = 'ANALYSIS_QUEUE_FULL'
                return Promise.reject(error)
            }
            return new Promise((resolve, reject) => {
                const entry = { resolve, reject, signal, onAbort: undefined }
                entry.onAbort = () => {
                    const index = queue.indexOf(entry)
                    if (index >= 0) queue.splice(index, 1)
                    reject(abortError())
                }
                signal?.addEventListener('abort', entry.onAbort, { once: true })
                queue.push(entry)
            })
        },
    }
}

const round4 = (value) => Math.round(value * 10000) / 10000

const withTimeout = (operation, timeoutMs) => {
    let timer
    return Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('cache operation timed out'), { code: 'CACHE_TIMEOUT' })), timeoutMs) }),
    ]).finally(() => clearTimeout(timer))
}

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
        if (!error || isClosedStdinError(error)) resolve()
        else reject(error)
    }
    const onError = (error) => finish(error)
    stdin.on?.('error', onError)
    stdin.once?.('close', () => stdin.removeListener?.('error', onError))
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
        if (stopped) await reader.cancel().catch(() => {})
        reader.releaseLock()
        stdin.removeListener?.('error', onError)
    }
    if (streamError) throw streamError
    if (stopped) return
    await endStdin(stdin)
}

const analyzeWithFfmpeg = (input, window, signal) => new Promise((resolve, reject) => {
    const isUrl = typeof input === 'string'
    const child = spawn(FFMPEG_BIN, createFfmpegArgs({ ...window, ...(isUrl ? { source: input } : {}) }), { stdio: ['pipe', 'pipe', 'pipe'], signal })
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
    if (isUrl) return
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
    const loudness = await analyzeWithFfmpeg(buffer, getAnalysisWindow())
    return { loudness, decoder: 'ffmpeg', contentType }
}

export const analyzeResponse = async (response, contentType = '') => {
    const loudness = await analyzeWithFfmpeg(response, getAnalysisWindow())
    return { loudness, decoder: 'ffmpeg', contentType }
}

export const analyzeUrl = async (url, signal, contentType = '') => {
    const loudness = await analyzeWithFfmpeg(url, getAnalysisWindow(), signal)
    return { loudness, decoder: 'ffmpeg', contentType }
}

export const createApp = ({ cache = createRedisCache(), limiter = createAnalysisLimiter(), analyze = analyzeUrl, cacheTimeoutMs = CACHE_OPERATION_TIMEOUT_MS } = {}) => {
    const app = new Hono()
    const inFlight = new Map()
    app.get('/healthz', (c) => c.json({ ok: true }))
    app.get('/analyze', async (c) => {
        const url = extractAudioUrl(c.req.url) || c.req.query('url')
        if (!url) return c.json({ error: 'url is required' }, 400)
        let parsed
        try { parsed = new URL(url) } catch { return c.json({ error: 'url must be valid' }, 400) }
        if (!['http:', 'https:'].includes(parsed.protocol)) return c.json({ error: 'only direct http and https audio URLs are supported' }, 400)
        const songId = c.req.query('id') || c.req.query('songId')
        const key = songId ? String(songId).trim() : ''
        const existing = key ? inFlight.get(key) : undefined
        const execute = async () => {
            if (songId) {
                try {
                    const cached = await withTimeout(cache.get(songId), cacheTimeoutMs)
                    if (cached?.loudness) return { ...cached, source: 'cache', cacheHit: true }
                } catch (error) { console.warn('[AudioLoudness] Redis read skipped:', error?.message || error) }
            }
            const queueController = new AbortController()
            const queueTimeout = setTimeout(() => queueController.abort(), ANALYSIS_QUEUE_TIMEOUT_MS)
            let release
            try {
                release = await limiter.acquire({ signal: queueController.signal })
            } finally {
                clearTimeout(queueTimeout)
            }
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
            try {
                const result = await analyze(parsed.toString(), controller.signal)
                if (!result.loudness) throw Object.assign(new Error('unable to decode audio'), { status: 422 })
                const payload = { loudness: result.loudness, source: 'url', decoder: result.decoder, cacheHit: false }
                if (songId) {
                    try { await withTimeout(cache.set(songId, payload), cacheTimeoutMs) } catch (error) { console.warn('[AudioLoudness] Redis write skipped:', error?.message || error) }
                }
                return payload
            } finally {
                clearTimeout(timeout)
                release()
            }
        }
        const task = existing || (key && cache.withLock ? cache.withLock(key, execute) : execute())
        if (key && !existing) inFlight.set(key, task)
        try {
            return c.json(await task, 200)
        } catch (error) {
            if (error?.code === 'ANALYSIS_QUEUE_FULL') return c.json({ error: 'analysis queue is full' }, 429)
            if (error?.code === 'ANALYSIS_QUEUE_ABORTED') return c.json({ error: 'analysis queue wait timed out' }, 429)
            if (error?.code === 'CACHE_LOCK_TIMEOUT') return c.json({ error: 'analysis is busy, please retry' }, 503)
            const message = error?.name === 'AbortError' ? 'audio download timed out' : describeRequestError(error)
            return c.json({ error: message }, error?.status || 502)
        } finally {
            if (key && inFlight.get(key) === task) inFlight.delete(key)
        }
    })
    return app
}

export const app = createApp()

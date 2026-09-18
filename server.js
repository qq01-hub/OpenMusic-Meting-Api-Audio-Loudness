import { spawn } from 'node:child_process'
import { Hono } from 'hono'
import { decodeWav, createPcmAccumulator } from './loudness.js'
import { createRedisCache } from './cache.js'

const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES || 64 * 1024 * 1024)
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30_000)
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'

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
    let headers = options.headers || {}
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

const readResponse = async (response) => {
    const reader = response.body?.getReader()
    if (!reader) return Buffer.from(await response.arrayBuffer())
    const chunks = []
    let size = 0
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

const analyzeWithFfmpeg = (buffer) => new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const accumulator = createPcmAccumulator()
    let remainder = Buffer.alloc(0)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.on('data', (chunk) => {
        const bytes = Buffer.concat([remainder, chunk])
        const usable = bytes.length - (bytes.length % 4)
        const samples = new Float32Array(usable / 4)
        for (let index = 0; index < usable; index += 4) samples[index / 4] = bytes.readFloatLE(index)
        accumulator.add(samples)
        remainder = bytes.subarray(usable)
    })
    child.on('error', reject)
    child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
        else resolve(accumulator.result())
    })
    child.stdin.end(buffer)
})

export const analyzeBuffer = async (buffer, contentType = '') => {
    const wav = decodeWav(buffer)
    if (wav) return { loudness: (() => { const result = createPcmAccumulator(); result.add(wav.samples); return result.result() })(), duration: wav.duration, decoder: 'wav' }
    const loudness = await analyzeWithFfmpeg(buffer)
    return { loudness, decoder: 'ffmpeg', contentType }
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
            const buffer = await readResponse(response)
            const result = await analyzeBuffer(buffer, response.headers.get('content-type') || '')
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

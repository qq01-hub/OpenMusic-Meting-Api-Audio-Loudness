import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createFfmpegArgs, describeRequestError, extractAudioUrl, fetchAudioResponse, getAnalysisWindow, parseEbur128Summary, pipeResponseToStdin } from './server.js'

test('analyzes the one-minute to one-minute-thirty window', () => {
    assert.deepEqual(createFfmpegArgs(), [
        '-hide_banner', '-loglevel', 'info', '-i', 'pipe:0', '-ss', '60', '-t', '30',
        '-vn', '-af', 'ebur128=framelog=quiet:peak=true', '-f', 'null', '-',
    ])
})

test('uses the final 30 seconds when the audio is shorter than one minute', () => {
    assert.deepEqual(getAnalysisWindow(45), { start: 15, duration: 30 })
})

test('keeps a 30-second window for a full-length audio track', () => {
    assert.deepEqual(getAnalysisWindow(180), { start: 60, duration: 30 })
})

test('parses integrated LUFS and true peak from ebur128 output', () => {
    const summary = parseEbur128Summary(`
Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.2 LUFS
True peak:
    Peak:       -1.0 dBFS
`)
    assert.deepEqual(summary, { lufs: -14.2, truePeak: -1, peak: 0.8913 })
})

test('extracts an encoded direct song URL', () => {
    const audioUrl = 'https://cdn.example.com/audio/song-001.mp3'
    const requestUrl = `http://localhost:3100/analyze?id=test-001&url=${encodeURIComponent(audioUrl)}`
    assert.equal(extractAudioUrl(requestUrl), audioUrl)
})

test('keeps the network error cause in the response message', () => {
    assert.equal(describeRequestError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'fetch failed (ECONNRESET)')
})

test('follows a direct audio redirect without forwarding headers', async () => {
    const calls = []
    const fakeFetch = async (url, options) => {
        calls.push({ url: String(url), options })
        if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/audio.mp3' } })
        return new Response('audio', { status: 200 })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
        const response = await fetchAudioResponse('https://cdn.example/audio.mp3')
        assert.equal(response.status, 200)
        assert.equal(calls[1].options.headers.Authorization, undefined)
    } finally { globalThis.fetch = originalFetch }
})

test('sends a user agent on the initial audio request', async () => {
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options })
        return new Response('audio', { status: 200 })
    }
    try {
        await fetchAudioResponse('https://cdn.example/audio.mp3')
        assert.equal(calls[0].options.headers['User-Agent'], 'meting-api-audio-loudness/1.0')
    } finally { globalThis.fetch = originalFetch }
})

test('pipes each downloaded chunk before the response is fully read', async () => {
    let firstChunkWritten = false
    let secondChunkRequested = false
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1]))
        },
        async pull(controller) {
            if (secondChunkRequested) return
            secondChunkRequested = true
            while (!firstChunkWritten) await new Promise((resolve) => setTimeout(resolve, 1))
            controller.enqueue(new Uint8Array([2]))
            controller.close()
        },
    })
    const writes = []
    const stdin = {
        write(chunk) {
            writes.push(Buffer.from(chunk))
            firstChunkWritten = true
            return true
        },
        end() { writes.push('end') },
    }

    await pipeResponseToStdin({ body }, stdin)

    assert.deepEqual(writes, [Buffer.from([1]), Buffer.from([2]), 'end'])
})

test('does not crash when ffmpeg closes stdin early', async () => {
    const stdin = new EventEmitter()
    stdin.write = () => {
        process.nextTick(() => stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
        return true
    }
    stdin.end = () => {}
    const body = new ReadableStream({
        async pull(controller) {
            controller.enqueue(new Uint8Array([1]))
            await new Promise((resolve) => setTimeout(resolve, 5))
            controller.close()
        },
    })

    await pipeResponseToStdin({ body }, stdin)
})

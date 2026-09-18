import test from 'node:test'
import assert from 'node:assert/strict'
import { createFfmpegArgs, describeRequestError, extractAudioUrl, fetchAudioResponse, pipeResponseToStdin } from './server.js'

test('limits ffmpeg analysis to the 20-to-50 second window', () => {
    assert.deepEqual(createFfmpegArgs(), [
        '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-ss', '20', '-t', '30', '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1',
    ])
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

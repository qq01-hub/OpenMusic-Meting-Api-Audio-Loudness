import test from 'node:test'
import assert from 'node:assert/strict'
import { describeRequestError, extractAudioUrl, fetchAudioResponse } from './server.js'

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

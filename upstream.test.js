import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUpstreamHeaders, describeRequestError, extractAudioUrl, fetchAudioResponse } from './server.js'

test('adds the Meting API token as a Bearer token', () => {
    assert.deepEqual(buildUpstreamHeaders(' meting-token '), { Authorization: 'Bearer meting-token' })
    assert.deepEqual(buildUpstreamHeaders(''), {})
})

test('keeps an unencoded nested meting URL intact', () => {
    const requestUrl = 'http://localhost:3100/analyze?key=token&id=test-001&url=https://musicapi.qqovo.cn/api?server=kugou&type=url&id=72db6da75ffe23a3a6361bdb8f44d5f4&redirect=1'
    assert.equal(extractAudioUrl(requestUrl), 'https://musicapi.qqovo.cn/api?server=kugou&type=url&id=72db6da75ffe23a3a6361bdb8f44d5f4&redirect=1')
})

test('keeps the network error cause in the response message', () => {
    assert.equal(describeRequestError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'fetch failed (ECONNRESET)')
})

test('follows an audio redirect without forwarding the API token', async () => {
    const calls = []
    const fakeFetch = async (url, options) => {
        calls.push({ url: String(url), options })
        if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/audio.mp3' } })
        return new Response('audio', { status: 200 })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
        const response = await fetchAudioResponse('https://musicapi.example/api', { headers: { Authorization: 'Bearer secret' } })
        assert.equal(response.status, 200)
        assert.equal(calls[1].options.headers.Authorization, undefined)
    } finally { globalThis.fetch = originalFetch }
})

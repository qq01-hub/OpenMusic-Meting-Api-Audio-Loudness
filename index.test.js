import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, parseEbur128Summary } from './server.js'

test('returns the compatible gain and peak shape from the standard loudness measurement', () => {
    const summary = parseEbur128Summary('Integrated loudness:\n I: -14.2 LUFS\nTrue peak:\n Peak: -1.0 dBFS')
    const gain = Number((-14 - summary.lufs).toFixed(4))
    assert.deepEqual({ gain, peak: Number((summary.peak * (10 ** (gain / 20))).toFixed(4)) }, { gain: 0.2, peak: 0.9121 })
})

test('rejects an absent URL without downloading anything', async () => {
        const response = await createApp().request('/analyze')

        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { error: 'url is required' })
})

test('returns the cached result for a repeated song id', async () => {
    const values = new Map([['song-1', { loudness: { gain: -14.2, peak: 0.8913 }, source: 'url', decoder: 'ffmpeg', cacheHit: false }]])
    const cache = {
        async get(id) { return values.get(id) || null },
        async set(id, value) { values.set(id, value) },
    }
    const url = 'https://cdn.example.com/audio/song-1.wav'
    const app = createApp({ cache })
    const response = await app.request(`/analyze?id=song-1&url=${encodeURIComponent(url)}`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).cacheHit, true)
})

test('deduplicates simultaneous requests for the same song id', async () => {
    let analyses = 0
    const app = createApp({
        cache: { async get() { return null }, async set() {} },
        analyze: async () => {
            analyses += 1
            await new Promise((resolve) => setTimeout(resolve, 10))
            return { loudness: { gain: -1, peak: 0.8 }, decoder: 'test' }
        },
    })
    const url = 'https://cdn.example.com/audio/song-2.wav'
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.request(`/analyze?id=song-2&url=${encodeURIComponent(url)}`)))

    assert.equal(analyses, 1)
    assert.equal(responses.filter((response) => response.status === 200).length, 20)
})

test('deduplicates simultaneous requests for the same URL without a song id', async () => {
    let analyses = 0
    const app = createApp({
        cache: { async get() { return null }, async set() {} },
        analyze: async () => {
            analyses += 1
            await new Promise((resolve) => setTimeout(resolve, 10))
            return { loudness: { gain: -1, peak: 0.8 }, decoder: 'test' }
        },
    })
    const url = 'https://cdn.example.com/audio/shared.wav'
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.request(`/analyze?url=${encodeURIComponent(url)}`)))

    assert.equal(analyses, 1)
    assert.equal(responses.filter((response) => response.status === 200).length, 20)
})

test('continues analyzing when Redis is slow', async () => {
    let analyzed = false
    const app = createApp({
        cacheTimeoutMs: 5,
        cache: { async get() { return new Promise(() => {}) }, async set() {} },
        analyze: async () => {
            analyzed = true
            return { loudness: { gain: -1, peak: 0.8 }, decoder: 'test' }
        },
    })
    const url = 'https://cdn.example.com/audio/slow-cache.wav'
    const response = await Promise.race([
        app.request(`/analyze?id=slow-cache&url=${encodeURIComponent(url)}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('request did not bypass slow cache')), 100)),
    ])

    assert.equal(response.status, 200)
    assert.equal(analyzed, true)
})

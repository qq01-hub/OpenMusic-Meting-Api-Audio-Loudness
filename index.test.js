import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, parseEbur128Summary } from './server.js'

test('returns the compatible gain and peak shape from the standard loudness measurement', () => {
    const summary = parseEbur128Summary('Integrated loudness:\n I: -14.2 LUFS\nTrue peak:\n Peak: -1.0 dBFS')
    assert.deepEqual({ gain: summary.lufs, peak: summary.peak }, { gain: -14.2, peak: 0.8913 })
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { createCacheKey, createLoudnessCache } from './cache.js'

test('creates a stable Redis key from the song id', () => {
    assert.equal(createCacheKey('  12345 '), 'meting:loudness:v2:12345')
})

test('reads and writes cached loudness by song id', async () => {
    const values = new Map()
    const cache = createLoudnessCache({
        async get(key) { return values.get(key) || null },
        async set(key, value) { values.set(key, value) },
    })

    assert.equal(await cache.get('song-1'), null)
    await cache.set('song-1', { gain: -8.2, peak: 0.9 })
    assert.deepEqual(await cache.get('song-1'), { gain: -8.2, peak: 0.9 })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createCacheKey, createLoudnessCache, createRedisCache } from './cache.js'

test('creates a stable Redis key from the song id', () => {
    assert.equal(createCacheKey('  12345 '), 'meting:loudness:v3:12345')
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

test('retries Redis connection after a transient connection failure', async () => {
    let attempts = 0
    const cache = createRedisCache('redis://test', {
        on() {},
        async connect() {
            attempts += 1
            if (attempts === 1) throw new Error('temporary Redis outage')
        },
        async get() { return null },
    })

    await assert.rejects(cache.get('song-1'), /temporary Redis outage/)
    assert.equal(await cache.get('song-1'), null)
    assert.equal(attempts, 2)
})

test('waits for another worker and reuses its distributed result', async () => {
    const values = new Map()
    const locks = new Set()
    const cache = createLoudnessCache({
        async get(key) { return values.get(key) || null },
        async set(key, value) { values.set(key, value) },
        async setNx(key) {
            if (locks.has(key)) return null
            locks.add(key)
            return 'OK'
        },
        async del(key) { locks.delete(key) },
    })
    let analyses = 0
    const task = () => {
        analyses += 1
        return new Promise((resolve) => setTimeout(async () => {
            await cache.set('song-lock', { loudness: { gain: -1 } })
            resolve({ loudness: { gain: -1 } })
        }, 10))
    }

    const first = cache.withLock('song-lock', task)
    const second = cache.withLock('song-lock', task)
    assert.deepEqual(await Promise.all([first, second]), [{ loudness: { gain: -1 } }, { loudness: { gain: -1 }, source: 'cache', cacheHit: true }])
    assert.equal(analyses, 1)
})

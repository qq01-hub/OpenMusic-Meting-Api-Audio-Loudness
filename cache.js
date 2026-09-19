import { createClient } from 'redis'

const CACHE_PREFIX = 'meting:loudness:v3:'

export const createCacheKey = (songId) => `${CACHE_PREFIX}${String(songId || '').trim()}`

export const createLoudnessCache = (store, ttlSeconds = Number(process.env.CACHE_TTL_SECONDS || 2592000)) => ({
    async get(songId) {
        if (!songId) return null
        const value = await store.get(createCacheKey(songId))
        if (!value) return null
        try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return null }
    },
    async set(songId, value) {
        if (!songId) return
        const serialized = JSON.stringify(value)
        if (store.setEx) await store.setEx(createCacheKey(songId), ttlSeconds, serialized)
        else await store.set(createCacheKey(songId), serialized)
    },
})

export const createRedisCache = (url = process.env.REDIS_URL || 'redis://127.0.0.1:6379') => {
    const client = createClient({ url })
    let connection
    const ensureConnected = async () => {
        if (!connection) connection = client.connect()
        await connection
    }
    return createLoudnessCache({
        async get(key) { await ensureConnected(); return client.get(key) },
        async setEx(key, ttl, value) { await ensureConnected(); return client.setEx(key, ttl, value) },
    })
}

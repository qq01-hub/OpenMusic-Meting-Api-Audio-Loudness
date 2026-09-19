import { createClient } from 'redis'
import { randomUUID } from 'node:crypto'

const CACHE_PREFIX = 'meting:loudness:v3:'
const LOCK_PREFIX = `${CACHE_PREFIX}lock:`

const withTimeout = (operation, timeoutMs) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation
    let timer
    return Promise.race([
        Promise.resolve(operation),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('cache operation timed out'), { code: 'CACHE_TIMEOUT' })), timeoutMs)
        }),
    ]).finally(() => clearTimeout(timer))
}

export const createCacheKey = (songId) => `${CACHE_PREFIX}${String(songId || '').trim()}`

export const createLoudnessCache = (store, ttlSeconds = Number(process.env.CACHE_TTL_SECONDS || 2592000), { operationTimeoutMs = Number(process.env.CACHE_OPERATION_TIMEOUT_MS || 500) } = {}) => {
    const cache = {
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
        async withLock(songId, task, { ttlMs = 45_000, waitMs = 30_000 } = {}) {
            if (!store.setNx) return task()
            const lockKey = `${LOCK_PREFIX}${String(songId || '').trim()}`
            const token = randomUUID()
            const deadline = Date.now() + waitMs
            while (Date.now() < deadline) {
                let cached
                try { cached = await withTimeout(cache.get(songId), operationTimeoutMs) } catch { return task() }
                if (cached?.loudness) return { ...cached, source: 'cache', cacheHit: true }
                let acquired
                try { acquired = await withTimeout(store.setNx(lockKey, token, ttlMs), operationTimeoutMs) } catch { return task() }
                if (acquired) {
                    try { return await task() } finally { try { await withTimeout(store.del?.(lockKey), operationTimeoutMs) } catch {} }
                }
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
            throw Object.assign(new Error('distributed analysis lock timed out'), { code: 'CACHE_LOCK_TIMEOUT' })
        },
    }
    return cache
}

export const createRedisCache = (url = process.env.REDIS_URL || 'redis://127.0.0.1:6379', client = createClient({ url })) => {
    client.on?.('error', () => {})
    let connection
    const ensureConnected = async () => {
        if (!connection) {
            connection = client.connect().catch((error) => {
                connection = undefined
                throw error
            })
        }
        await connection
    }
    return createLoudnessCache({
        async get(key) { await ensureConnected(); return client.get(key) },
        async setEx(key, ttl, value) { await ensureConnected(); return client.setEx(key, ttl, value) },
        async setNx(key, value, ttlMs) { await ensureConnected(); return client.set(key, value, { NX: true, PX: ttlMs }) },
        async del(key) { await ensureConnected(); return client.del(key) },
    })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBuffer, createApp } from './server.js'

const makeWav16Mono = (samples, sampleRate = 8000) => {
    const dataSize = samples.length * 2
    const buffer = Buffer.alloc(44 + dataSize)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    samples.forEach((sample, index) => buffer.writeInt16LE(Math.round(sample * 32768), 44 + index * 2))
    return buffer
}

test('returns the shared gain and peak shape for an audio URL', async () => {
    const wav = makeWav16Mono([0.5, -0.5, 0.5, -0.5])
    assert.deepEqual(await analyzeBuffer(wav, 'audio/wav'), {
            loudness: { gain: -6.0206, peak: 0.5 },
            duration: 0.0005,
            decoder: 'wav',
    })
})

test('rejects an absent URL without downloading anything', async () => {
        const response = await createApp().request('/analyze')

        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { error: 'url is required' })
})

test('returns the cached result for a repeated song id', async () => {
    const values = new Map()
    const cache = {
        async get(id) { return values.get(id) || null },
        async set(id, value) { values.set(id, value) },
    }
    const wav = makeWav16Mono([0.25, -0.25])
    const url = 'https://cdn.example.com/audio/song-1.wav'
    const app = createApp({ cache })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } })
    try {
        const first = await app.request(`/analyze?id=song-1&url=${encodeURIComponent(url)}`)
        assert.equal(first.status, 200)
        const second = await app.request(`/analyze?id=song-1&url=${encodeURIComponent(url)}`)

        assert.equal(second.status, 200)
        assert.equal((await second.json()).cacheHit, true)
    } finally { globalThis.fetch = originalFetch }
})

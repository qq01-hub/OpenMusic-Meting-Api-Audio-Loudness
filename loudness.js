const round4 = (value) => Math.round(value * 10000) / 10000

export const analyzePcm = (samples) => {
    let sumSquares = 0
    let count = 0
    let peak = 0
    for (const sampleValue of samples) {
        const sample = Number(sampleValue)
        if (!Number.isFinite(sample)) continue
        const absolute = Math.abs(sample)
        if (absolute > peak) peak = absolute
        sumSquares += sample * sample
        count += 1
    }
    if (!count) return undefined
    const rms = Math.sqrt(sumSquares / count)
    return {
        gain: rms > 0 ? round4(20 * Math.log10(rms)) : -120,
        peak: round4(peak),
    }
}

export const createPcmAccumulator = () => {
    let sumSquares = 0
    let count = 0
    let peak = 0

    return {
        add(samples) {
            for (const sampleValue of samples) {
                const sample = Number(sampleValue)
                if (!Number.isFinite(sample)) continue
                const absolute = Math.abs(sample)
                if (absolute > peak) peak = absolute
                sumSquares += sample * sample
                count += 1
            }
        },
        result() {
            if (!count) return undefined
            const rms = Math.sqrt(sumSquares / count)
            return { gain: rms > 0 ? round4(20 * Math.log10(rms)) : -120, peak: round4(peak) }
        },
    }
}

export const decodeWav = (buffer) => {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return undefined
    let offset = 12
    let format
    let data
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const end = Math.min(buffer.length, offset + 8 + size)
        if (id === 'fmt ' && end - offset >= 24) {
            format = { audioFormat: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10), bits: buffer.readUInt16LE(offset + 22), rate: buffer.readUInt32LE(offset + 12) }
        } else if (id === 'data') data = buffer.subarray(offset + 8, end)
        offset += 8 + size + (size & 1)
    }
    if (!format || !data || format.audioFormat !== 1 || !format.channels || ![8, 16, 24, 32].includes(format.bits)) return undefined
    const bytesPerSample = format.bits / 8
    const frameBytes = bytesPerSample * format.channels
    const frameCount = Math.floor(data.length / frameBytes)
    const samples = new Float32Array(frameCount * format.channels)
    for (let frame = 0; frame < frameCount; frame += 1) {
        for (let channel = 0; channel < format.channels; channel += 1) {
            const position = frame * frameBytes + channel * bytesPerSample
            let sample
            if (format.bits === 8) sample = (data[position] - 128) / 128
            else if (format.bits === 16) sample = data.readInt16LE(position) / 32768
            else if (format.bits === 24) {
                sample = data[position] | (data[position + 1] << 8) | (data[position + 2] << 16)
                if (sample & 0x800000) sample |= 0xff000000
                sample /= 8388608
            } else sample = data.readInt32LE(position) / 2147483648
            samples[frame * format.channels + channel] = sample
        }
    }
    return { samples, duration: format.rate ? frameCount / format.rate : undefined }
}

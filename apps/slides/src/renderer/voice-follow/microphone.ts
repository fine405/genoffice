/** Encode mono PCM captured at the AudioContext rate into a 16 kHz WAV. */
export function speechWav(samples: Float32Array, rate: number): Uint8Array {
  const length = Math.floor((samples.length * 16000) / rate)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const word = (offset: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  word(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  word(8, 'WAVE')
  word(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  word(36, 'data')
  view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const start = Math.floor((i * rate) / 16000),
      end = Math.max(start + 1, Math.floor(((i + 1) * rate) / 16000))
    let sum = 0
    for (let j = start; j < end; j++) sum += samples[j] ?? 0
    const value = Math.max(-1, Math.min(1, sum / (end - start)))
    view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true)
  }
  return new Uint8Array(buffer)
}

export async function startMicrophone(
  deviceId: string,
  onSegment: (wav: Uint8Array) => void,
  onError: (message: string) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
  let context: AudioContext
  try {
    context = new AudioContext()
    await context.resume()
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    throw e
  }
  const source = context.createMediaStreamSource(stream)
  // Bounded chunks only; no raw audio is persisted by the renderer.
  const processor = context.createScriptProcessor(4096, 1, 1)
  const mute = context.createGain()
  mute.gain.value = 0
  let frames: Float32Array[] = [],
    sampleCount = 0,
    silence = 0,
    speaking = false,
    stopped = false
  const flush = () => {
    if (speaking && sampleCount / context.sampleRate > 0.3) {
      const joined = new Float32Array(sampleCount)
      let offset = 0
      for (const frame of frames) {
        joined.set(frame, offset)
        offset += frame.length
      }
      onSegment(speechWav(joined, context.sampleRate))
    }
    frames = []
    sampleCount = 0
    silence = 0
    speaking = false
  }
  processor.onaudioprocess = (event) => {
    if (stopped) return
    const data = new Float32Array(event.inputBuffer.getChannelData(0))
    const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length)
    if (rms > 0.012) {
      speaking = true
      silence = 0
    } else silence += data.length / context.sampleRate
    frames.push(data)
    sampleCount += data.length
    if (!speaking && frames.length > 3) {
      sampleCount -= frames.shift()!.length
    }
    if (speaking && (silence > 0.65 || sampleCount / context.sampleRate >= 10)) flush()
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    processor.onaudioprocess = null
    source.disconnect()
    processor.disconnect()
    mute.disconnect()
    stream.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    void context.close()
    frames = []
  }
  stream.getAudioTracks().forEach((track) => {
    track.onended = () => {
      stop()
      onError('麦克风已断开。')
    }
  })
  source.connect(processor)
  processor.connect(mute)
  mute.connect(context.destination)
  return stop
}

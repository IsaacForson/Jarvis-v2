/** Wraps mono audio samples (-1 to 1) in a 16-bit WAV file, the format whisper.cpp reads. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset);
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // format chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per sample
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  });
  return bytes;
}

/** Changes the sample rate by straight-line interpolation. Good enough for speech going to whisper. */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const out = new Float32Array(Math.floor((samples.length * toRate) / fromRate));
  for (let index = 0; index < out.length; index++) {
    const position = (index * fromRate) / toRate;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    out[index] = samples[left]! + (samples[right]! - samples[left]!) * (position - left);
  }
  return out;
}

/** Reads a 16-bit mono WAV file (as macOS's `say` writes it) back into samples and their rate. */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let sampleRate = 0;
  // Chunks follow the 12-byte header: a name, a length, then that many bytes (padded to an even count).
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === 'fmt ') sampleRate = view.getUint32(offset + 12, true);
    if (tag(offset) === 'data') {
      const count = Math.floor(Math.min(size, bytes.length - offset - 8) / 2);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index++) samples[index] = view.getInt16(offset + 8 + index * 2, true) / 32768;
      if (!sampleRate) break;
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('The WAV file holds no sound');
}

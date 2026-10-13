/** Peak amplitude per bucket (0..1) for drawing a waveform. */
export function computePeaks(samples: Float32Array, buckets: number): number[] {
  if (samples.length === 0 || buckets <= 0) return [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    const end = Math.min(samples.length, start + size);
    for (let i = start; i < end; i++) max = Math.max(max, Math.abs(samples[i] ?? 0));
    peaks.push(max);
  }
  const top = Math.max(...peaks, 0.01);
  return peaks.map((p) => p / top);
}

/** Decodes audio from a URL and returns `buckets` normalized peaks. */
export async function loadPeaks(src: string, buckets: number): Promise<number[]> {
  const response = await fetch(src);
  const data = await response.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(data);
    return computePeaks(audio.getChannelData(0), buckets);
  } finally {
    void ctx.close();
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

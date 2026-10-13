import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { formatDuration, loadPeaks } from './waveform';

const BARS = 48;
const SPEEDS = [1, 1.5, 2] as const;

/** Voice message playback with waveform, click-to-seek and speed control. */
export function VoicePlayer({ src, durationMs }: { src: string; durationMs: number | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState((durationMs ?? 0) / 1000);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPeaks(src, BARS).then(
      (p) => {
        if (!cancelled) setPeaks(p);
      },
      () => {
        if (!cancelled) setPeaks(new Array<number>(BARS).fill(0.3));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  const toggle = async () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      try {
        await el.play();
      } catch {
        setError('This recording can’t be played on this computer.');
      }
    } else {
      el.pause();
    }
  };

  const progress = duration > 0 ? position / duration : 0;
  return (
    <div className="voice" data-testid="voice-player">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
        onError={() => setError('This recording can’t be played on this computer.')}
      />
      <Button
        size="sm"
        variant="primary"
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={() => void toggle()}
      >
        {playing ? '❚❚' : '▶'}
      </Button>
      <div
        className="voice__wave"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${formatDuration(position * 1000)} of ${formatDuration(duration * 1000)}`}
        onClick={(e) => {
          const el = audio.current;
          if (!el || duration <= 0) return;
          const rect = e.currentTarget.getBoundingClientRect();
          el.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
        }}
        onKeyDown={(e) => {
          const el = audio.current;
          if (!el) return;
          if (e.key === 'ArrowRight') el.currentTime = Math.min(duration, el.currentTime + 5);
          if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5);
        }}
      >
        {(peaks ?? new Array<number>(BARS).fill(0.15)).map((p, i) => (
          <span
            key={i}
            className={`voice__bar ${i / BARS < progress ? 'voice__bar--played' : ''}`}
            style={{ height: `${Math.max(8, p * 100)}%` }}
          />
        ))}
      </div>
      <span className="voice__time">
        {formatDuration((playing || position > 0 ? position : duration) * 1000)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Playback speed ${speed}x`}
        onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1)}
      >
        {speed}×
      </Button>
      {error && <span className="field__error">{error}</span>}
    </div>
  );
}

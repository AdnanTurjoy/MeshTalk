import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { VoicePlayer } from './VoicePlayer';
import { formatDuration } from './waveform';

const MAX_MS = 10 * 60 * 1000;
const MIME = 'audio/webm;codecs=opus';

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'preview'; blob: Blob; url: string; durationMs: number };

interface VoiceRecorderProps {
  onSend(data: Uint8Array, durationMs: number): Promise<boolean>;
  disabled?: boolean;
}

/**
 * Record → preview → send/delete. The microphone is opened only when the user
 * presses Record and released as soon as recording stops.
 */
export function VoiceRecorder({ onSend, disabled }: VoiceRecorderProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audioCtx.current?.close();
    audioCtx.current = null;
  };

  useEffect(
    () => () => {
      release();
      if (phase.kind === 'preview') URL.revokeObjectURL(phase.url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
    [],
  );

  const start = async () => {
    setError(null);
    if (!MediaRecorder.isTypeSupported(MIME)) {
      setError('Voice recording isn’t supported on this system.');
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const name = (e as Error).name;
      setError(
        name === 'NotAllowedError'
          ? 'MeshTalk isn’t allowed to use the microphone. Allow it in your system privacy settings.'
          : name === 'NotFoundError'
            ? 'No microphone was found.'
            : 'The microphone could not be started.',
      );
      return;
    }
    stream.current = media;
    chunks.current = [];
    const rec = new MediaRecorder(media, { mimeType: MIME, audioBitsPerSecond: 32_000 });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    const startedAt = Date.now();
    rec.onstop = () => {
      const durationMs = Date.now() - startedAt;
      release();
      const blob = new Blob(chunks.current, { type: 'audio/webm' });
      setPhase({ kind: 'preview', blob, url: URL.createObjectURL(blob), durationMs });
    };
    rec.start(250);
    recorder.current = rec;

    // Live input level, so the user can see the microphone is working.
    const ctx = new AudioContext();
    audioCtx.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(media).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    timer.current = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      setLevel(peak);
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      if (ms >= MAX_MS) rec.stop();
    }, 100);
    setElapsed(0);
    setPhase({ kind: 'recording', startedAt });
  };

  const stop = () => recorder.current?.stop();

  const discard = () => {
    if (phase.kind === 'preview') URL.revokeObjectURL(phase.url);
    setPhase({ kind: 'idle' });
  };

  const send = async () => {
    if (phase.kind !== 'preview') return;
    setSending(true);
    const ok = await onSend(new Uint8Array(await phase.blob.arrayBuffer()), phase.durationMs);
    setSending(false);
    if (ok) discard();
  };

  if (phase.kind === 'recording') {
    return (
      <div className="recorder" role="group" aria-label="Recording voice message">
        <span className="recorder__dot" aria-hidden="true" />
        <span className="recorder__time" aria-live="off">
          {formatDuration(elapsed)}
        </span>
        <span className="recorder__level" aria-hidden="true">
          <span style={{ width: `${Math.min(100, level * 140)}%` }} />
        </span>
        <span className="visually-hidden" role="status">
          Recording. The microphone is on.
        </span>
        <Button size="sm" variant="primary" onClick={stop}>
          Stop
        </Button>
      </div>
    );
  }

  if (phase.kind === 'preview') {
    return (
      <div className="recorder" role="group" aria-label="Voice message preview">
        <VoicePlayer src={phase.url} durationMs={phase.durationMs} />
        <Button size="sm" variant="danger" onClick={discard} disabled={sending}>
          Delete
        </Button>
        <Button size="sm" variant="primary" onClick={() => void send()} loading={sending}>
          Send
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        aria-label="Record voice message"
        title="Record voice message"
        disabled={disabled}
        onClick={() => void start()}
      >
        🎤
      </Button>
      {error && (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

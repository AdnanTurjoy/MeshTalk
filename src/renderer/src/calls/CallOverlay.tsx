import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { formatDuration } from '../media/waveform';
import { calls, endReasonText, useCall, type CallState } from './call-controller';

/** Incoming-call prompt and in-call view. Rendered once at the app root. */
export function CallOverlay() {
  const state = useCall();
  if (state.phase === 'idle') return null;
  if (state.phase === 'incoming') return <IncomingCall state={state} />;
  return <ActiveCall state={state} />;
}

function IncomingCall({ state }: { state: CallState }) {
  return (
    <div
      className="call-incoming"
      role="alertdialog"
      aria-labelledby="incoming-title"
      aria-describedby="incoming-desc"
    >
      <Avatar name={state.peerName} size={56} />
      <div className="list-item__main">
        <strong id="incoming-title">{state.peerName}</strong>
        <span id="incoming-desc" className="muted">
          Incoming {state.kind === 'video' ? 'video' : 'audio'} call
        </span>
      </div>
      <Button variant="danger" onClick={() => void calls.decline()}>
        Decline
      </Button>
      <Button variant="primary" autoFocus onClick={() => void calls.accept()}>
        Answer
      </Button>
    </div>
  );
}

function ActiveCall({ state }: { state: CallState }) {
  const [now, setNow] = useState(() => Date.now());
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (remoteVideo.current) remoteVideo.current.srcObject = state.remoteStream;
    if (remoteAudio.current) remoteAudio.current.srcObject = state.remoteStream;
  }, [state.remoteStream]);
  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = state.localStream;
  }, [state.localStream]);

  const hasRemoteVideo = (state.remoteStream?.getVideoTracks().length ?? 0) > 0;
  const status =
    state.phase === 'outgoing'
      ? 'Ringing…'
      : state.phase === 'connecting'
        ? 'Connecting…'
        : state.phase === 'reconnecting'
          ? 'Reconnecting…'
          : state.phase === 'ended'
            ? (state.error ?? endReasonText(state.endReason))
            : state.connectedAt
              ? formatDuration(now - state.connectedAt)
              : '';

  return (
    <div
      className="call"
      role="dialog"
      aria-label={`Call with ${state.peerName}`}
      data-testid="call-view"
    >
      <div className="call__stage">
        {state.kind === 'video' && hasRemoteVideo ? (
          <video ref={remoteVideo} className="call__remote" autoPlay playsInline />
        ) : (
          <div className="call__avatar">
            <Avatar name={state.peerName} size={96} />
          </div>
        )}
        {/* Audio is played separately so output-device selection applies to it. */}
        <audio ref={remoteAudio} autoPlay data-testid="remote-audio" />
        {state.kind === 'video' && state.localStream && (
          <video
            ref={localVideo}
            className={`call__local ${state.cameraOff ? 'call__local--off' : ''}`}
            autoPlay
            playsInline
            muted
          />
        )}
        <div className="call__header">
          <strong>{state.peerName}</strong>
          <span role="status" aria-live="polite" data-testid="call-status">
            {status}
          </span>
          {state.phase === 'connected' && state.quality && (
            <Badge
              tone={
                state.quality === 'good'
                  ? 'success'
                  : state.quality === 'fair'
                    ? 'warning'
                    : 'danger'
              }
            >
              {state.quality === 'good'
                ? 'Good connection'
                : state.quality === 'fair'
                  ? 'Fair connection'
                  : 'Poor connection'}
            </Badge>
          )}
          {state.relayed && <Badge tone="warning">Relayed through a server</Badge>}
          {state.phase === 'connected' && (
            <span className="call__stats">
              {state.stats.rttMs !== null && `${Math.round(state.stats.rttMs)} ms`}
              {state.stats.lossPct !== null && ` · ${state.stats.lossPct.toFixed(1)}% loss`}
            </span>
          )}
        </div>
      </div>

      {state.phase !== 'ended' && (
        <div className="call__controls" role="toolbar" aria-label="Call controls">
          <Button aria-pressed={state.muted} onClick={() => calls.toggleMute()}>
            {state.muted ? 'Unmute' : 'Mute'}
          </Button>
          {state.kind === 'video' && (
            <Button aria-pressed={state.cameraOff} onClick={() => calls.toggleCamera()}>
              {state.cameraOff ? 'Camera on' : 'Camera off'}
            </Button>
          )}
          <DevicePicker kind={state.kind} audio={remoteAudio} />
          <Button variant="danger" onClick={() => void calls.hangup()}>
            {state.phase === 'outgoing' ? 'Cancel' : 'End call'}
          </Button>
        </div>
      )}
    </div>
  );
}

function DevicePicker({
  kind,
  audio,
}: {
  kind: 'audio' | 'video';
  audio: React.RefObject<HTMLAudioElement | null>;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void navigator.mediaDevices.enumerateDevices().then((d) => {
      if (!cancelled) setDevices(d);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return <Button onClick={() => setOpen(true)}>Devices</Button>;
  const of = (k: MediaDeviceKind) => devices.filter((d) => d.kind === k);
  const canChooseOutput =
    typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
  return (
    <div className="call__devices">
      <label>
        Microphone
        <select className="input" onChange={(e) => void calls.switchInput('audio', e.target.value)}>
          {of('audioinput').map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Microphone'}
            </option>
          ))}
        </select>
      </label>
      {kind === 'video' && (
        <label>
          Camera
          <select
            className="input"
            onChange={(e) => void calls.switchInput('video', e.target.value)}
          >
            {of('videoinput').map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Camera'}
              </option>
            ))}
          </select>
        </label>
      )}
      {canChooseOutput && (
        <label>
          Speaker
          <select
            className="input"
            onChange={(e) =>
              void (
                audio.current as HTMLAudioElement & { setSinkId(id: string): Promise<void> }
              ).setSinkId(e.target.value)
            }
          >
            {of('audiooutput').map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Speaker'}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button size="sm" onClick={() => setOpen(false)}>
        Done
      </Button>
    </div>
  );
}

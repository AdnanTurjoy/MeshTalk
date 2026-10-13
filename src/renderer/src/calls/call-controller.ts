import { useSyncExternalStore } from 'react';
import type { CallEndReason, CallKind, CallSignal, IncomingCall } from '../../../shared/calls';
import { call } from '../lib/api';

export type CallPhase =
  'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type Quality = 'good' | 'fair' | 'poor';

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  peerName: string;
  conversationId: string | null;
  kind: CallKind;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  connectedAt: number | null;
  quality: Quality | null;
  stats: { rttMs: number | null; lossPct: number | null; kbps: number | null };
  relayed: boolean;
  endReason: CallEndReason | null;
  error: string | null;
}

const IDLE: CallState = {
  phase: 'idle',
  callId: null,
  peerName: '',
  conversationId: null,
  kind: 'audio',
  localStream: null,
  remoteStream: null,
  muted: false,
  cameraOff: false,
  connectedAt: null,
  quality: null,
  stats: { rttMs: null, lossPct: null, kbps: null },
  relayed: false,
  endReason: null,
  error: null,
};

/** LAN-only mode has no STUN/TURN: host candidates connect devices on the same network. */
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };
const MAX_ICE_RESTARTS = 3;
const DISCONNECT_GRACE_MS = 4000;

const END_TEXT: Record<CallEndReason, string> = {
  hangup: 'Call ended',
  declined: 'Call declined',
  busy: 'They are in another call',
  no_answer: 'No answer',
  cancelled: 'Call cancelled',
  connection_lost: 'Connection lost',
  unavailable: 'They are not reachable right now',
  error: 'The call failed',
};

export function endReasonText(reason: CallEndReason | null): string {
  return reason ? END_TEXT[reason] : '';
}

/**
 * One WebRTC call at a time. Signaling goes through main (PeerLink); media is
 * peer to peer and encrypted by DTLS-SRTP. Camera and microphone are opened
 * only by `startCall` / `accept`, i.e. by explicit user action, and released
 * when the call ends.
 */
class CallController {
  private state: CallState = IDLE;
  private listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private incomingOffer: string | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private endedTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private isCaller = false;
  private lastBytes: { at: number; bytes: number } | null = null;
  /** Caller side: ICE must not overtake the invite that carries the offer. */
  private offerSent: Promise<void> = Promise.resolve();

  constructor() {
    window.meshtalk.onEvent((event) => {
      if (event.type === 'call-incoming') this.onIncoming(event.call);
      if (event.type === 'call-signal' && event.callId === this.state.callId)
        void this.onSignal(event.signal);
      if (event.type === 'call-ended' && event.callId === this.state.callId)
        this.finish(event.reason);
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = () => this.state;

  private set(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  async startCall(conversationId: string, peerName: string, kind: CallKind): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') return;
    this.reset();
    this.set({ ...IDLE, phase: 'outgoing', conversationId, peerName, kind });
    let local: MediaStream;
    try {
      local = await openMedia(kind);
    } catch (error) {
      this.set({ phase: 'ended', error: (error as Error).message, endReason: 'error' });
      this.scheduleClear();
      return;
    }
    let callId: string;
    try {
      ({ callId } = await call('call:start', { conversationId, kind }));
    } catch (error) {
      stopStream(local);
      this.set({ phase: 'ended', error: (error as Error).message, endReason: 'error' });
      this.scheduleClear();
      return;
    }
    this.isCaller = true;
    this.set({ callId, localStream: local });
    const pc = this.createPeer(callId, local);
    let markSent = () => {};
    this.offerSent = new Promise((resolve) => (markSent = resolve));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.signal({ type: 'offer', sdp: offer.sdp ?? '', restart: false });
    markSent();
  }

  async accept(): Promise<void> {
    const { callId, kind, phase } = this.state;
    if (phase !== 'incoming' || !callId || !this.incomingOffer) return;
    this.set({ phase: 'connecting' });
    let local: MediaStream;
    try {
      local = await openMedia(kind);
    } catch (error) {
      this.set({ error: (error as Error).message });
      await call('call:end', { callId, reason: 'error' }).catch(() => undefined);
      this.finish('error');
      return;
    }
    this.isCaller = false;
    this.set({ localStream: local });
    const pc = this.createPeer(callId, local);
    await pc.setRemoteDescription({ type: 'offer', sdp: this.incomingOffer });
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.signal({ type: 'answer', sdp: answer.sdp ?? '' });
  }

  async decline(): Promise<void> {
    if (this.state.callId)
      await call('call:end', { callId: this.state.callId, reason: 'declined' }).catch(
        () => undefined,
      );
    this.finish('declined');
  }

  async hangup(): Promise<void> {
    const { callId, phase } = this.state;
    if (callId) {
      const reason: CallEndReason = phase === 'outgoing' ? 'cancelled' : 'hangup';
      await call('call:end', { callId, reason }).catch(() => undefined);
      this.finish(reason);
    } else {
      this.finish('cancelled');
    }
  }

  toggleMute(): void {
    const muted = !this.state.muted;
    this.state.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
  }

  toggleCamera(): void {
    const cameraOff = !this.state.cameraOff;
    this.state.localStream?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    this.set({ cameraOff });
  }

  /** Switches microphone or camera mid-call without renegotiation. */
  async switchInput(kind: 'audio' | 'video', deviceId: string): Promise<void> {
    const pc = this.pc;
    const local = this.state.localStream;
    if (!pc || !local) return;
    const fresh = await navigator.mediaDevices.getUserMedia(
      kind === 'audio'
        ? { audio: { deviceId: { exact: deviceId } } }
        : { video: { deviceId: { exact: deviceId } } },
    );
    const track = (kind === 'audio' ? fresh.getAudioTracks() : fresh.getVideoTracks())[0];
    if (!track) return;
    track.enabled = kind === 'audio' ? !this.state.muted : !this.state.cameraOff;
    const sender = pc.getSenders().find((s) => s.track?.kind === kind);
    await sender?.replaceTrack(track);
    const old = kind === 'audio' ? local.getAudioTracks() : local.getVideoTracks();
    old.forEach((t) => {
      t.stop();
      local.removeTrack(t);
    });
    local.addTrack(track);
    this.set({ localStream: new MediaStream(local.getTracks()) });
  }

  clearEnded(): void {
    if (this.state.phase === 'ended') this.set(IDLE);
  }

  private onIncoming(incoming: IncomingCall): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') return; // main already answered busy
    this.reset();
    this.incomingOffer = incoming.offerSdp;
    this.set({
      ...IDLE,
      phase: 'incoming',
      callId: incoming.callId,
      peerName: incoming.peerName,
      conversationId: incoming.conversationId,
      kind: incoming.kind,
    });
  }

  private async onSignal(signal: CallSignal): Promise<void> {
    const pc = this.pc;
    if (signal.type === 'ice') {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
      };
      if (pc?.remoteDescription) await pc.addIceCandidate(candidate).catch(() => undefined);
      else this.pendingIce.push(candidate);
      return;
    }
    if (!pc) return;
    if (signal.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      // ICE may already have connected while the answer was being applied.
      if (this.state.phase === 'outgoing') this.set({ phase: 'connecting' });
      await this.flushIce();
      return;
    }
    if (signal.type === 'offer' && signal.restart) {
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.signal({ type: 'answer', sdp: answer.sdp ?? '' });
    }
  }

  private createPeer(callId: string, local: MediaStream): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    for (const track of local.getTracks()) pc.addTrack(track, local);
    const remote = new MediaStream();
    this.set({ remoteStream: remote });
    pc.ontrack = (e) => {
      remote.addTrack(e.track);
      this.set({ remoteStream: new MediaStream(remote.getTracks()) });
    };
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c) return;
      void this.offerSent.then(() =>
        this.signal({
          type: 'ice',
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        }),
      );
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        this.restarts = 0;
        this.set({ phase: 'connected', connectedAt: this.state.connectedAt ?? Date.now() });
        void this.reportRelay(callId);
        this.startStats();
      } else if (s === 'disconnected') {
        this.set({ phase: 'reconnecting' });
        this.disconnectTimer ??= setTimeout(() => void this.restartIce(), DISCONNECT_GRACE_MS);
      } else if (s === 'failed') {
        void this.restartIce();
      }
    };
    return pc;
  }

  /** The caller drives ICE restarts; the callee answers them. */
  private async restartIce(): Promise<void> {
    this.disconnectTimer = null;
    const pc = this.pc;
    if (!pc || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
      return;
    if (this.restarts >= MAX_ICE_RESTARTS) {
      if (this.state.callId)
        await call('call:end', { callId: this.state.callId, reason: 'connection_lost' }).catch(
          () => undefined,
        );
      this.finish('connection_lost');
      return;
    }
    this.restarts++;
    if (!this.isCaller) return;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await this.signal({ type: 'offer', sdp: offer.sdp ?? '', restart: true });
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
  }

  private async signal(signal: CallSignal): Promise<void> {
    if (!this.state.callId) return;
    try {
      await call('call:signal', { callId: this.state.callId, signal });
    } catch {
      this.finish('unavailable');
    }
  }

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => void this.sampleStats(), 2000);
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const report = await pc.getStats();
    let rtt: number | null = null;
    let lost = 0;
    let received = 0;
    let bytes = 0;
    report.forEach((s: RTCStats & Record<string, unknown>) => {
      if (
        s.type === 'candidate-pair' &&
        s.nominated &&
        typeof s.currentRoundTripTime === 'number'
      ) {
        rtt = s.currentRoundTripTime * 1000;
      }
      if (s.type === 'inbound-rtp') {
        lost += Number(s.packetsLost ?? 0);
        received += Number(s.packetsReceived ?? 0);
        bytes += Number(s.bytesReceived ?? 0);
      }
    });
    const now = Date.now();
    const kbps =
      this.lastBytes && now > this.lastBytes.at
        ? ((bytes - this.lastBytes.bytes) * 8) / (now - this.lastBytes.at)
        : null;
    this.lastBytes = { at: now, bytes };
    const lossPct = received + lost > 0 ? (lost / (received + lost)) * 100 : null;
    const r = rtt as number | null;
    const quality: Quality =
      (r !== null && r > 400) || (lossPct ?? 0) > 8
        ? 'poor'
        : (r !== null && r > 150) || (lossPct ?? 0) > 2
          ? 'fair'
          : 'good';
    this.set({ stats: { rttMs: r, lossPct, kbps }, quality });
  }

  private async reportRelay(callId: string): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const report = await pc.getStats();
    let relayed = false;
    const candidates = new Map<string, string>();
    report.forEach((s: RTCStats & Record<string, unknown>) => {
      if (s.type === 'local-candidate' || s.type === 'remote-candidate')
        candidates.set(s.id, String(s.candidateType));
    });
    report.forEach((s: RTCStats & Record<string, unknown>) => {
      if (s.type === 'candidate-pair' && s.nominated) {
        relayed ||=
          candidates.get(String(s.localCandidateId)) === 'relay' ||
          candidates.get(String(s.remoteCandidateId)) === 'relay';
      }
    });
    this.set({ relayed });
    await call('call:connected', { callId, relayed }).catch(() => undefined);
  }

  private finish(reason: CallEndReason): void {
    if (this.state.phase === 'idle') return;
    this.teardown();
    this.set({ phase: 'ended', endReason: reason, localStream: null, remoteStream: null });
    this.scheduleClear();
  }

  private scheduleClear(): void {
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = setTimeout(() => this.clearEnded(), 3500);
  }

  private teardown(): void {
    stopStream(this.state.localStream);
    this.pc?.close();
    this.pc = null;
    this.pendingIce = [];
    this.incomingOffer = null;
    this.lastBytes = null;
    this.offerSent = Promise.resolve();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private reset(): void {
    this.teardown();
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = null;
    this.restarts = 0;
  }
}

async function openMedia(kind: CallKind): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Calls are not supported on this system.');
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.kind === 'audioinput')) throw new Error('No microphone was found.');
  if (kind === 'video' && !devices.some((d) => d.kind === 'videoinput')) {
    throw new Error('No camera was found. Try an audio call instead.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'NotAllowedError') {
      throw new Error(
        'MeshTalk isn’t allowed to use the camera or microphone. Allow it in your system privacy settings.',
      );
    }
    if (name === 'NotReadableError')
      throw new Error('The camera or microphone is being used by another app.');
    throw new Error('The camera or microphone could not be started.');
  }
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export const calls = new CallController();

export function useCall(): CallState {
  return useSyncExternalStore(calls.subscribe, calls.get);
}

import type { CallEndReason, CallSignal, IncomingCall } from './calls';
import type { TransferProgress } from './files';
import type { Screen } from './ipc';

/** Main → renderer notifications. Payloads are hints; the renderer refetches. */
export type AppEvent =
  | { type: 'navigate'; screen: Screen }
  | { type: 'account-changed' }
  | { type: 'contacts-changed' }
  | { type: 'nearby-changed' }
  | { type: 'network-changed' }
  | { type: 'conversations-changed' }
  | { type: 'messages-changed'; conversationId: string }
  | { type: 'typing'; conversationId: string; deviceId: string; on: boolean }
  | { type: 'transfer-progress'; progress: TransferProgress }
  | { type: 'files-changed' }
  | { type: 'call-incoming'; call: IncomingCall }
  | { type: 'call-signal'; callId: string; signal: CallSignal }
  | { type: 'call-ended'; callId: string; reason: CallEndReason }
  | { type: 'calls-changed' }
  | { type: 'groups-changed' }
  | { type: 'skills-changed' }
  | { type: 'lock-changed' };

export type AppEventType = AppEvent['type'];

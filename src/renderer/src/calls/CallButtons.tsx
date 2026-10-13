import type { ConversationSummary } from '../../../shared/chat';
import { Button } from '../components/Button';
import { calls, useCall } from './call-controller';

/** Audio/video call buttons for a conversation header. */
export function CallButtons({ conversation: c }: { conversation: ConversationSummary }) {
  const state = useCall();
  if (c.kind !== 'direct') return null;
  const busy = state.phase !== 'idle' && state.phase !== 'ended';
  const reason =
    c.cannotSendReason ??
    (busy ? 'You are already in a call.' : !c.online ? `${c.title} is offline.` : null);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={reason !== null}
        title={reason ?? 'Audio call'}
        aria-label="Start audio call"
        onClick={() => void calls.startCall(c.id, c.title, 'audio')}
      >
        📞
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={reason !== null}
        title={reason ?? 'Video call'}
        aria-label="Start video call"
        onClick={() => void calls.startCall(c.id, c.title, 'video')}
      >
        🎥
      </Button>
    </>
  );
}

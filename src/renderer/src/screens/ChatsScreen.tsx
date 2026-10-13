import { useCallback, useState } from 'react';
import type { ConversationSummary } from '../../../shared/chat';
import { ConversationList } from '../chat/ConversationList';
import { ConversationView } from '../chat/ConversationView';

interface ChatsScreenProps {
  conversationId: string | null;
  onSelect(conversationId: string | null): void;
  headerExtras?(conversation: ConversationSummary): React.ReactNode;
}

export function ChatsScreen({ conversationId, onSelect, headerExtras }: ChatsScreenProps) {
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const clearJump = useCallback(() => setJumpTo(null), []);

  return (
    <div className="chats">
      <ConversationList
        selectedId={conversationId}
        onSelect={(id, messageId) => {
          onSelect(id);
          setJumpTo(messageId ?? null);
        }}
      />
      {conversationId ? (
        <ConversationView
          key={conversationId}
          conversationId={conversationId}
          jumpToMessageId={jumpTo}
          onJumped={clearJump}
          {...(headerExtras ? { headerExtras } : {})}
        />
      ) : (
        <section className="conv-view conv-view--empty">
          <p className="muted">Choose a conversation, or start one from People.</p>
        </section>
      )}
    </div>
  );
}

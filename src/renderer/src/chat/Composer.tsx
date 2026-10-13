import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MESSAGE_MAX_CHARS, type ChatMessage } from '../../../shared/chat';
import { Button } from '../components/Button';

const TYPING_THROTTLE_MS = 3000;
const DRAFT_SAVE_MS = 400;

interface ComposerProps {
  conversationId: string;
  initialDraft: string;
  disabledReason: string | null;
  replyTo: ChatMessage | null;
  editing: ChatMessage | null;
  onCancelReply(): void;
  onCancelEdit(): void;
  onSend(body: string): Promise<boolean>;
  onEdit(message: ChatMessage, body: string): Promise<boolean>;
  onDraft(draft: string): void;
  onTyping(): void;
  extraActions?: ReactNode;
  onPasteFiles?(files: File[]): void;
}

export function Composer({
  conversationId,
  initialDraft,
  disabledReason,
  replyTo,
  editing,
  onCancelReply,
  onCancelEdit,
  onSend,
  onEdit,
  onDraft,
  onTyping,
  extraActions,
  onPasteFiles,
}: ComposerProps) {
  const [text, setText] = useState(initialDraft);
  const [sending, setSending] = useState(false);
  const lastTyping = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const savedDraft = useRef(initialDraft);

  // Switching to edit mode loads the message; leaving it restores the draft.
  useEffect(() => {
    setText(editing ? editing.body : savedDraft.current);
    inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );

  const change = (value: string) => {
    setText(value);
    if (editing) return;
    savedDraft.current = value;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraft(value), DRAFT_SAVE_MS);
    const now = Date.now();
    if (value && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      onTyping();
    }
  };

  const submit = async () => {
    const body = text;
    if (!body.trim() || sending) return;
    setSending(true);
    const ok = editing ? await onEdit(editing, body) : await onSend(body);
    setSending(false);
    if (ok) {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      savedDraft.current = '';
      setText('');
      if (!editing) onDraft('');
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape') {
      if (editing) onCancelEdit();
      else if (replyTo) onCancelReply();
    }
  };

  if (disabledReason) {
    return (
      <div className="composer composer--disabled" role="status">
        {disabledReason}
      </div>
    );
  }

  const over = text.length > MESSAGE_MAX_CHARS;
  return (
    <div className="composer">
      {(replyTo || editing) && (
        <div className="composer__context">
          <span>
            {editing ? (
              <strong>Editing message</strong>
            ) : (
              <>
                Replying to <strong>{replyTo?.fromMe ? 'yourself' : replyTo?.senderName}</strong>:{' '}
                {replyTo?.body.slice(0, 80)}
              </>
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={editing ? onCancelEdit : onCancelReply}>
            Cancel
          </Button>
        </div>
      )}
      <div className="composer__row">
        {extraActions}
        <textarea
          ref={inputRef}
          key={conversationId}
          className="textarea composer__input"
          rows={1}
          placeholder="Write a message"
          aria-label="Message"
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length && onPasteFiles && !editing) {
              e.preventDefault();
              onPasteFiles(pasted);
            }
          }}
        />
        <Button
          variant="primary"
          onClick={() => void submit()}
          loading={sending}
          disabled={!text.trim() || over}
        >
          {editing ? 'Save' : 'Send'}
        </Button>
      </div>
      {over && (
        <p className="field__error" role="alert">
          Messages can be at most {MESSAGE_MAX_CHARS.toLocaleString()} characters (
          {text.length.toLocaleString()} now).
        </p>
      )}
      <p className="composer__hint">Enter to send · Shift+Enter for a new line</p>
    </div>
  );
}

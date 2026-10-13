import { useRef } from 'react';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { VoiceRecorder } from '../media/VoiceRecorder';

/** Sends files the user picked or dropped. In-memory files (pasted images) go as bytes. */
export function useSendFiles(conversationId: string) {
  const notify = useToast();
  return async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      try {
        const result = await window.meshtalk.sendFile(conversationId, file);
        if (result.ok) continue;
        // Not backed by a file on disk (e.g. pasted from the clipboard): send the bytes.
        if (result.error.code === 'invalid_request' && file.size > 0) {
          const data = new Uint8Array(await file.arrayBuffer());
          const name = file.name || `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          await call('files:send-bytes', {
            conversationId,
            name,
            mime: file.type,
            kind: 'file',
            durationMs: null,
            data,
          });
        } else {
          notify(result.error.message, 'error');
        }
      } catch (error) {
        notify(errorMessage(error), 'error');
      }
    }
  };
}

export function AttachControls({ conversationId }: { conversationId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const notify = useToast();
  const sendFiles = useSendFiles(conversationId);

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="file-input"
        onChange={(e) => {
          if (e.target.files) void sendFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        variant="ghost"
        aria-label="Attach files"
        title="Attach files"
        onClick={() => input.current?.click()}
      >
        📎
      </Button>
      <VoiceRecorder
        onSend={async (data, durationMs) => {
          try {
            await call('files:send-bytes', {
              conversationId,
              name: `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
              mime: 'audio/webm',
              kind: 'voice',
              durationMs,
              data,
            });
            return true;
          } catch (error) {
            notify(errorMessage(error), 'error');
            return false;
          }
        }}
      />
    </>
  );
}

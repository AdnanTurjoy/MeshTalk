import { useState } from 'react';
import type { ConversationSummary } from '../../../shared/chat';
import { Button } from '../components/Button';
import { GroupInfoDialog } from './GroupInfoDialog';

export function GroupHeaderButton({ conversation: c }: { conversation: ConversationSummary }) {
  const [open, setOpen] = useState(false);
  if (c.kind !== 'group') return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Group info
      </Button>
      <GroupInfoDialog groupId={c.id.slice(2)} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

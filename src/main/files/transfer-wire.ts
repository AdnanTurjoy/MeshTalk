import { z } from 'zod';

const fileId = z.string().uuid();

/** Control messages for moving file bytes. Chunks themselves are binary frames. */
export const transferMessages = [
  /** Receiver → sender: accept, or resume from a byte offset. */
  z.object({ t: z.literal('file_req'), fileId, offset: z.number().int().nonnegative() }),
  /** Receiver → sender: stop sending for now. */
  z.object({ t: z.literal('file_pause'), fileId }),
  z.object({ t: z.literal('file_decline'), fileId }),
  z.object({ t: z.literal('file_cancel'), fileId, reason: z.string().max(200) }),
  /** Receiver → sender: whole-file hash verified, transfer complete. */
  z.object({ t: z.literal('file_done'), fileId }),
  /** Sender → receiver: cannot send (file changed or missing). */
  z.object({ t: z.literal('file_error'), fileId, reason: z.string().max(200) }),
] as const;

export const chunkHeaderSchema = z
  .object({
    f: fileId,
    /** Byte offset of this chunk. */
    o: z.number().int().nonnegative(),
    /** SHA-256 of this chunk. */
    h: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileIdSchema } from '../../shared/files';

export const FILE_SCHEME = 'meshtalk-file';

/**
 * Serves complete, previewable files (raster images, audio, video) to the
 * renderer as `meshtalk-file://<fileId>`. Only IDs known to the database and
 * resolved by `lookup` can be read; there is no path in the URL. Supports
 * HTTP Range so media can seek.
 */
export async function handleFileRequest(
  request: Request,
  lookup: (fileId: string) => { path: string; mime: string } | null,
): Promise<Response> {
  const url = new URL(request.url);
  const id = fileIdSchema.safeParse(url.hostname);
  if (!id.success || request.method !== 'GET') return new Response(null, { status: 404 });
  const source = lookup(id.data);
  if (!source) return new Response(null, { status: 404 });

  let size: number;
  try {
    size = (await stat(source.path)).size;
  } catch {
    return new Response(null, { status: 404 });
  }
  const headers: Record<string, string> = {
    'Content-Type': source.mime,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'no-store',
  };

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const [start, end] = range ?? [0, size - 1];
  const body =
    size === 0
      ? null
      : (Readable.toWeb(
          createReadStream(source.path, { start, end }),
        ) as ReadableStream<Uint8Array>);
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Parses a single `bytes=a-b` range. Null = whole file. */
export function parseRange(
  header: string | null,
  size: number,
): [number, number] | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return [start, end];
}

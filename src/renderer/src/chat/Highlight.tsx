/** Renders an FTS snippet whose matches are wrapped in \u0001…\u0002, without using HTML. */
export function Highlight({ snippet }: { snippet: string }) {
  // The markers are control characters by design: they cannot appear in typed text.
  // eslint-disable-next-line no-control-regex
  const parts = snippet.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('\u0001') ? (
          <mark key={i}>{part.slice(1, -1)}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

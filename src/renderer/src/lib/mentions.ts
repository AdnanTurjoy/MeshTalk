/**
 * Finds `@Display Name` mentions of the given members in a message. Longer
 * names are matched first and consume their text, so "@Ann Lee" isn't also
 * read as "@Ann".
 */
export function findMentions(
  body: string,
  members: readonly { deviceId: string; displayName: string }[],
): string[] {
  const found = new Set<string>();
  const lower = body.toLocaleLowerCase();
  const consumed = new Array<boolean>(lower.length).fill(false);
  const byLength = [...members].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const m of byLength) {
    const needle = `@${m.displayName.toLocaleLowerCase()}`;
    let i = lower.indexOf(needle);
    while (i !== -1) {
      const end = i + needle.length;
      const after = lower[end];
      const boundary = after === undefined || !/[\p{L}\p{N}_]/u.test(after);
      if (boundary && !consumed[i]) {
        found.add(m.deviceId);
        consumed.fill(true, i, end);
      }
      i = lower.indexOf(needle, i + 1);
    }
  }
  return [...found];
}

/** Shows a device fingerprint in readable groups, selectable for copying. */
export function Fingerprint({ value, label }: { value: string; label?: string }) {
  return (
    <code
      className="fingerprint"
      aria-label={label ? `${label}: ${value.split('-').join(' ')}` : undefined}
    >
      {value}
    </code>
  );
}

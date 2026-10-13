import { initials } from '../lib/format';

export function Avatar({
  name,
  online,
  size = 36,
}: {
  name: string;
  online?: boolean;
  size?: number;
}) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials(name)}
      {online !== undefined && (
        <span className={`avatar__status ${online ? 'avatar__status--on' : ''}`} />
      )}
    </span>
  );
}

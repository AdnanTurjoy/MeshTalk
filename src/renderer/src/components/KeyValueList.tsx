import type { ReactNode } from 'react';

export function KeyValueList({ items }: { items: readonly [label: string, value: ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([label, value]) => (
        <div key={label} className="kv__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

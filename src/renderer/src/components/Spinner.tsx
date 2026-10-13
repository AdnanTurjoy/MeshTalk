export function Spinner({ label }: { label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="row">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

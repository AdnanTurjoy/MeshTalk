import { useId, type ReactNode } from 'react';

interface SwitchProps {
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}

/** A labelled on/off setting row. Uses a native checkbox with role="switch". */
export function Switch({ label, description, checked, disabled, onChange }: SwitchProps) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-row__text">
        <label htmlFor={id} className="switch-row__label">
          {label}
        </label>
        {description && (
          <p className="muted" id={`${id}-d`}>
            {description}
          </p>
        )}
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  actions?: ReactNode;
}

/** Modal built on the native <dialog>: focus trapping and Escape come for free. */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="dialog__body">
          <h2 id={titleId}>{title}</h2>
          {children}
          {actions && <div className="row dialog__actions">{actions}</div>}
        </div>
      )}
    </dialog>
  );
}

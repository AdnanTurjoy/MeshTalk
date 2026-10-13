import type { ReactNode } from 'react';

interface CardProps {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  labelledBy?: string;
}

export function Card({ title, description, actions, children, labelledBy }: CardProps) {
  const headingId = labelledBy ?? (title ? `card-${slug(title)}` : undefined);
  return (
    <section className="card" aria-labelledby={headingId}>
      {(title || actions) && (
        <div className="row row--between">
          <div className="card__header">
            {title && <h3 id={headingId}>{title}</h3>}
            {description && <p className="muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

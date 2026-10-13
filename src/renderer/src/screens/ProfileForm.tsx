import { useState, type FormEvent } from 'react';
import { accountInputSchema, type LocalAccount } from '../../../shared/peers';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { call, errorMessage } from '../lib/api';

interface ProfileFormProps {
  account: LocalAccount | null;
  submitLabel: string;
  onSaved(account: LocalAccount): void;
}

/** Display name + optional, explicitly unverified email label. */
export function ProfileForm({ account, submitLabel, onSaved }: ProfileFormProps) {
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [emailLabel, setEmailLabel] = useState(account?.emailLabel ?? '');
  const [errors, setErrors] = useState<{
    displayName?: string;
    emailLabel?: string;
    form?: string;
  }>({});
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = accountInputSchema.safeParse({ displayName, emailLabel });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'displayName' || field === 'emailLabel') next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      onSaved(await call('account:save', { displayName, emailLabel }));
    } catch (error) {
      setErrors({ form: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <TextField
        label="Your name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        autoComplete="name"
        maxLength={64}
        required
        error={errors.displayName ?? null}
        hint="Shown only to people you accept as contacts."
      />
      <TextField
        label="Email (optional)"
        type="email"
        value={emailLabel}
        onChange={(e) => setEmailLabel(e.target.value)}
        autoComplete="email"
        error={errors.emailLabel ?? null}
        hint="Not verified. Without an account server nobody checks that this address is yours, and someone else could use the same one."
      />
      {errors.form && (
        <p className="field__error" role="alert">
          {errors.form}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

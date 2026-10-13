const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class InvalidProfileError extends Error {
  constructor(readonly profile: string) {
    super(`Invalid profile "${profile}". Use 1-32 lowercase letters, digits or dashes.`);
    this.name = 'InvalidProfileError';
  }
}

/**
 * Resolves the optional isolated-profile name from `--profile=<name>` or
 * `MESHTALK_PROFILE`. The argument wins. The name becomes a directory, so it
 * is strictly validated.
 */
export function resolveProfile(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const arg = argv.find((a) => a.startsWith('--profile='));
  const raw = arg ? arg.slice('--profile='.length) : env.MESHTALK_PROFILE;
  if (raw === undefined || raw === '') return null;
  if (!PROFILE_PATTERN.test(raw)) throw new InvalidProfileError(raw);
  return raw;
}

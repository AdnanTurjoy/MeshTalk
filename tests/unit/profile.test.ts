import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appPaths, profileUserData } from '../../src/main/platform/paths';
import { InvalidProfileError, resolveProfile } from '../../src/main/platform/profile';

describe('resolveProfile', () => {
  it('returns null when no profile is given', () => {
    expect(resolveProfile(['electron', '.'], {})).toBeNull();
  });

  it('prefers the --profile argument over the environment', () => {
    expect(resolveProfile(['--profile=alice'], { MESHTALK_PROFILE: 'bob' })).toBe('alice');
    expect(resolveProfile([], { MESHTALK_PROFILE: 'bob' })).toBe('bob');
  });

  it.each(['../evil', 'a/b', 'UPPER', '', 'x'.repeat(33), '-leading', 'with space', 'c:'])(
    'rejects unsafe name %j',
    (name) => {
      if (name === '') {
        expect(resolveProfile([`--profile=${name}`], {})).toBeNull();
      } else {
        expect(() => resolveProfile([`--profile=${name}`], {})).toThrow(InvalidProfileError);
      }
    },
  );
});

describe('appPaths', () => {
  it('keeps every managed location inside userData', () => {
    const root = join('/', 'data', 'MeshTalk');
    const paths = appPaths(root);
    for (const p of [paths.database, paths.files, paths.logs])
      expect(p.startsWith(root)).toBe(true);
  });

  it('places profiles beside the default directory', () => {
    expect(profileUserData(join('/', 'appdata'), 'MeshTalk', 'alice')).toBe(
      join('/', 'appdata', 'MeshTalk-alice'),
    );
  });
});

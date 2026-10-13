import { describe, expect, it } from 'vitest';
import { findMentions } from '../../src/renderer/src/lib/mentions';

const members = [
  { deviceId: 'A', displayName: 'Ann' },
  { deviceId: 'B', displayName: 'Ann Lee' },
  { deviceId: 'C', displayName: 'Bo' },
];

describe('findMentions', () => {
  it('matches the longest name and respects word boundaries', () => {
    expect(findMentions('hi @Ann Lee!', members)).toEqual(['B']);
    expect(findMentions('@ann and @bo', members).sort()).toEqual(['A', 'C']);
    expect(findMentions('@Bob is not Bo', members)).toEqual([]);
    expect(findMentions('email ann@example.com', members)).toEqual([]);
  });
});

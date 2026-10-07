import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo (sign-in must never become an open redirect)', () => {
  it.each(['/', '/reports/upload', '/reports/upload?tab=1', '/a/b#frag'])('keeps the on-site path %s', (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it.each([
    ['an absolute URL', 'https://evil.example.com/phish'],
    ['a protocol-relative URL', '//evil.example.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a backslash trick', '/\\evil.example.com'],
    ['a backslash later in the path', '/a\\b'],
    ['a path with a CR/LF', '/ok\r\nSet-Cookie: x=1'],
    ['a path with a NUL', '/ok\u0000'],
    ['a relative path', 'reports/upload'],
    ['an empty string', ''],
    ['not a string', { returnTo: '/x' }],
    ['undefined', undefined],
    ['null', null],
  ])('replaces %s with the home page', (_name, value) => {
    expect(safeReturnTo(value)).toBe('/');
  });

  it.each(['/auth/callback', '/auth/callback?code=1', '/signin', '/signin?x=1', '/signed-out', '/signed-out/'])(
    'never returns to the sign-in plumbing itself (%s would loop)',
    (path) => {
      expect(safeReturnTo(path)).toBe('/');
    },
  );

  it('does not mistake look-alike paths for the plumbing', () => {
    expect(safeReturnTo('/signing-guide')).toBe('/signing-guide');
    expect(safeReturnTo('/authors')).toBe('/authors');
  });
});

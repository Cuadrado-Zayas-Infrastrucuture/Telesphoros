/** True if the text contains a control character (a CR/LF or NUL smuggled into a URL) or a backslash. */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || character === '\\') return true;
  }
  return false;
}

/**
 * Where to go after signing in. The value travels through the identity provider and comes back in the
 * URL state, so it is untrusted: only a path on THIS site is accepted. Anything else (an absolute
 * URL, a `//host` path, a `javascript:` URL) becomes the home page, so sign-in can never be turned
 * into an open redirect.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || hasUnsafeCharacter(value)) return '/';
  // The sign-in plumbing itself is never a destination (it would loop).
  if (/^\/(auth\/callback|signin|signed-out)(\/|\?|#|$)/.test(value)) return '/';
  return value;
}

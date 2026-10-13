import { type TokenIdentity, TokenVerifier } from './token-verifier';

/** Something that can make a person's membership match what a verified token claims. */
export interface MembershipMirror {
  mirror(tenantId: string, sub: string, roles: readonly string[]): void | Promise<void>;
}

/**
 * DEVELOPMENT AND TESTS ONLY. After the real verifier accepts a token, makes the person's membership row match the token's claims, so a
 * development server on the in-memory store (no operator command, no database) and the many tests that mint tokens keep working while
 * every request still goes through the real membership check.
 *
 * It is never wired to PostgreSQL by the application: production requires the PostgreSQL store, and AuthModule refuses it there. The tests
 * that prove membership authority run WITHOUT it (a test asserts the production wiring never contains it).
 */
export class MirrorTokenVerifier extends TokenVerifier {
  constructor(
    private readonly inner: TokenVerifier,
    private readonly sink: MembershipMirror,
  ) {
    super();
  }

  async verify(token: string): Promise<TokenIdentity> {
    const identity = await this.inner.verify(token);
    await this.sink.mirror(identity.tenantId, identity.sub, identity.roles);
    return identity;
  }
}

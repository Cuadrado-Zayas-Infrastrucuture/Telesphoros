/** The part of a Cognito trigger event this function reads. Cognito requires the event to be returned unchanged. */
export interface PostConfirmationEvent {
  triggerSource: string;
  userName?: string;
  request: { userAttributes: Record<string, string | undefined> };
  [key: string]: unknown;
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** The only trigger source that means "this person just reset a forgotten password". */
export const PASSWORD_RESET = 'PostConfirmation_ConfirmForgotPassword';

export function noticeText(when: Date): string {
  return [
    'Your Telesphoros password was changed.',
    '',
    `When: ${when.toISOString()} (UTC)`,
    '',
    'If you did this, no action is needed.',
    'If you did NOT do this, contact your administrator immediately.',
    '',
    'This message contains no links on purpose. Never sign in through a link in an email you did not expect.',
  ].join('\n');
}

/**
 * Cognito calls this after a user confirms a password reset (and after sign-up confirmation).
 *
 * It MUST NEVER throw: a failure here would fail the user's password reset. So every problem is
 * logged (without the address or any identifier) and the event is returned untouched.
 * The cost of that choice: a notification can be lost silently, so the log line below should
 * drive an alarm (Phase 10).
 */
export function createHandler(mailer: Mailer, now: () => Date = () => new Date()) {
  return async (event: PostConfirmationEvent): Promise<PostConfirmationEvent> => {
    if (event.triggerSource !== PASSWORD_RESET) return event;
    const email = event.request.userAttributes.email;
    if (!email) {
      console.error(JSON.stringify({ event: 'password_change_notice_skipped', reason: 'no email on the account' }));
      return event;
    }
    try {
      await mailer.send(email, 'Your Telesphoros password was changed', noticeText(now()));
    } catch (error) {
      console.error(JSON.stringify({ event: 'password_change_notice_failed', reason: error instanceof Error ? error.name : 'unknown' }));
    }
    return event;
  };
}

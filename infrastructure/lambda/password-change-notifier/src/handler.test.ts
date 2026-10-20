import { readFileSync } from 'node:fs';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler, type Mailer, noticeText, PASSWORD_RESET, type PostConfirmationEvent } from './handler';
import { SesMailer } from './index';

// null means "this account has no email" (undefined would just select the default).
const event = (triggerSource: string, email: string | null = 'owner@example.test'): PostConfirmationEvent => ({
  triggerSource,
  userName: 'a-user-id',
  request: { userAttributes: { ...(email ? { email } : {}), sub: 'a-user-id' } },
  response: {},
});
const recorder = () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = { send: async (to, subject, text) => void sent.push({ to, subject, text }) };
  return { sent, mailer };
};
afterEach(() => vi.restoreAllMocks());

describe('password change notifier', () => {
  it('emails the account owner after a password RESET, and returns the event unchanged (Cognito requires that)', async () => {
    const { sent, mailer } = recorder();
    const input = event(PASSWORD_RESET);
    const output = await createHandler(mailer, () => new Date('2026-10-08T12:00:00Z'))(input);
    expect(output).toBe(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'owner@example.test', subject: 'Your Telesphoros password was changed' });
    expect(sent[0]!.text).toContain('2026-10-08T12:00:00.000Z');
  });

  it.each(['PostConfirmation_ConfirmSignUp', 'PostConfirmation_Anything', 'PreSignUp_SignUp', ''])(
    'does nothing for trigger source %j',
    async (source) => {
      const { sent, mailer } = recorder();
      const input = event(source);
      expect(await createHandler(mailer)(input)).toBe(input);
      expect(sent).toEqual([]);
    },
  );

  it('does not send when the account has no email, but still returns the event', async () => {
    const { sent, mailer } = recorder();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const input = event(PASSWORD_RESET, null);
    expect(await createHandler(mailer)(input)).toBe(input);
    expect(sent).toEqual([]);
  });

  it('NEVER throws when sending fails: the reset must still succeed. It logs the reason without the address.', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: Mailer = { send: async () => { throw Object.assign(new Error('SES said no for owner@example.test'), { name: 'MessageRejected' }); } };
    const input = event(PASSWORD_RESET);
    await expect(createHandler(failing)(input)).resolves.toBe(input);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain('password_change_notice_failed');
    expect(line).toContain('MessageRejected');
    expect(line).not.toContain('owner@example.test'); // no address, no identifier in the log
    expect(line).not.toContain('a-user-id');
  });

  // A lost notice is silent for the user, so its log line is what raises the alarm (lambda.tf, password_notice_lost). This keeps the
  // filter's terms and the lines this handler really writes in agreement: rename either one and this fails.
  it('every line it writes when a notice is lost matches the alarm filter in lambda.tf', async () => {
    const tf = readFileSync(new URL('../../../terraform/lambda.tf', import.meta.url), 'utf8');
    const filter = /resource "aws_cloudwatch_log_metric_filter" "password_notice_lost" \{[\s\S]*?\n\}/.exec(tf)?.[0] ?? '';
    const pattern = (/pattern\s*=\s*"(.*)"\s*$/m.exec(filter)?.[1] ?? '').replace(/\\"/g, '"');
    const terms = [...pattern.matchAll(/\?"([^"]+)"/g)].map((m) => m[1]);
    expect(terms.length).toBeGreaterThan(0);

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: Mailer = { send: async () => { throw new Error('down'); } };
    await createHandler(failing)(event(PASSWORD_RESET));
    await createHandler(recorder().mailer)(event(PASSWORD_RESET, null));
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(terms.some((term) => line.includes(`"${term}"`)), line).toBe(true);
    // And no term is dead: each one is a line this handler can write.
    for (const term of terms) expect(lines.some((line) => line.includes(`"${term}"`)), term).toBe(true);
  });

  it('writes a notice with no links, no codes and no secrets', () => {
    const text = noticeText(new Date('2026-10-08T12:00:00Z'));
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/\b\d{6}\b/);
    expect(text).toMatch(/contact your administrator/i);
  });
});

describe('SesMailer', () => {
  it('builds exactly one plain-text SendEmail to the one recipient from the configured sender', async () => {
    const calls: SendEmailCommand[] = [];
    const client = { send: async (command: SendEmailCommand) => void calls.push(command) };
    await new SesMailer(client as never, 'no-reply@example.test').send('owner@example.test', 'Subject', 'Body');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({
      FromEmailAddress: 'no-reply@example.test',
      Destination: { ToAddresses: ['owner@example.test'] },
      Content: { Simple: { Subject: { Data: 'Subject', Charset: 'UTF-8' }, Body: { Text: { Data: 'Body', Charset: 'UTF-8' } } } },
    });
  });
});

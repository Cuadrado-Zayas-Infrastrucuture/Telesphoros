import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { createHandler, type Mailer, type PostConfirmationEvent } from './handler';

export class SesMailer implements Mailer {
  constructor(
    private readonly client: Pick<SESv2Client, 'send'>,
    private readonly from: string,
  ) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
      }),
    );
  }
}

const from = process.env.FROM_ADDRESS;

/**
 * Missing configuration must not break password resets either, so it degrades to "no email" and says so in the log.
 */
export const handler = from
  ? createHandler(new SesMailer(new SESv2Client({}), from))
  : async (event: PostConfirmationEvent) => {
      console.error(JSON.stringify({ event: 'password_change_notice_skipped', reason: 'FROM_ADDRESS is not configured' }));
      return event;
    };

import type { Env } from './types';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export const mailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY && env.MAIL_FROM && env.APP_URL);

/**
 * Sends a plain-text email through Resend. Never throws: a mail problem must not stop an invitation
 * from being created, because the owner can always share the link by hand.
 */
export async function sendMail(env: Env, fetchFn: typeof fetch, mail: Mail): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

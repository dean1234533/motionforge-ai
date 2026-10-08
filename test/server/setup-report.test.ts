import { describe, expect, it } from 'vitest';
import { makeApp } from './harness';

describe('setup report', () => {
  it('says which settings the server can see, as yes/no only', async () => {
    const bare = makeApp({ providers: undefined, tools: undefined }, { KEY_ENCRYPTION_SECRET: '' });
    const u = await bare.user();
    const res = await bare.call('GET', '/api/modes', undefined, u.cookie);
    expect(res.body.setup).toEqual({ encryptionSecret: false, ai: false, replicateToken: false, proModel: false, stripe: false, email: false });

    const full = makeApp(
      { providers: undefined, tools: undefined },
      { REPLICATE_API_TOKEN: 'r8_secret_value', REPLICATE_PRO_MODEL: 'a/b', AI: { run: async () => ({}) }, RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.c' } as never,
    );
    const u2 = await full.user();
    const r2 = await full.call('GET', '/api/modes', undefined, u2.cookie);
    expect(r2.body.setup).toMatchObject({ encryptionSecret: true, ai: true, replicateToken: true, proModel: true, email: true });
    expect(r2.text).not.toContain('r8_secret_value'); // values never leave the server
  });
});

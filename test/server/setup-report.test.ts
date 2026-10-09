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

  it('finds settings saved under a slightly different name or with stray spaces and quotes', async () => {
    const app = makeApp({ providers: undefined, tools: undefined }, { 'replicate_api_key ': ' "r8_pasted" \n', REPLICATE_PRO_MODEL: 'a/b' } as never);
    const u = await app.user();
    const res = await app.call('GET', '/api/modes', undefined, u.cookie);
    expect(res.body.setup).toMatchObject({ replicateToken: true });
    expect(res.body.modes.find((m: { mode: string }) => m.mode === 'fast').available).toBe(true);
    expect(res.body.settingNames).toContain('replicate_api_key ');
    expect(res.text).not.toContain('r8_pasted');
  });

  it('explains a wrong-length secret and keys saved under an old secret', async () => {
    const short = makeApp({}, { KEY_ENCRYPTION_SECRET: 'a-32-character-password-typed-in' });
    const u = await short.user();
    const bad = await short.call('PUT', '/api/keys/openai', { apiKey: 'sk-good-key-1234' }, u.cookie);
    expect(bad.status).toBe(500);
    expect(bad.body.error).toContain('44 characters');

    const app = makeApp();
    const v = await app.user();
    await app.call('PUT', '/api/keys/openai', { apiKey: 'sk-good-key-1234' }, v.cookie);
    app.env.KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 9).toString('base64');
    const stale = await app.call('POST', '/api/keys/openai/test', {}, v.cookie);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain('Remove it in Settings and add it again');
    expect((await app.call('DELETE', '/api/keys/openai', undefined, v.cookie)).status).toBe(200);
    expect((await app.call('PUT', '/api/keys/openai', { apiKey: 'sk-good-key-1234' }, v.cookie)).status).toBe(200);
  });

  it('saves a pasted key with stray spaces, line breaks or quotes', async () => {
    const app = makeApp();
    const u = await app.user();
    expect((await app.call('PUT', '/api/keys/replicate', { apiKey: ' "r8_pastedKey1234"\n' }, u.cookie)).status).toBe(200);
    expect((await app.call('GET', '/api/keys', undefined, u.cookie)).body.keys[0].last4).toBe('1234');
  });
});

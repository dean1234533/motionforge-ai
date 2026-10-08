import { resumeJobs } from './jobs';
import { withDefaults } from './env';
import type { RawEnv } from './env';
import { handle, resolveRegistry } from './router';
import { ensureSchema } from './schema';
import type { Ctx } from './router';
const fetchFn: typeof fetch = (...a) => fetch(...a);

export default {
  fetch(req: Request, env: RawEnv, ctx: Ctx): Promise<Response> {
    return handle(req, env, undefined, ctx);
  },
  /** Cron: resume generation jobs that are waiting on a remote provider. */
  async scheduled(_event: unknown, raw: RawEnv, ctx: Ctx): Promise<void> {
    const env = withDefaults(raw);
    ctx.waitUntil(ensureSchema(env.DB).then(() => resumeJobs(env.DB, env, resolveRegistry(env, { fetchFn }))));
  },
};

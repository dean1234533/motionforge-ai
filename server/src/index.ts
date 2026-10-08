import { resumeJobs } from './jobs';
import { handle, resolveProviders } from './router';
import type { Ctx } from './router';
import type { Env } from './types';

const fetchFn: typeof fetch = (...a) => fetch(...a);

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(req, env, undefined, ctx);
  },
  /** Cron: resume generation jobs that are waiting on a remote provider. */
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(resumeJobs(env.DB, env, resolveProviders(env, { fetchFn })));
  },
};

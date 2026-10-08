import { handle } from './router';
import type { Ctx } from './router';
import type { Env } from './types';

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(req, env, undefined, ctx);
  },
};

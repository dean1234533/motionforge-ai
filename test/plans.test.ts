import { describe, expect, it } from 'vitest';
import { resumeJobs } from '../server/src/jobs';
import { resolveRegistry } from '../server/src/router';
import { makeApp } from './server/harness';

describe('plans', () => {
  it('never limits how many projects can be created', async () => {
    const app = makeApp();
    const u = await app.user();
    for (let i = 0; i < 30; i++) {
      expect((await app.call('POST', '/api/projects', { name: `P${i}` }, u.cookie)).status).toBe(201);
    }
  });

  it('describes each plan on the billing page', async () => {
    const app = makeApp();
    const u = await app.user();
    const { plans } = (await app.call('GET', '/api/billing', undefined, u.cookie)).body;
    expect(plans.map((p: { id: string }) => p.id)).toEqual(['free', 'creator', 'professional']);
    expect(plans[0]).toMatchObject({ projects: 3 });
    expect(plans[2].features).toEqual(expect.arrayContaining(['Commercial use', 'Team projects', 'Priority processing', 'Advanced export options']));
    expect(plans[1].features).toContain('No badge on exports');
  });
});

describe('priority processing', () => {
  it('resumes Professional-plan jobs before older free-plan jobs', async () => {
    const app = makeApp();
    const free = await app.user();
    const pro = await app.user();
    app.sqlite.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(free.id);
    app.sqlite.prepare("UPDATE users SET plan = 'professional' WHERE id = ?").run(pro.id);
    const mk = async (u: { cookie: string }, key: string) => {
      const pid = (await app.call('POST', '/api/projects', { name: 'P' }, u.cookie)).body.project.id;
      return (await app.call('POST', '/api/jobs', { projectId: pid, mode: 'free', prompt: 'fly', idempotencyKey: key }, u.cookie)).body.job.id as string;
    };
    const freeJob = await mk(free, 'priority-free-01'); // created first, so it is older
    const proJob = await mk(pro, 'priority-pro-001');
    // let the immediate runs finish, then put both jobs back in the waiting line, aged
    await app.settle();
    app.sqlite.prepare("UPDATE jobs SET status = 'queued', stage_done = -1, state = '{}', updated_at = updated_at - 100").run();

    expect(await resumeJobs(app.env.DB, app.env, resolveRegistry(app.env, { fetchFn: fetch }), 1)).toBe(1);
    const status = (id: string) => (app.sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string }).status;
    expect(status(proJob)).toBe('complete');
    expect(status(freeJob)).toBe('queued');
  });
});

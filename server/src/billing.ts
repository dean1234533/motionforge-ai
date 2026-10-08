import { grantOnce } from './credits';
import { PLAN_FEATURES, projectLimit } from './plans';
import { HttpError } from './http';
import type { D1Database, Env } from './types';

const now = () => Math.floor(Date.now() / 1000);

/** Monthly credits per paid plan. Adjust here; the price itself lives in Stripe. */
export const PLANS = {
  creator: { label: 'Creator', credits: 300, priceVar: 'STRIPE_PRICE_CREATOR' as const },
  professional: { label: 'Professional', credits: 1500, priceVar: 'STRIPE_PRICE_PROFESSIONAL' as const },
};
export type PaidPlan = keyof typeof PLANS;
export const isPaidPlan = (p: unknown): p is PaidPlan => typeof p === 'string' && Object.hasOwn(PLANS, p);

export const billingConfigured = (env: Env) =>
  Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_CREATOR && env.STRIPE_PRICE_PROFESSIONAL && env.APP_URL);

export async function billingSummary(env: Env, userId: string, plan: string) {
  const sub = await env.DB.prepare('SELECT status FROM subscriptions WHERE user_id = ?').bind(userId).first<{ status: string }>();
  const { results } = await env.DB.prepare('SELECT delta, reason, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20')
    .bind(userId)
    .all<{ delta: number; reason: string; created_at: number }>();
  return {
    configured: billingConfigured(env),
    plan,
    status: sub?.status ?? 'none',
    plans: [
      { id: 'free', label: 'Free', credits: 20, projects: projectLimit('free'), features: PLAN_FEATURES.free },
      ...Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, credits: p.credits, projects: projectLimit(id), features: PLAN_FEATURES[id] })),
    ],
    ledger: results.map((l) => ({ delta: l.delta, reason: l.reason, createdAt: l.created_at })),
  };
}

async function stripe(env: Env, fetchFn: typeof fetch, path: string, params: Record<string, string>) {
  const res = await fetchFn(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new HttpError(502, 'The payment provider could not complete that request.');
  return (await res.json()) as { url?: string };
}

export async function createCheckout(env: Env, fetchFn: typeof fetch, user: { id: string; email: string }, plan: unknown) {
  if (!billingConfigured(env)) throw new HttpError(501, 'Billing is not configured yet.');
  if (!isPaidPlan(plan)) throw new HttpError(400, 'Choose Creator or Professional.');
  const sub = await env.DB.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?').bind(user.id).first<{ stripe_customer_id: string }>();
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': env[PLANS[plan].priceVar]!,
    'line_items[0][quantity]': '1',
    client_reference_id: user.id,
    'metadata[plan]': plan,
    'subscription_data[metadata][plan]': plan,
    success_url: `${env.APP_URL}/#/billing?status=success`,
    cancel_url: `${env.APP_URL}/#/billing?status=cancelled`,
  };
  if (sub) params.customer = sub.stripe_customer_id;
  else params.customer_email = user.email;
  const s = await stripe(env, fetchFn, 'checkout/sessions', params);
  if (!s.url) throw new HttpError(502, 'The payment provider did not return a checkout link.');
  return { url: s.url };
}

export async function createPortal(env: Env, fetchFn: typeof fetch, userId: string) {
  if (!billingConfigured(env)) throw new HttpError(501, 'Billing is not configured yet.');
  const sub = await env.DB.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?').bind(userId).first<{ stripe_customer_id: string }>();
  if (!sub) throw new HttpError(404, 'You do not have a subscription yet.');
  const s = await stripe(env, fetchFn, 'billing_portal/sessions', { customer: sub.stripe_customer_id, return_url: `${env.APP_URL}/#/billing` });
  if (!s.url) throw new HttpError(502, 'The payment provider did not return a link.');
  return { url: s.url };
}

/** Stripe signs `${timestamp}.${payload}` with HMAC-SHA256. Reject old or forged requests. */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, nowSeconds = now(), toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret) as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`) as unknown as BufferSource));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === expected.length && timingSafe(s, expected));
}

function timingSafe(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signForTest(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret) as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`) as unknown as BufferSource));
  return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function setPlan(db: D1Database, userId: string, plan: string) {
  await db.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(plan, userId).run();
}

export async function handleStripeEvent(db: D1Database, event: StripeEvent): Promise<void> {
  const o = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = o.client_reference_id as string | undefined;
      const plan = o.metadata?.plan;
      if (!userId || !isPaidPlan(plan) || typeof o.customer !== 'string') return;
      const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
      if (!user) return;
      await db
        .prepare(
          `INSERT INTO subscriptions(user_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at) VALUES(?, ?, ?, ?, 'active', ?)
           ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id,
             plan = excluded.plan, status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(userId, o.customer, typeof o.subscription === 'string' ? o.subscription : null, plan, now())
        .run();
      await setPlan(db, userId, plan);
      return;
    }
    case 'invoice.paid': {
      if (typeof o.customer !== 'string') return;
      const sub = await db.prepare('SELECT user_id, plan FROM subscriptions WHERE stripe_customer_id = ?').bind(o.customer).first<{ user_id: string; plan: string }>();
      if (!sub || !isPaidPlan(sub.plan)) return;
      await grantOnce(db, sub.user_id, PLANS[sub.plan].credits, `${PLANS[sub.plan].label} plan credits`, `stripe:${event.id}`);
      return;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (typeof o.customer !== 'string') return;
      const sub = await db.prepare('SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?').bind(o.customer).first<{ user_id: string }>();
      if (!sub) return;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : String(o.status ?? 'active');
      await db.prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ?').bind(status, now(), sub.user_id).run();
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(status)) await setPlan(db, sub.user_id, 'free');
      return;
    }
  }
}


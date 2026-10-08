# Deploying MotionForge AI

Everything runs on Cloudflare: a Worker (API + cron), D1 (database), R2 (image storage) and static assets for the front-end, all on one origin. The free mode works with none of this; deploy only when you want accounts, saved projects, sharing, billing and paid generation.

## One-time setup (Cloudflare dashboard or `npx wrangler`)

1. `npx wrangler d1 create motionforge` and paste the `database_id` into `server/wrangler.jsonc`.
2. `npx wrangler r2 bucket create motionforge-files`.
3. In `server/wrangler.jsonc` set `APP_URL` and `ALLOWED_ORIGIN` to your public URL (for example `https://motionforge.example.com`, no trailing slash).
4. Set the encryption secret (required; losing it makes stored API keys unreadable):
   `openssl rand -base64 32 | npx wrangler secret put KEY_ENCRYPTION_SECRET --config server/wrangler.jsonc`
5. In GitHub: Settings -> Secrets -> Actions, add `CLOUDFLARE_API_TOKEN` (Workers, D1 and R2 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
6. Actions tab -> **Deploy** -> Run workflow. It tests, builds, applies migrations and deploys.

## Optional: paid plans (Stripe)

Create two recurring prices in Stripe (Creator, Professional), then set secrets
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_PROFESSIONAL`.
Add a webhook endpoint `https://YOUR_DOMAIN/api/webhooks/stripe` for the events
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`.
Credits per plan are defined in `server/src/billing.ts` (`PLANS`). Test in Stripe test mode first.

## Optional: paid generation (Replicate)

Pick an image-to-video model on replicate.com and copy its **version id**.
Set the variables `REPLICATE_FAST_VERSION` and/or `REPLICATE_PRO_VERSION` (plain vars in `wrangler.jsonc`) and the secret `REPLICATE_API_TOKEN`.
If the model's image input is not called `image`, set `REPLICATE_IMAGE_FIELD`.
Bring-your-own-key mode uses the Fast version with the user's own Replicate key.

A cron trigger (every minute) resumes jobs that are waiting on Replicate.

## Optional: image generation and upscaling

- **Image generation** (OpenAI images API): set the variable `OPENAI_IMAGE_MODEL` to a model name your account can use. Set the secret `OPENAI_API_KEY` if you want credits to pay for it; leave it out to offer "use my own key" only. Set `OPENAI_IMAGE_TRANSPARENT=1` if the model supports `background: "transparent"`; otherwise images are requested on a white background and cleaned up in the browser.
- **Upscaling** (Replicate): set `REPLICATE_UPSCALE_VERSION` to an upscaling model version id (and `REPLICATE_UPSCALE_IMAGE_FIELD` / `REPLICATE_UPSCALE_SCALE_FIELD` if the model names its inputs differently). Uses `REPLICATE_API_TOKEN` for credits, or the user's own Replicate key.

Costs in credits are in `server/src/providers.ts` (`TOOLS`, `MODES`).

## Optional: invitation emails

Set the secret `RESEND_API_KEY` (from resend.com) and the variable `MAIL_FROM`, for example `MotionForge <team@yourdomain.com>` (the domain must be verified in Resend). `APP_URL` must also be set. Without these, owners copy the invitation link and send it themselves.

## Teams

Creating a team needs the Professional plan (set by a successful Stripe checkout). Invitation links are tied to one email address and expire after 7 days.

## Plans

Project limits and the feature lists shown on the Billing page are in `server/src/plans.ts`; credits per plan are in `server/src/billing.ts`. Exports made on a Free plan (or with no account) carry a small badge that links back to the editor; the licence text for exports is in `src/export/build.ts`. Review that wording before you launch.

## Local development

`npx wrangler dev --config server/wrangler.jsonc` (API on :8787) and `npm run dev` (front-end on :5173, proxies `/api`).

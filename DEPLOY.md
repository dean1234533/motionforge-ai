# Deploying MotionForge AI

Everything runs on Cloudflare as one Worker: it serves the website and the API, stores data in D1 (database) and R2 (images), and a cron trigger resumes slow AI jobs. The Free mode works with none of this; deploy when you want accounts, saved projects, sharing, teams, billing and paid generation.

## The simple way: Workers Builds (connect the GitHub repo)

In the Cloudflare dashboard: **Workers & Pages > Create > Import a repository**, pick this repo, and use:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | (leave empty) |

The repo's [wrangler.jsonc](wrangler.jsonc) tells Wrangler what to create. On the first deploy it **creates the D1 database and R2 bucket for you**, and the Worker **creates its own tables** the first time it runs. There is no separate migration step.

If your Cloudflare account has never used R2, you may need to switch it on once first (**R2 Object Storage** in the dashboard; it asks you to accept terms and may ask for a payment method, though the free allowance is generous). If a deploy ever fails with an R2 error, that is the first thing to check. As a manual alternative, create a bucket yourself, then change the line in `wrangler.jsonc` to `{ "binding": "FILES", "bucket_name": "your-bucket-name" }`.

Then add one secret (**Settings > Variables and Secrets**):

- `KEY_ENCRYPTION_SECRET` — generate with `openssl rand -base64 32`. It encrypts users' saved API keys. Keep a copy; if you lose it, saved keys become unreadable. Without it, everything else works but saving API keys is switched off.

Open the site, sign up, and you are running. Everything below is optional.

## Optional settings

Add these as variables (plain text) or secrets in the same place.

- `ALLOWED_ORIGIN` — your site's address with no trailing slash, e.g. `https://motionforge-ai.yourname.workers.dev`. Extra protection that rejects requests from other sites.
- `APP_URL` — the same address. Defaults to the address the site is served from, which is right for most setups.

### Paid plans (Stripe)

Create two recurring prices in Stripe (Creator, Professional), then set secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_PROFESSIONAL`. Add a webhook endpoint `https://YOUR_DOMAIN/api/webhooks/stripe` for `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`. Credits per plan are in `server/src/billing.ts`. Try Stripe test mode first.

### Paid generation (Replicate)

Pick an image-to-video model on replicate.com and copy its **version id**. Set `REPLICATE_FAST_VERSION` and/or `REPLICATE_PRO_VERSION` (variables) and `REPLICATE_API_TOKEN` (secret). If the model's image input is not called `image`, set `REPLICATE_IMAGE_FIELD`. Bring-your-own-key mode uses the Fast version with the user's own Replicate key.

### Image generation and upscaling

- Image generation (OpenAI): set `OPENAI_IMAGE_MODEL` to a model your account can use. Add `OPENAI_API_KEY` (secret) if credits should pay for it; leave it out to offer "use my own key" only. Set `OPENAI_IMAGE_TRANSPARENT=1` if the model supports transparent backgrounds.
- Upscaling (Replicate): set `REPLICATE_UPSCALE_VERSION` (and `REPLICATE_UPSCALE_IMAGE_FIELD` / `REPLICATE_UPSCALE_SCALE_FIELD` if the model names its inputs differently). Uses `REPLICATE_API_TOKEN`, or the user's own key.

### Invitation emails (Resend)

Set secret `RESEND_API_KEY` and variable `MAIL_FROM`, e.g. `MotionForge <team@yourdomain.com>` (verify the domain in Resend). Without these, team owners copy the invitation link and send it themselves.

### Plans

Project limits and feature lists are in `server/src/plans.ts`; credits per plan in `server/src/billing.ts`. Free exports carry a small badge; the licence wording is in `src/export/build.ts`. Review that wording before launch.

## Deploying from GitHub Actions instead

Add repository secrets `CLOUDFLARE_API_TOKEN` (Workers, D1 and R2 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`, then run the **Deploy** workflow from the Actions tab.

## Local development

`npx wrangler dev --local` (API and site on :8787), or `npm run dev` (front-end on :5173, proxies `/api` to :8787).

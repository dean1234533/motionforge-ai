# Deploying MotionForge AI

Everything runs on Cloudflare as one Worker: it serves the website and the API, stores data and images in D1 (database), and a cron trigger resumes slow AI jobs. The Free mode works with none of this; deploy when you want accounts, saved projects, sharing, teams, billing and paid generation.

## The simple way: Workers Builds (connect the GitHub repo)

In the Cloudflare dashboard: **Workers & Pages > Create > Import a repository**, pick this repo, and use:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | (leave empty) |

The repo's [wrangler.jsonc](wrangler.jsonc) tells Wrangler what to create. On the first deploy it **creates the D1 database for you**, and the Worker **creates its own tables** the first time it runs. There is no separate migration step and no storage to set up: uploaded images are kept in the database.

Optional: to keep images in an R2 bucket instead (better for large amounts of data), create a bucket in the dashboard (**R2 Object Storage**) and add `"r2_buckets": [{ "binding": "FILES", "bucket_name": "your-bucket-name" }]` to `wrangler.jsonc`. New uploads then go to R2; existing ones stay in the database.

Optionally add one secret (**Settings > Variables and Secrets**):

- `KEY_ENCRYPTION_SECRET` — generate with `openssl rand -base64 32`. It encrypts users' saved API keys. Keep a copy; if you lose it, keys saved with it become unreadable. Without it, the server generates its own secret and keeps it in the database, so saving keys still works; setting one is better, because then a copy of the database alone cannot unlock the keys.

Open the site, sign up, and you are running. Everything below is optional.

## AI that needs no setup (Cloudflare Workers AI)

`wrangler.jsonc` binds Cloudflare's own AI, so these work as soon as you deploy, with no account or key to add:

- **Understanding what you type.** For signed-in users in Free mode, a language model turns the sentence into movement numbers. Every number is range-checked, and if the AI errors or answers badly the rule-based planner is used instead. Costs 2 credits per prompt.
- **Create with AI.** Describe an image and FLUX (`flux-1-schnell`) makes it, added as a new layer. Costs 4 credits. The image has a white background, which the editor removes.

Usage is billed to *your* Cloudflare account (there is a daily free allowance; see Cloudflare's Workers AI pricing). Users pay you in credits, so set credit prices with that in mind. If you would rather use OpenAI for image generation, set `OPENAI_IMAGE_MODEL` (below) and it takes over.

Cloudflare's AI does not do video, background removal or upscaling. For video from a still, and for upscaling, add Replicate (below).

## Optional settings

Add these as variables (plain text) or secrets in the same place.

- `ALLOWED_ORIGIN` — your site's address with no trailing slash, e.g. `https://motionforge-ai.yourname.workers.dev`. Extra protection that rejects requests from other sites.
- `APP_URL` — the same address. Defaults to the address the site is served from, which is right for most setups.

### Paid plans (Stripe)

Create two recurring prices in Stripe (Creator, Professional), then set secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_PROFESSIONAL`. Add a webhook endpoint `https://YOUR_DOMAIN/api/webhooks/stripe` for `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`. Credits per plan are in `server/src/billing.ts`. Try Stripe test mode first.

### Video from a still, and upscaling (Replicate)

Create an account at replicate.com, add a payment method, and make an API token (Account → API tokens). Then:

1. Add the token as a **secret** named `REPLICATE_API_TOKEN`. That is all you need: **Fast** mode then works using `bytedance/seedance-1-lite`, and **Upscale** uses `recraft-ai/recraft-crisp-upscale`.
2. To choose other models, add **variables** (plain text) with a model name in the form `owner/name`: `REPLICATE_FAST_MODEL`, `REPLICATE_PRO_MODEL` (Professional mode stays off until you set this; `bytedance/seedance-1-pro` is a reasonable choice) and `REPLICATE_UPSCALE_MODEL`.

You never need to look up version ids or input names. When a job starts, the app reads the model's own description from Replicate, finds which input takes the picture, picks the shortest clip length, and asks for a fixed camera where the model supports it. If a model cannot take an image, the job fails with a clear message and the credits are refunded. Replicate charges your account per run, so set the credit prices (`server/src/providers.ts`) above your cost.

**Bring your own key** needs no token from you: people paste their own Replicate key in Settings and pay Replicate directly.

These default model names are my suggestions from Replicate's published list. I could not run them (that needs your token), so try one video and one upscale after you add the token. Older setups that use `REPLICATE_FAST_VERSION`, `REPLICATE_PRO_VERSION` and `REPLICATE_UPSCALE_VERSION` keep working and take priority.

### Image generation and upscaling

- Image generation (OpenAI): set `OPENAI_IMAGE_MODEL` to a model your account can use. Add `OPENAI_API_KEY` (secret) if credits should pay for it; leave it out to offer "use my own key" only. Set `OPENAI_IMAGE_TRANSPARENT=1` if the model supports transparent backgrounds.
- Upscaling: see the Replicate section above.

### Invitation emails (Resend)

Set secret `RESEND_API_KEY` and variable `MAIL_FROM`, e.g. `MotionForge <team@yourdomain.com>` (verify the domain in Resend). Without these, team owners copy the invitation link and send it themselves.

### Plans

Project limits and feature lists are in `server/src/plans.ts`; credits per plan in `server/src/billing.ts`. Free exports carry a small badge; the licence wording is in `src/export/build.ts`. Review that wording before launch.

## Deploying from GitHub Actions instead

Add repository secrets `CLOUDFLARE_API_TOKEN` (Workers, D1 and R2 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`, then run the **Deploy** workflow from the Actions tab.

## Local development

`npx wrangler dev --local` (API and site on :8787), or `npm run dev` (front-end on :5173, proxies `/api` to :8787).

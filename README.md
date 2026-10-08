# MotionForge AI

Turn an image and a plain-English idea into a scroll-controlled website animation, then export code that runs anywhere.

## What is built and tested

Everything below runs in CI on every push (unit tests, plus two real-browser tests: the editor on its own, and the whole stack running locally through `wrangler dev`).

**Editor and exports (works with no account, all in the browser)**
- Upload PNG/JPG/WebP (type and size validated), background removal for plain backgrounds, 24 simulated wing-flap frames
- Plain-English planning and follow-up edits ("fly more slowly", "flap faster", "move the ending position higher", "smaller on mobile", "reverse the direction", "more cinematic")
- Layers, draggable/keyboard-movable motion path, rotation/scale/opacity/blur, easing, pinning, scroll length, desktop/tablet/mobile preview, undo/redo, autosave
- Strict Zod scene schema; scenes are validated before rendering; no generated code is ever executed
- Export: standalone HTML, embed snippet, self-host ZIP (Webflow/WordPress snippet, React component, install guide). No API keys, no network calls, transparent, reduced-motion fallback, reverses on scroll-up

**Server (Cloudflare Worker + D1 + R2)**
- Accounts (hashed passwords, secure cookies, CSRF header, rate limits), projects with version history, image storage with real file-type checks
- Dashboard, new-project, settings, billing, public share pages
- Encrypted bring-your-own-key vault (AES-GCM, never returned or logged)
- Credit ledger, cost estimate and confirmation before paid generation, jobs with the spec's progress states, safe retry (never charged twice), refund on cancel
- Share links (view-only, revocable), export history

## Written but not yet exercised against the real services

These are unit-tested against mocked HTTP only. Treat them as untested until you run them with real credentials (see DEPLOY.md):

- **Stripe** checkout, customer portal and webhooks (signature verification is tested with the documented algorithm)
- **Replicate** image-to-video, and the browser step that turns the generated video into transparent frames (it removes plain backgrounds frame by frame, so results depend on the model's output)
- Deployment to Cloudflare itself

## Not built

- Team projects (Professional plan), smoke/fire/WebGL particle effects, per-project upscaling and image generation providers (the adapter interfaces exist in `src/ai/providers.ts`)

## Run

```
npm install
npm run dev          # editor at http://localhost:5173/#/editor
npm test             # unit tests (including the server, against SQLite)
npm run e2e          # editor browser test
npm run e2e:cloud    # full stack through wrangler dev
```

See [DEPLOY.md](DEPLOY.md) to put it online.

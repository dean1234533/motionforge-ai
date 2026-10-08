# MotionForge AI

Turn an image and a plain-English idea into a scroll-controlled website animation, then export code that runs anywhere.

## What is built and tested

Everything below runs in CI on every push: unit tests (including the whole server against a real SQLite database), a browser test of the editor, a browser test of the particle renderers, and a full-stack browser test that runs the real Worker locally through `wrangler dev`.

**Editor and exports (works with no account, all in the browser)**
- Upload PNG/JPG/WebP (type and size validated), background removal for plain backgrounds, 24 simulated wing-flap frames
- Plain-English planning and follow-up edits ("fly more slowly", "flap faster", "move the ending position higher", "smaller on mobile", "reverse the direction", "more cinematic", "add smoke", "add rain", "give it more depth")
- Layers, draggable/keyboard-movable motion path, rotation/scale/opacity/blur, easing, pinning, parallax, scroll length, desktop/tablet/mobile preview, undo/redo, autosave
- **Particle effects** (smoke, fire, water, sparkles, snow/rain) that follow any layer and scrub and reverse exactly. Heavy scenes (250+ particles) render with WebGL; lighter ones, or browsers without WebGL, use canvas
- **Multiple objects**: attach one layer to another at an offset, parallax depth between layers
- Strict Zod scene schema; scenes are validated before rendering; no generated code is ever executed
- Export: standalone HTML, embed snippet, self-host ZIP (Webflow/WordPress snippet, React component, install guide). No API keys, no network calls, transparent, reduced-motion fallback, reverses on scroll-up

**Server (Cloudflare Worker + D1 + R2)**
- Accounts (hashed passwords, secure cookies, CSRF header, rate limits), projects with version history, image storage with real file-type checks
- **Teams** (Professional plan to create): owner/editor/viewer roles, single-use invite links tied to an email, shared team projects, read-only mode for viewers
- Dashboard, new-project, teams, settings, billing, public share pages
- Encrypted bring-your-own-key vault (AES-GCM, never returned or logged)
- Credit ledger, cost estimate and confirmation before paid work, jobs with the spec's progress states, safe retry (never charged twice), refund on cancel
- **Image generation** (OpenAI images API) and **upscaling** (Replicate) as paid jobs, or free with your own key; upscaled images get higher-resolution frames
- Share links (view-only, revocable), export history

## Written but not yet exercised against the real services

Unit-tested against mocked HTTP only. Treat as untested until run with real credentials (see DEPLOY.md):

- **Stripe** checkout, customer portal and webhooks (signature verification is tested with the documented algorithm)
- **Replicate** image-to-video and upscaling, and the browser step that turns a generated video into transparent frames (it removes plain backgrounds frame by frame, so quality depends on the model)
- **OpenAI** image generation (model name and transparency support are configuration)
- Deployment to Cloudflare itself

## Not built

- Emailing invitations (owners share invite links themselves)
- A hosted video-matting model for complex backgrounds
- Sub-pixel SVG renderer for vector paths (paths are edited as SVG overlays in the editor; exports render on canvas/WebGL)

## Run

```
npm install
npm run dev          # editor at http://localhost:5173/#/editor
npm test             # unit tests (including the server, against SQLite)
npm run e2e          # editor + particle renderer browser tests
npm run e2e:cloud    # full stack through wrangler dev
```

See [DEPLOY.md](DEPLOY.md) to put it online.

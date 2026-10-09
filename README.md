# MotionForge AI

Turn an image and a plain-English idea into a scroll-controlled website animation, then export code that runs anywhere.

## What is built and tested

Everything below runs in CI on every push: unit tests (including the whole server against a real SQLite database and a PHP syntax check of the generated WordPress plugin), browser tests of the editor, the particle/HTML/SVG renderers and the video pipeline, and a full-stack browser test that runs the real Worker locally through `wrangler dev`.

**Editor and exports (works with no account, all in the browser)**
- Upload PNG/JPG/WebP (type and size validated), background removal for plain backgrounds; original still images remain intact until an action is generated
- Plain-English planning and follow-up edits ("move the ending position higher", "smaller on mobile", "reverse the direction", "more cinematic", "add smoke", "add rain", "add a circle", "add a line showing its path", "give it more depth")
- Layers, draggable/keyboard-movable motion path, rotation/scale/opacity/blur, easing, pinning, parallax, scroll length, desktop/tablet/mobile preview, undo/redo, autosave
- **Renderer chosen per element**: images and light particles on canvas, heavy particle scenes on WebGL (automatic canvas fallback), simple shapes as HTML/CSS, lines as SVG that draw in with the scroll; frame sequences for realistic motion
- **Particle effects** (smoke, fire, water, sparkles, snow/rain), **shapes**, **lines**, layers that **follow other layers**, parallax depth. Everything scrubs and reverses exactly
- Strict Zod scene schema; scenes are validated before rendering; no generated code is ever executed
- Export: standalone HTML, embed snippet, self-host ZIP (Webflow/WordPress hosted snippet, **WordPress plugin with a `[motionforge]` shortcode**, React component, install guide, licence). No API keys, no network calls, transparent, reduced-motion fallback, reverses on scroll-up
- Plans: Free exports carry a small badge; Creator/Professional remove it and use 1024 px frames; Professional adds lighter-file options and a commercial licence

**Server (Cloudflare Worker + D1 + R2)**
- Accounts (hashed passwords, secure cookies, CSRF header, rate limits), projects with version history, image storage with real file-type checks, per-plan project limits
- **Teams** (Professional plan to create): owner/editor/viewer roles, single-use invite links tied to an email and **emailed** when mail is configured, shared team projects, read-only mode for viewers
- Dashboard, new-project, teams, settings, billing, public share pages
- Encrypted bring-your-own-key vault (AES-GCM, never returned or logged)
- Credit ledger, cost estimate and confirmation before paid work, jobs with the spec's progress states, safe retry (never charged twice), refund on cancel, **priority processing** for Professional
- Paid generation: uploaded and generated subjects use Replicate image-to-video for articulated actions, then chroma-keyed transparent frames. Review, accept or regenerate each action; accepted sequences preserve the original image and support once/loop playback, reverse scrubbing and export. Model quality varies and realism cannot be guaranteed. Also supports **image generation**, **upscaling**; free with your own key
- **Brand Studio**: logos (3D mascot, emblem, luxury, minimal…), flyers and posters, product ads, social posts and merch mockups from a short brief, with 1 to 4 variations, an editable prompt, PNG and **vector SVG** downloads, and one-click **Animate** that opens a design in the editor with a ready-made logo motion (spin in, zoom reveal, drop in, fly across, float)
- Share links (view-only, revocable), export history

## Written but not yet exercised against the real services

Unit-tested against mocked HTTP only. Treat as untested until run with real credentials (see DEPLOY.md):

- **Stripe** checkout, customer portal and webhooks (signature verification is tested with the documented algorithm)
- **Replicate** image-to-video, upscaling and Brand Studio designs, **OpenAI** image generation, **Resend** email (the chroma-key step itself is tested on a real recorded video)
- Deployment to Cloudflare itself

## Run

```
npm install
npm run dev          # editor at http://localhost:5173/#/editor
npm test             # unit tests (including the server, against SQLite)
npm run e2e          # editor, renderer and video browser tests
npm run e2e:cloud    # full stack through wrangler dev
```

See [DEPLOY.md](DEPLOY.md) to put it online.

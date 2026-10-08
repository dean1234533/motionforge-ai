# MotionForge AI

Turn an image and a plain-English idea into a scroll-controlled website animation, then export code that runs anywhere.

## What works today (MVP)

- Upload PNG/JPG/WebP (validated, filenames sanitised) or use the sample bird
- In-browser background removal (edge flood-fill), trimming and 24 simulated wing-flap frames
- Plain-English planning ("fly along a curved path from the bottom-left to the top-right") and follow-up edits ("fly more slowly", "flap faster", "move the ending position higher", "smaller on mobile", "reverse the direction", "more cinematic")
- Editor: layers, draggable/keyboard-movable motion path, per-object rotation/scale/opacity/blur, easing, pinning, scroll length, desktop/tablet/mobile preview, undo/redo, autosave (browser storage)
- Strict Zod scene schema; every scene is validated before it is rendered; no generated code is ever executed
- Export: standalone HTML, copy-able embed snippet, self-host ZIP (hosted snippet for Webflow/WordPress, React component, install guide). No API keys, no network calls, transparent background, reduced-motion fallback, reversible on scroll-up
- Landing page with live bird demo, docs page

## Not built yet (needs a server)

Accounts, dashboard, billing/credits, sharing, background job queue, encrypted bring-your-own-key storage, and the Fast/Professional providers. The provider-adapter interfaces are in `src/ai/providers.ts`; those modes are shown as unavailable in the UI rather than faked.

## Run

```
npm install
npm run dev      # editor at http://localhost:5173/#/editor
npm test
npm run build
```

## Layout

- `src/scene` schema and defaults (single source of truth for animations)
- `src/runtime/motionforge-runtime.js` dependency-free runtime shared by the editor preview and every export
- `src/ai` provider interfaces, local planner, edit commands, image pipeline
- `src/export` HTML / snippet / ZIP builders
- `src/pages`, `src/editor` UI

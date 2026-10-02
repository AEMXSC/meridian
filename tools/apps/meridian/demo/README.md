# Meridian — UX demo (GitHub Pages)

A standalone, **DA-free** build of the real Meridian app, for the UX team to walk
the flow without an IMS org, DA access, or any network back-end.

## How it works

It runs the **actual app** (`../meridian.js`, same Lit components, same engine) —
nothing is reskinned or mocked at the UI layer. Only the data layer is swapped:

- [`mock-da.js`](mock-da.js) routes the app's single authenticated-fetch seam
  (`setDaFetch`) to an **in-memory DA source tree**, emulating the four URL
  families the app hits: DA `source` (GET/HEAD/PUT/DELETE), DA `list`, AEM Admin
  `status`/`preview`/`live`, and the worker `/translate` proxy.
- [`fixtures.js`](fixtures.js) seeds that tree — source pages, a market catalog,
  a managed manifest (some live, some staged, one deliberately stale), pending
  approvals, and the Phase-1 exposure model — using the app's own helpers.
- [`translate-dict.js`](translate-dict.js) is an offline stand-in for the
  translation worker (a small banking dictionary). Translations are
  **illustrative**, not real MT.
- [`boot.js`](boot.js) installs the above, then loads the real app. The app's
  `init()` has one guarded branch: when `window.__MERIDIAN_DEMO__` is set it
  skips the DA_SDK handshake and boots into the seeded project. In production
  that global is never set, so the live app is byte-identical.

Writes persist **in memory for the session** — Translate, Request approval, and
Approve all work and update the UI; a refresh resets to the seed.

## Run locally

Serve the repo root over HTTP (ES modules + the da.live imports need http, not
`file://`):

```sh
npx http-server . -p 3000   # or any static server
# open http://localhost:3000/tools/apps/meridian/demo/
```

## Deploy

Pushed to GitHub Pages by [`.github/workflows/pages.yml`](../../../../.github/workflows/pages.yml)
on every push to `main`. One-time: repo **Settings → Pages → Source = "GitHub
Actions"**. Live at `https://aemxsc.github.io/meridian/` (redirects to the demo).

> Public da.live modules/styles still load from the network (same as the DA
> plugin, which imports them cross-origin in production). No auth is involved.

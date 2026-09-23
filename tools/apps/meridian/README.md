# Meridian — Agentic Localization & Multi-Market

Meridian turns localization from *translate-then-rollout* into a single propagation
flow: one **canonical content object** plus typed per-market **adaptation layers**
→ **derived variants** materialized to the edge, computed fresh (never
hand-maintained). It runs native on Edge Delivery Services + DA.live as a
DA-native app (vanilla JS ES modules, no build step), styled to Adobe Spectrum 2.

This is a **portable, org-agnostic app**: nothing is hardcoded to a specific org or
site. Any org installs it by registering it in their own DA config (below), exactly
like the other apps in `adobe-rnd/aem-apps`. All content it manages is scoped under
`/meridian/…` in the target site, so it never collides with the host site's content.

## What's inside

| Surface | Where | Does |
| --- | --- | --- |
| Full-page app | `tools/apps/meridian/meridian.html` | Five tabs: **Dashboard** (staged/live coverage) · **Pages** (Translate / Localize / Promote) · **Issues** (exposure) · **Approvals** (promotion requests + taste queue) · **Market rules** (adaptation authoring + New-market setup) |
| Prepare-menu plugin | `tools/plugins/meridian/meridian.html` | Per-page exposure summary + deep-link into the app |
| Engine | `tools/apps/meridian/core/` | Pure, node-testable JS (no DA/https imports): `schemas`, `hash`, `materialize`, `exposure`, `scan`, `diff`, `propagate`, `scoring`, `classify`, `propose`, `migrate`, `locale-config`, `quality`, `tm`, `eds-html`, `localize-page`, `managed`, `variant-status`, `da-config`, `concurrency` |
| DA client | `tools/apps/meridian/core/store.js` | `DaStore` — all DA reads/writes + preview/publish; injectable `fetchImpl` for tests |
| Translation client | `tools/apps/meridian/core/translate.js` | `createTranslator` — posts to the worker `/translate` (pluggable provider) |
| Worker | `worker/src/index.js` | `/translate` (MT provider chain), `/glossary` (build a DeepL glossary), `/api/queue/*` (taste-queue approve/reject with the caller's IMS identity) |
| Integration | `tools/apps/meridian/integration/hreflang.js` | Runtime drop-in for a host site's `scripts.js` — injects reciprocal hreflang from the published index |

## Install it on your site (any org)

Register the two entries in **your DA site config** using DA's built-in **Config**
editor (the sheet UI — open your site in DA → **Config** → add rows to the `library`
and `prepare` sheets). This writes DA's config store (`admin.da.live/config/{org}/{site}`),
which is **not** a source file — editing `.da/config.json` in the content source does
*not* register anything. Site-level config covers one site; org-level config covers
every site in the org. Use the hosted build, or vendor the files into your own repo
and use relative paths.

### `library` sheet — the full-page app

| title | path | experience |
| --- | --- | --- |
| `Meridian` | `https://main--meridian--aemxsc.aem.live/tools/apps/meridian/meridian.html` | `fullsize-dialog` |

### `prepare` sheet — the in-editor plugin

| title | path | icon | experience |
| --- | --- | --- | --- |
| `Meridian` | `https://main--meridian--aemxsc.aem.live/tools/plugins/meridian/meridian.html` | `https://da.live/blocks/edit/img/S2_Icon_GlobeGrid_20_N.svg#S2_Icon_GlobeGrid` | `dialog` |

> Registration paths must be `.aem.live` (not `.aem.page`). To pin your own build,
> replace `meridian--aemxsc` with `<branch>--<repo>--<org>` for your fork, or use a
> repo-relative path (`/tools/apps/meridian/meridian.html`) if you vendored the code.

The app reads the org/site of whatever page it's launched from (via `DA_SDK`), so the
same registration works for every site — there is nothing site-specific to change.

## Configure a site's markets

**Drop-in with DA's own localization config.** If the site already has a
`/.da/translate-v2.json` (the sheet the official DA localization app —
[da.live/apps/loc](https://da.live/apps/loc), `adobe-rnd/da-locale-tools` — reads),
Meridian reads it too: its `languages` sheet becomes the base target markets and each
`locales` (region) row becomes a group (e.g. *Canada* → `de-ca`, `fr-ca`) with a
one-click **All** in the market picker, and the coverage matrix shows every configured
market — even ones not yet localized. No reconfiguration; Meridian just layers MT +
quality gating + exposure on top. Sites with no `translate-v2.json` fall back to
folder discovery + a common quick-pick list, exactly as before.

**Per-market repos (multi-site).** A `translate-v2.json` row may carry a `site`
column to route that market into its own repo (a region-specific site), matching
the DA loc app. Meridian reads the source page from the base site and
writes/publishes each market into its configured target site, keeping a managed
manifest + hreflang index per site. The status radar and coverage dashboard scan
every routed site (not just the base). *Two follow-ups:* (1) a cross-site
market's staleness check compares against its own repo's source timestamp (which
isn't there), so a cross-site page reports `current`/`missing` correctly but never
`stale` — fixing it needs the base site's source timestamp threaded into the
target-site risk check; (2) hreflang is within-site, so cross-repo/cross-domain
reciprocal alternates are not yet emitted.

Meridian reads `/meridian/config.json` (`{ canonicalId, policies: [{ locale, requiredLayers }],
sourceLocale?, publishMode?, formality?, glossaries? }`)
and content under `/meridian/canon`, `/meridian/adapt/{locale}`, `/meridian/live/{locale}`.
Two ways to stand that up:

- **From scratch** — use the **New market** flow in the app's Adaptations tab:
  describe a market in a sentence, review the proposed policy, activate.
- **From an existing MSM site** — use the `migrate_ingest` MCP tool (or the migration
  on-ramp) to import a source doc + per-market copies into one canonical object plus
  typed adaptation sets, with no hand rebuild.

## Translation provider (pluggable)

The language layer is produced by a real machine-translation provider, proxied
through the Meridian worker so keys stay server-side (and browser CORS is a
non-issue). The worker's `/translate` endpoint resolves a provider in this order,
and a caller may force one via a `provider` field (`deepl` | `google` |
`microsoft` | `libre` | `free` | `auto`):

1. **DeepL** — set `wrangler secret put DEEPL_KEY` (recommended; free tier available).
2. **Google Cloud Translation** — set `GOOGLE_API_KEY`.
3. **Microsoft / Azure AI Translator** — set `MS_TRANSLATOR_KEY` (and
   `MS_TRANSLATOR_REGION` for a regional resource). A second keyed, synchronous
   provider proving the seam accepts any enterprise engine.
4. **LibreTranslate** — set `LIBRETRANSLATE_URL` (open-source, self-hostable, keyless).
5. **Keyless fallback** — used when nothing is set (rate-limited; fine for a demo).

### Terminology & tone (DeepL)

Two quality controls, read from `/meridian/config.json` and passed through only to
DeepL (other providers ignore them harmlessly):

- **`formality`** — `more` | `less` | `prefer_more` | `prefer_less`; brand tone per
  market.
- **`glossaries`** — a map of `"<from>:<to>"` → DeepL glossary id, applied per
  language pair to force brand/legal terminology. Build one from your terms with
  the worker's `POST /glossary` (`{ source, target, entries: { term: translation } }`
  → `{ glossaryId }`), then record it in `config.glossaries`.

**Bring your own engine / TMS:** the provider is the single extension point.
`core/translate.js` (`createTranslator`) is pluggable client-side, and the worker's
provider functions (`translateDeepL` / `translateGoogleV2` / `translateFree`) are the
server-side seam — add a `translate<Yours>` that calls your MT or TMS (Smartling,
Phrase, a private model) and wire it into `handleTranslate`. Only the **language**
layer is machine-translated; commercial/compliance stay human-owned (PRD §11), and
every machine result is quality-gated before publish.

## Staging → review → promote (how pages reach live)

The default flow has one path to production, so review is never skipped:

1. **Stage** — Translate/Localize always writes to the **sandbox** working area
   (`/meridian/live/{locale}/{ref}`): namespaced, collision-free, safe to iterate.
2. **Review** — side-by-side preview, the overlay segment editor, the coverage dashboard.
3. **Promote to live** — copy the *reviewed* page byte-for-byte to its clean,
   SEO-correct locale URL `/{locale}/{ref}` (e.g. `/fr/international-banking`).
   Two routes, both on the page's result row:
   - **Promote to live** — self-review, one click.
   - **Request approval** — a *different* reviewer approves in the **Approvals** tab
     (`store.promotePage` runs under the approver's own DA session). The governed,
     "nothing goes live without a named human" path.

The canonical object + adaptation layers always stay internal under `/meridian`;
only the *rendered page* is promoted. The live locale path is derived from DA's
`translate-v2.json` `location` convention.

**Advanced opt-out (no UI):** set `publishMode: 'locale-root'` in
`/meridian/config.json` and Translate/Localize publish **straight** to the live
locale URL, skipping the sandbox review step — for trusted-MT / automated pipelines
only. Omit it (default `sandbox`) for the staged flow above.

Guardrails on every write to a live locale path:

- **Collision guard.** Every Meridian page carries an ownership marker; in
  locale-root mode Meridian refuses to overwrite a target that exists and isn't
  Meridian-managed, so it never clobbers hand-authored `/{locale}/…` content.
- **Managed manifest.** `/meridian/managed.json` records what Meridian materialized
  (ref · locale · mode), so the coverage dashboard still enumerates localized pages
  once they live in the host tree.
- **hreflang.** Meridian publishes `/meridian/hreflang.json` (reciprocal alternate
  map per page cluster, with `x-default`). Add the one-line integration to the host
  site's `scripts.js` to inject `<link rel="alternate" hreflang>` on source and
  localized pages — no host content is mutated:

  ```js
  import injectHreflang from '/tools/apps/meridian/integration/hreflang.js';
  injectHreflang(); // safe to call unconditionally
  ```

## Invariant

Materialized variants are artifacts: delete `/meridian/live` and recompute from
`/meridian/canon` + `/meridian/adapt` → byte-identical output. Guarded by tests.

## Data model (what lives where in the DA source)

Everything Meridian owns is namespaced under `/meridian` in the target site so it
never collides with the host site's own content:

| Path | What |
| --- | --- |
| `/meridian/config.json` | Market policy set + options: `{ canonicalId, policies:[{locale, requiredLayers}], sourceLocale?, publishMode?, formality?, glossaries? }` |
| `/meridian/canon/…` | Canonical content objects (the single source per piece of content) |
| `/meridian/adapt/{locale}/…` | Typed per-market adaptation layers |
| `/meridian/live/{locale}/…` | Materialized variants + **sandbox** localized pages (the review staging area) |
| `/meridian/tm/{locale}.json` | Translation Memory (source→approved translation, content-addressed) |
| `/meridian/managed.json` | Manifest of every page Meridian materialized (`{ref, locale, mode, at}`) — drives the coverage dashboard's staged/live view |
| `/meridian/hreflang.json` | Reciprocal hreflang cluster index (published to the edge for the runtime injector) |
| `/meridian/promotions/{locale}/{ref}.json` | Pending promotion-approval requests |
| `/meridian/taste-queue/…`, `/meridian/rejections/…` | Gated variant recomputes + rejection records |
| `/{locale}/{ref}` *(live locale root)* | Promoted, production pages — the only content outside `/meridian`, always written through the collision guard |

Source pages (the English originals) are read from the host site's own tree
(`/{ref}`), never modified.

## Architecture notes

- **DA-native, no build step.** Browser ES modules + Lit (`da-lit`) + Adobe
  Spectrum 2, loaded straight from `da.live` via an import map — exactly like the
  DA team's own apps. `DA_SDK` supplies org/site/token; all DA I/O goes through the
  signed-in user's session (`daFetch`), so there is no service credential.
- **Pure engine, thin client.** `core/*` (except `store.js`) are pure functions
  with no network imports, so the localization/propagation/scoring logic is fully
  node-testable. `store.js` is the only DA-touching module and takes an injectable
  `fetchImpl` so its methods are testable with a fake transport.
- **Provider seam.** Client `createTranslator` → worker `/translate` → provider
  registry (`translateDeepL` / `translateGoogleV2` / `translateMicrosoft` /
  `translateLibre` / `translateFree`). Keys stay server-side; add a provider by
  writing one `translate<X>` and adding it to the registry.
- **Guardrails.** Path-traversal guards on every locale/ref (`SAFE_SEGMENT`);
  source-locale write refusal; ownership marker + collision guard on live writes;
  §11 — machine translates only the *language* layer, commercial/compliance stay
  human-owned and quality-gated before publish.

## Development

```sh
npm i
npm test                 # node --test — unit/integration (pure engine + store DI)
npm run lint             # eslint (Airbnb) + stylelint
npm run smoke            # end-to-end lifecycle smoke (no browser)
npm run license:check    # license headers
```

Worker (Cloudflare) — deployed separately from the app's DA code sync:

```sh
cd worker
npx wrangler deploy
npx wrangler secret put DEEPL_KEY          # optional: recommended MT provider
npx wrangler secret put MS_TRANSLATOR_KEY  # optional: + MS_TRANSLATOR_REGION
# GOOGLE_API_KEY / LIBRETRANSLATE_URL are also supported (see Translation provider)
```

Worker endpoints (all require the caller's DA `Authorization`; CORS allows the DA
app origins — `*.aem.live/.page` and `*.(preview|live).da.live`):

| Method · path | Purpose |
| --- | --- |
| `POST /translate` | `{ strings, from, to, org, site, provider?, formality?, glossaryId? }` → translations (provider chain; DeepL batched to its 50-text limit) |
| `POST /glossary` | `{ source, target, entries }` → `{ glossaryId }` (builds a DeepL glossary) |
| `GET /api/queue`, `POST /api/queue/approve|reject` | Variant taste-queue (gated publish) |

UI correctness is verified in the browser inside DA (per project rule), not only by
tests. Browser tests are run manually, never via the parallel runner.

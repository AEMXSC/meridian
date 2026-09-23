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
| Full-page app | `tools/apps/meridian/meridian.html` | Exposure queue · Taste queue · Adaptations (authoring + New-market setup) |
| Prepare-menu plugin | `tools/plugins/meridian/meridian.html` | Per-page exposure summary + deep-link into the app |
| Engine | `tools/apps/meridian/core/` | schemas · hash · materialize · exposure · scan · diff · propagate · scoring · classify · propose · migrate |
| MCP tools | `agents/` | `exposure_scan`, `propagation_plan/apply/rollback`, `locale_propose`, `migrate_ingest` |
| Queue worker | `worker/` | DA-backed taste-queue REST (approve/reject with IMS identity) |

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

## Publish mode & SEO (sandbox vs production)

Localized pages can publish two ways (toggle in the **Localize** tab, or default it
per site with `publishMode` in `/meridian/config.json`):

- **`sandbox`** (default) — pages go to `/meridian/live/{locale}/{ref}`. Namespaced,
  collision-free, ideal for demos and trials.
- **`locale-root`** (production) — pages go to a clean, SEO-correct URL:
  `/{locale}/{ref}` (e.g. `/fr/international-banking`). The canonical object and
  adaptation layers still stay internal under `/meridian`; only the *rendered page*
  moves. Publish target for each market is derived from DA's `translate-v2.json`
  `location` convention.

Guardrails that ship with production mode:

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

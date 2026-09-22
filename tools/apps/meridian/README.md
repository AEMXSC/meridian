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

Meridian reads `/meridian/config.json` (`{ canonicalId, policies: [{ locale, requiredLayers }] }`)
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
and a caller may force one via a `provider` field (`deepl` | `google` | `free` |
`auto`):

1. **DeepL** — set `wrangler secret put DEEPL_KEY` (recommended; free tier available).
2. **Google Cloud Translation** — set `GOOGLE_API_KEY`.
3. **Keyless fallback** — used when no key is set (rate-limited; fine for a demo).

**Bring your own engine / TMS:** the provider is the single extension point.
`core/translate.js` (`createTranslator`) is pluggable client-side, and the worker's
provider functions (`translateDeepL` / `translateGoogleV2` / `translateFree`) are the
server-side seam — add a `translate<Yours>` that calls your MT or TMS (Smartling,
Phrase, a private model) and wire it into `handleTranslate`. Only the **language**
layer is machine-translated; commercial/compliance stay human-owned (PRD §11), and
every machine result is quality-gated before publish.

## Invariant

Materialized variants are artifacts: delete `/meridian/live` and recompute from
`/meridian/canon` + `/meridian/adapt` → byte-identical output. Guarded by tests.

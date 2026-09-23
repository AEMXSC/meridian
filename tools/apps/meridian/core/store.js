/*
 * Copyright 2026 Adobe Systems Incorporated
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-disable import/no-unresolved */

// The content source (PRD §7.1–7.2): canonical, adaptation layers, and
// materialized variants live as JSON files in a real DA project, under a
// scoped base path (default /meridian) so nothing collides with the host
// site's own content. Reads/writes go through MSM's shared daFetch, so all
// requests are authenticated against the signed-in DA user — the same client
// the DA team's own apps use.

import { daFetch, DA_ORIGIN, AEM_ADMIN } from '../../msm/core/fetch.js';
import { getPageTimestamp, getPageStatus, getStatusConfig } from '../../msm/core/status.js';
import { previewPage, publishPage } from '../../msm/core/operations.js';
import { upsertRows, readSheet } from './da-config.js';
import { parseLocaleConfig } from './locale-config.js';
import {
  markManaged, overwriteBlocked, publishRelPath, buildHreflangIndex,
} from './managed.js';
import runWithConcurrency from './concurrency.js';

// A single path segment: letters, digits, underscore, hyphen. No dots (blocks
// `..` traversal), no slashes, no empties. Applied to locale and to every
// segment of a canonicalId so a crafted value can never escape the /meridian
// base and clobber the host site's own content.
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertLocale(locale) {
  if (typeof locale !== 'string' || !SAFE_SEGMENT.test(locale)) {
    throw new Error(`Unsafe locale: ${JSON.stringify(locale)}`);
  }
}

function assertCanonicalId(id) {
  if (typeof id !== 'string' || !id.startsWith('canon/')
    || id.split('/').some((seg) => !SAFE_SEGMENT.test(seg))) {
    throw new Error(`Unsafe canonicalId: ${JSON.stringify(id)}`);
  }
}

// org/site flow straight into admin.da.live URLs; validate them the same way as
// a path segment so a crafted value (e.g. "../other") can't escape the site.
export function assertSiteRef(org, site) {
  if (typeof org !== 'string' || !SAFE_SEGMENT.test(org)) {
    throw new Error(`Unsafe org: ${JSON.stringify(org)}`);
  }
  if (typeof site !== 'string' || !SAFE_SEGMENT.test(site)) {
    throw new Error(`Unsafe site: ${JSON.stringify(site)}`);
  }
}

// A page reference is a site path of safe segments ("international-banking",
// "student/checking"), with or without a leading slash / .html. Validated the
// same way so a localized page can never escape its locale folder.
export function assertPageRef(ref) {
  const segs = typeof ref === 'string'
    ? ref.replace(/^\/+/, '').replace(/\.html$/, '').split('/')
    : [];
  if (!segs.length || segs.some((seg) => !SAFE_SEGMENT.test(seg))) {
    throw new Error(`Unsafe page ref: ${JSON.stringify(ref)}`);
  }
  return segs.join('/');
}

/** canonicalId always starts with "canon/"; the tail is the path reused under adapt/live. */
function relPath(canonicalId) {
  return canonicalId.replace(/^canon\//, '');
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Pure, validated path builders — exported so their traversal guards are
// unit-testable without a live DA project.
export function canonPath(base, id) {
  assertCanonicalId(id);
  return `${base}/${id}.json`;
}

export function adaptPath(base, locale, id) {
  assertLocale(locale);
  assertCanonicalId(id);
  return `${base}/adapt/${locale}/${relPath(id)}.json`;
}

export function livePath(base, locale, id) {
  assertLocale(locale);
  assertCanonicalId(id);
  return `${base}/live/${locale}/${relPath(id)}.json`;
}

// A localized full page (real HTML). In 'sandbox' mode it is materialized under
// the scoped base ({base}/live/{locale}/{ref}.html) so it never collides with the
// host site's own content; in 'locale-root' mode it publishes to a clean,
// SEO-correct URL (/{locale}/{ref}.html). See core/managed.js:publishRelPath.
export function localePagePath(base, locale, ref, mode = 'sandbox') {
  assertLocale(locale);
  const clean = assertPageRef(ref);
  return `${publishRelPath(mode, locale, clean, base)}.html`;
}

// Translation Memory lives once per locale at the site level (shared across all
// pages), so an identical segment is translated once and reused everywhere.
export function tmPath(base, locale) {
  assertLocale(locale);
  return `${base}/tm/${locale}.json`;
}

// Exposure over a REAL localized page: is the published localized page current
// with its English source, stale (source changed after it), or not yet made?
// Pure so the decision is unit-testable; the timestamps come from getPageTimestamp.
export function pageRiskState(source, localized) {
  // Accept epoch ms OR a raw Last-Modified header string — compare
  // CHRONOLOGICALLY, never lexicographically (RFC1123 weekday prefixes don't
  // sort by date). Mirrors msm/core/status.js's toTime conversion.
  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const sourceMs = toMs(source);
  const localizedMs = toMs(localized);
  if (!localizedMs) return 'missing';
  if (sourceMs && sourceMs > localizedMs) return 'stale';
  return 'current';
}

// Extract do-not-translate terms from DA's localization config
// (/.da/translate.json `dnt-content-rules` sheet). Pure + tolerant of the
// column name (DA loc sheets vary): prefer a term-ish column, else the first
// non-empty string cell in the row. De-duplicated.
export function dntTerms(translateDoc) {
  const rows = readSheet(translateDoc, 'dnt-content-rules');
  const PREFERRED = ['term', 'content', 'text', 'phrase', 'value', 'word', 'name'];
  const terms = [];
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    // Respect an explicit term-ish column when the row has one (even if empty —
    // an empty term means "no term", not "grab some other column"). Only fall
    // back to the first string cell when no term column is present at all.
    const hasTermKey = PREFERRED.some((k) => k in row);
    const pick = PREFERRED.map((k) => row[k]).find((v) => typeof v === 'string' && v.trim())
      || (hasTermKey ? null : Object.values(row).find((v) => typeof v === 'string' && v.trim()));
    if (pick) terms.push(pick.trim());
  });
  return [...new Set(terms)];
}

export function queuePath(base, locale, id) {
  assertLocale(locale);
  assertCanonicalId(id);
  return `${base}/taste-queue/${locale}/${relPath(id)}.json`;
}

export function rejectionPath(base, locale, id) {
  assertLocale(locale);
  assertCanonicalId(id);
  return `${base}/rejections/${locale}/${relPath(id)}.json`;
}

// List the sites (top-level folders) in an org via the DA list API, so the app's
// picker can offer every site in the org — not a hardcoded one. Authenticated
// through the signed-in user's daFetch. Mirrors config-console's fetchSiteList.
export async function listSites(org) {
  if (!org || !SAFE_SEGMENT.test(org)) return [];
  try {
    const resp = await daFetch(`${DA_ORIGIN}/list/${org}/`, { cache: 'no-store' });
    if (!resp.ok) return [];
    const items = await resp.json();
    if (!Array.isArray(items)) return [];
    return items.filter((item) => !item.ext).map((item) => item.name);
  } catch {
    return [];
  }
}

// List the orgs the signed-in user can access via the DA list API (no org
// segment), so the scope picker can offer every org — not just recently-used
// ones. Best-effort: any failure (or an unexpected shape) yields [] and callers
// fall back to the recents datalist.
export async function listOrgs() {
  try {
    const resp = await daFetch(`${DA_ORIGIN}/list`, { cache: 'no-store' });
    if (!resp.ok) return [];
    const items = await resp.json();
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && item.name && !item.ext).map((item) => item.name);
  } catch {
    return [];
  }
}

// Shape one raw DA list entry into a page-tree node: { name, path, ext, isFolder }.
// Pure (no network) so the normalization — extension detection and the
// folders-have-no-extension rule — is unit-testable without a live DA project.
// `prefix` is the "/org/site" segment stripped off item.path so the returned
// path is site-relative (leading slash, no org/site prefix). A folder has no
// file extension, so ext is '' and isFolder is true.
export function shapeListNode(item, prefix = '') {
  const ext = item.ext
    || (item.name && item.name.includes('.') ? item.name.split('.').pop() : '');
  let path = item.path || '';
  if (prefix && path.startsWith(prefix)) path = path.substring(prefix.length) || '/';
  return {
    name: item.name, path, ext, isFolder: !ext,
  };
}

export default class DaStore {
  #org;

  #site;

  #base;

  #sourceLocale;

  #fetch;

  constructor({
    org, site, base = '/meridian', sourceLocale = 'en', fetchImpl = daFetch,
  }) {
    assertSiteRef(org, site);
    this.#org = org;
    this.#site = site;
    this.#base = base.replace(/\/$/, '');
    this.#sourceLocale = sourceLocale;
    // Injectable so instance methods (guards, collision check, manifest) are
    // unit-testable with a fake DA transport; defaults to the shared daFetch.
    this.#fetch = fetchImpl;
  }

  get sourceLocale() {
    return this.#sourceLocale;
  }

  // The source language is the site's own pages, not a market — refuse to write
  // or publish it as a localized variant so Meridian can never overwrite the real
  // source page (which lives at the site root, outside the /meridian namespace).
  #assertNotSource(locale) {
    if (locale === this.#sourceLocale) {
      throw new Error(`Refusing to localize into the source locale (${locale}) — that is the source page itself, not a market.`);
    }
  }

  #sourceUrl(path) {
    return `${DA_ORIGIN}/source/${this.#org}/${this.#site}${path}`;
  }

  #canonPath(id) {
    return canonPath(this.#base, id);
  }

  #adaptPath(locale, canonicalId) {
    return adaptPath(this.#base, locale, canonicalId);
  }

  #livePath(locale, canonicalId) {
    return livePath(this.#base, locale, canonicalId);
  }

  // Distinguish a genuine 404 (return null) from auth/server errors (throw),
  // so a 401/500 is never silently reported as "not found" — matching MSM's
  // status-carrying error convention in core/operations.js.
  async #readJson(path) {
    const resp = await this.#fetch(this.#sourceUrl(path), { cache: 'no-store' });
    if (resp.ok) return resp.json();
    if (resp.status === 404) return null;
    throw new Error(`Read failed for ${path} (${resp.status})`);
  }

  async #writeJson(path, value) {
    const body = new FormData();
    body.append('data', new Blob([serialize(value)], { type: 'application/json' }));
    const resp = await this.#fetch(this.#sourceUrl(path), { method: 'PUT', body });
    if (!resp.ok) throw new Error(`Write failed for ${path} (${resp.status})`);
  }

  // The market policy set for a scan: { canonicalId, policies[] }. Lives at
  // {base}/config.json, authored alongside the content.
  readConfig() {
    return this.#readJson(`${this.#base}/config.json`);
  }

  writeConfig(config) {
    return this.#writeJson(`${this.#base}/config.json`, config);
  }

  // DA's native localization config (/.da/translate.json) — read so Meridian's
  // setup surface can show the languages + do-not-translate rules DA already
  // knows, and register a new market's language there so Meridian complements
  // DA's built-in translation rather than competing with it. Lives at the site
  // root (not under the Meridian base). Absent → null.
  readTranslateConfig() {
    return this.#readJson('/.da/translate.json');
  }

  // The site's do-not-translate terms (brand/legal), read from DA's own loc
  // config so the quality gate enforces them — a machine translation that alters
  // a protected term is held for human review, never published. Empty on absence.
  async readDnt() {
    return dntTerms(await this.readTranslateConfig());
  }

  // DA's newer localization config (/.da/translate-v2.json) — the one the
  // official DA localization app reads. Absent → null. Lives at the site root
  // (not under the Meridian base), same as translate.json.
  readLocaleConfigDoc() {
    return this.#readJson('/.da/translate-v2.json');
  }

  // The configured target markets for this site, normalized to Meridian locale
  // tokens + region groups (see core/locale-config.js). Empty catalog when the
  // site has no translate-v2.json, so callers can always fall back to folder
  // discovery.
  async localeCatalog() {
    return parseLocaleConfig(await this.readLocaleConfigDoc());
  }

  // The localization risk radar for one page across markets: compares the
  // English source's edge timestamp to each localized page's, so an author sees
  // which markets are current, stale (source moved), or not yet localized —
  // exposure over the real published pages. Reuses MSM's getPageTimestamp.
  async pageRisk(ref, locales, mode = 'sandbox') {
    const clean = assertPageRef(ref);
    const src = await getPageTimestamp(this.#org, this.#site, `/${clean}`, 'html').catch(() => ({}));
    const sourceMs = src?.lastModified ?? null;
    return Promise.all(locales.map(async (locale) => {
      assertLocale(locale);
      const path = localePagePath(this.#base, locale, clean, mode).replace(/\.html$/, '');
      const ts = await getPageTimestamp(this.#org, this.#site, path, 'html').catch(() => ({}));
      return { locale, state: pageRiskState(sourceMs, ts?.lastModified ?? null) };
    }));
  }

  // ---- Managed-page manifest + hreflang index -------------------------------

  // The list of pages Meridian has materialized (ref + locale + publish mode),
  // the enumeration source for the dashboard once pages publish to clean locale
  // roots (where folder-walking /meridian/live no longer finds them). [] when
  // absent.
  async readManaged() {
    const doc = await this.#readJson(`${this.#base}/managed.json`);
    return Array.isArray(doc?.entries) ? doc.entries : [];
  }

  // Upsert managed entries (call ONCE per publish batch — read-modify-write is
  // not safe under concurrency), then rebuild + publish the hreflang index so
  // pages can fetch /meridian/hreflang.json from the edge. The manifest write
  // happens first and is what matters; a later hreflang failure throws for the
  // caller to log without having lost the manifest (the page is already live).
  async recordManaged(entries) {
    if (!entries?.length) return;
    const key = (e) => `${e.locale}|${e.ref}`;
    const map = new Map((await this.readManaged()).map((e) => [key(e), e]));
    entries.forEach((e) => map.set(key(e), {
      ref: assertPageRef(e.ref), locale: e.locale, mode: e.mode || 'sandbox', at: Date.now(),
    }));
    const next = [...map.values()];
    await this.#writeJson(`${this.#base}/managed.json`, { entries: next });
    await this.#writeJson(`${this.#base}/hreflang.json`, { clusters: buildHreflangIndex(next, this.#sourceLocale) });
    // Publish the index so runtime pages can read it same-origin on the edge.
    // Throw on failure (the caller — saveManaged — logs it best-effort) rather
    // than silently leaving a stale edge index.
    const idx = `${this.#base}/hreflang`;
    const prev = await previewPage(this.#org, this.#site, idx, 'json');
    if (prev.error) throw new Error(`hreflang preview failed: ${prev.error}`);
    const pub = await publishPage(this.#org, this.#site, idx, 'json');
    if (pub.error) throw new Error(`hreflang publish failed: ${pub.error}`);
  }

  async registerLanguage(locale, name) {
    const doc = await this.#readJson('/.da/translate.json');
    // Preserve every sibling sheet (config, dnt-content-rules, …); only upsert
    // this locale into the languages sheet. Columns follow DA loc convention.
    const next = upsertRows(
      doc,
      'languages',
      [{ locale, language: name || locale, action: 'translate' }],
      'locale',
    );
    await this.#writeJson('/.da/translate.json', next);
  }

  async readCanonical(id) {
    const c = await this.#readJson(this.#canonPath(id));
    if (!c) throw new Error(`Canonical not found: ${id}`);
    return c;
  }

  writeCanonical(canonical) {
    return this.#writeJson(this.#canonPath(canonical.id), canonical);
  }

  readLayer(locale, canonicalId) {
    return this.#readJson(this.#adaptPath(locale, canonicalId));
  }

  writeLayer(layer) {
    return this.#writeJson(this.#adaptPath(layer.locale, layer.canonicalId), layer);
  }

  readVariant(locale, canonicalId) {
    return this.#readJson(this.#livePath(locale, canonicalId));
  }

  // The variant's real edge state (reusing MSM's lag-tolerant publish check):
  // compares the DA source Last-Modified against AEM preview/live timestamps so
  // the queue can show what is actually current on the edge, not just whether
  // the derived hash matches. Returns an { name, color, tip } status config.
  async variantEdgeStatus(locale, canonicalId) {
    const path = this.#livePath(locale, canonicalId).replace(/\.json$/, '');
    const { lastModified } = await getPageTimestamp(this.#org, this.#site, path, 'json');
    const { previewState, liveState } = await getPageStatus(this.#org, this.#site, path, lastModified, 'json');
    return getStatusConfig({
      isDetached: false, outOfSync: false, previewState, liveState,
    });
  }

  writeVariant(variant) {
    return this.#writeJson(this.#livePath(variant.locale, variant.canonicalId), variant);
  }

  async deleteVariant(locale, canonicalId) {
    const resp = await this.#fetch(this.#sourceUrl(this.#livePath(locale, canonicalId)), { method: 'DELETE' });
    if (!resp.ok && resp.status !== 404) throw new Error(`Delete failed (${resp.status})`);
  }

  // Push a materialized variant to the edge: preview then publish via AEM Admin,
  // so "materialize to the edge" is literally true. Throws on failure so the
  // caller can record it. Reuses MSM's preview/publish primitives.
  async publishVariant(locale, canonicalId) {
    const path = this.#livePath(locale, canonicalId).replace(/\.json$/, '');
    const prev = await previewPage(this.#org, this.#site, path, 'json');
    if (prev.error) throw new Error(`Preview failed for ${locale}: ${prev.error}`);
    const pub = await publishPage(this.#org, this.#site, path, 'json');
    if (pub.error) throw new Error(`Publish failed for ${locale}: ${pub.error}`);
  }

  // Remove a variant from the edge (used by rollback when a market had no prior
  // variant). Deletes the live then preview rendition; a 404 is fine (nothing
  // to remove).
  async unpublishVariant(locale, canonicalId) {
    const path = `${this.#livePath(locale, canonicalId).replace(/\.json$/, '')}.json`;
    const del = async (kind) => {
      const resp = await this.#fetch(`${AEM_ADMIN}/${kind}/${this.#org}/${this.#site}/main${path}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 404) throw new Error(`Un${kind === 'live' ? 'publish' : 'preview'} failed for ${locale} (${resp.status})`);
    };
    await del('live');
    await del('preview');
  }

  // ---- Real-page localization (whole EDS pages, not just JSON variants) -----

  // Distinguish a genuine 404 (null) from auth/server errors (throw), same as
  // #readJson, but for raw page HTML.
  async #readText(path) {
    const resp = await this.#fetch(this.#sourceUrl(path), { cache: 'no-store' });
    if (resp.ok) return resp.text();
    if (resp.status === 404) return null;
    throw new Error(`Read failed for ${path} (${resp.status})`);
  }

  // The real English page's source HTML — the canonical for a whole-page
  // localization. `ref` is a site path ("/international-banking"), NOT scoped to
  // the Meridian base, because the source of truth is the host site's own page.
  async readPageHtml(ref) {
    const clean = assertPageRef(ref);
    const html = await this.#readText(`/${clean}.html`);
    if (html == null) throw new Error(`Page not found: /${clean}`);
    return html;
  }

  // Write a localized page (real HTML). In locale-root mode this targets the
  // host site's own tree, so guard against clobbering a hand-authored page: only
  // overwrite a target that is absent or already Meridian-managed. Every page we
  // write is stamped with the ownership marker so that check works next time.
  async writeLocalizedPage(locale, ref, html, mode = 'sandbox') {
    this.#assertNotSource(locale);
    const path = localePagePath(this.#base, locale, ref, mode);
    if (mode === 'locale-root') {
      const existing = await this.#readText(path);
      if (overwriteBlocked(existing, mode)) {
        throw new Error(`${path.replace(/\.html$/, '')} already exists and isn't managed by Meridian — refusing to overwrite. Remove it, or publish in Sandbox mode.`);
      }
    }
    const body = new FormData();
    body.append('data', new Blob([markManaged(html)], { type: 'text/html' }));
    const resp = await this.#fetch(this.#sourceUrl(path), { method: 'PUT', body });
    if (!resp.ok) throw new Error(`Write failed for ${path} (${resp.status})`);
    return path;
  }

  // Push a localized page to the edge (preview then publish) and return the real
  // live URL a visitor can open in that language.
  async publishLocalizedPage(locale, ref, mode = 'sandbox') {
    this.#assertNotSource(locale);
    const path = localePagePath(this.#base, locale, ref, mode).replace(/\.html$/, '');
    const prev = await previewPage(this.#org, this.#site, path, 'html');
    if (prev.error) throw new Error(`Preview failed for ${locale}: ${prev.error}`);
    const pub = await publishPage(this.#org, this.#site, path, 'html');
    if (pub.error) throw new Error(`Publish failed for ${locale}: ${pub.error}`);
    return {
      path,
      previewUrl: `https://main--${this.#site}--${this.#org}.aem.page${path}`,
      liveUrl: `https://main--${this.#site}--${this.#org}.aem.live${path}`,
    };
  }

  // ---- Translation Memory ---------------------------------------------------

  // The locale's TM (source segment -> approved translation), or a fresh empty
  // one when the site has none yet.
  async readTm(locale) {
    const doc = await this.#readJson(tmPath(this.#base, locale));
    return doc || { locale, entries: {} };
  }

  writeTm(tm) {
    return this.#writeJson(tmPath(this.#base, tm.locale), tm);
  }

  // ---- Localization dashboard (coverage matrix over real pages) -------------

  // The locales that have any localized content (folders under {base}/live).
  async listLocales() {
    const nodes = await this.listPages(`${this.#base}/live`).catch(() => []);
    return nodes.filter((n) => n.isFolder).map((n) => n.name);
  }

  // Every localized page ref under one locale (recursive), site-relative and
  // without the {base}/live/{locale} prefix or .html.
  async #localizedRefs(locale) {
    const base = `${this.#base}/live/${locale}`;
    const out = [];
    const walk = async (path) => {
      const nodes = await this.listPages(path).catch(() => []);
      const folders = [];
      nodes.forEach((n) => {
        if (n.isFolder) folders.push(n.path);
        else out.push(n.path.slice(base.length + 1).replace(/\.html$/, ''));
      });
      await runWithConcurrency(folders.map((f) => () => walk(f)), 4);
    };
    await walk(base);
    return out;
  }

  // Every real .html page on the site (recursive, site-relative refs, no .html),
  // for the page-search box. Skips the Meridian base (our own artifacts) and
  // dot-folders. Small sites only — fine to walk on demand.
  async allPages() {
    const out = [];
    const walk = async (path) => {
      const nodes = await this.listPages(path).catch(() => []);
      const folders = [];
      nodes.forEach((n) => {
        if (n.isFolder) {
          if (n.path !== this.#base && !n.name.startsWith('.')) folders.push(n.path);
        } else {
          out.push(n.path.replace(/^\/+/, '').replace(/\.html$/, ''));
        }
      });
      await runWithConcurrency(folders.map((f) => () => walk(f)), 4);
    };
    await walk('');
    return [...new Set(out)].sort();
  }

  // The coverage matrix: every localized page (rows) × the given locales
  // (columns), each cell current / stale / missing. The portfolio "radar".
  // `opts.refs` supplies the page list explicitly (from the managed manifest in
  // locale-root mode, where folder-walking /meridian/live no longer finds them);
  // absent, it discovers them from the sandbox tree. `opts.mode` selects the cell
  // path (sandbox vs locale-root).
  async localizedMatrix(locales, opts = {}) {
    const mode = opts.mode || 'sandbox';
    let { refs } = opts;
    if (!refs) {
      const refSet = new Set();
      await runWithConcurrency(locales.map((loc) => async () => {
        assertLocale(loc);
        (await this.#localizedRefs(loc)).forEach((r) => refSet.add(r));
      }), 4);
      refs = [...refSet];
    }
    refs = [...new Set(refs)].sort();
    // Bound the N pages × M locales timestamp lookups so a big site can't fire
    // hundreds of DA requests at once (reuses MSM's concurrency limiter).
    const srcMs = new Map();
    const cellMs = new Map(); // `${ref}|${loc}` -> lastModified
    const tasks = [];
    refs.forEach((ref) => {
      const clean = assertPageRef(ref);
      tasks.push(async () => {
        const src = await getPageTimestamp(this.#org, this.#site, `/${clean}`, 'html').catch(() => ({}));
        srcMs.set(ref, src?.lastModified ?? null);
      });
      locales.forEach((loc) => tasks.push(async () => {
        const path = localePagePath(this.#base, loc, clean, mode).replace(/\.html$/, '');
        const ts = await getPageTimestamp(this.#org, this.#site, path, 'html').catch(() => ({}));
        cellMs.set(`${ref}|${loc}`, ts?.lastModified ?? null);
      }));
    });
    await runWithConcurrency(tasks, 6);
    return refs.map((ref) => ({
      ref: assertPageRef(ref),
      cells: locales.map((loc) => {
        const at = cellMs.get(`${ref}|${loc}`);
        return {
          locale: loc,
          state: pageRiskState(srcMs.get(ref), at),
          at: at ?? null,
        };
      }),
    }));
  }

  // Taste queue: a gated recompute waiting on human judgement (PRD §6). One
  // pending item per locale+canonical, keyed the same way as a live variant.
  writeQueueItem(item) {
    return this.#writeJson(queuePath(this.#base, item.locale, item.canonicalId), item);
  }

  readQueueItem(locale, canonicalId) {
    return this.#readJson(queuePath(this.#base, locale, canonicalId));
  }

  // Walk the taste-queue folder and return every pending item. A 404 means the
  // folder doesn't exist yet (empty queue); any other non-OK status throws so an
  // auth/server error is never silently reported as an empty queue — same
  // 404-vs-error convention as #readJson.
  async listQueue() {
    const items = [];
    const walk = async (path) => {
      const resp = await this.#fetch(`${DA_ORIGIN}/list/${this.#org}/${this.#site}${path}`, { cache: 'no-store' });
      if (resp.status === 404) return;
      if (!resp.ok) throw new Error(`Queue list failed for ${path} (${resp.status})`);
      const entries = await resp.json();
      if (!Array.isArray(entries)) return;
      await Promise.all(entries.map(async (entry) => {
        const isFolder = !entry.ext && !entry.name.includes('.');
        const child = `${path}/${entry.name}`;
        if (isFolder) {
          await walk(child);
        } else if (entry.name.endsWith('.json')) {
          const item = await this.#readJson(child);
          if (item) items.push(item);
        }
      }));
    };
    await walk(`${this.#base}/taste-queue`);
    return items;
  }

  // Enumerate a site folder for a UI page-tree: the folders and .html pages at
  // `path` (site-relative, default site root). Uses the DA list API through the
  // signed-in user's daFetch, mirroring listSites/MSM's listFolder. A 404 means
  // the folder doesn't exist yet → []; any other non-OK status throws so an
  // auth/server error is never silently reported as an empty tree (same
  // 404-vs-error convention as #readJson). Each non-empty path segment is
  // validated the same way as a page ref so a crafted value can't escape the
  // site. Results keep only folders and .html pages, folders first then
  // alphabetical.
  async listPages(path = '') {
    const trimmed = typeof path === 'string' ? path.replace(/^\/+/, '').replace(/\/+$/, '') : '';
    const segs = trimmed ? trimmed.split('/') : [];
    if (segs.some((seg) => !SAFE_SEGMENT.test(seg))) {
      throw new Error(`Unsafe path: ${JSON.stringify(path)}`);
    }
    const rel = segs.length ? `/${segs.join('/')}` : '';
    const resp = await this.#fetch(`${DA_ORIGIN}/list/${this.#org}/${this.#site}${rel}`, { cache: 'no-store' });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`Read failed (${resp.status})`);
    const items = await resp.json();
    if (!Array.isArray(items)) return [];
    const prefix = `/${this.#org}/${this.#site}`;
    return items
      .map((item) => shapeListNode(item, prefix))
      .filter((node) => node.isFolder || node.ext === 'html')
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  // Persist a rejection record so the human's stated reason is auditable even
  // after the pending queue entry is removed (PRD §6 reject-with-reason).
  writeRejection(record) {
    return this.#writeJson(
      rejectionPath(this.#base, record.locale, record.canonicalId),
      record,
    );
  }

  async removeQueueItem(locale, canonicalId) {
    const resp = await this.#fetch(
      this.#sourceUrl(queuePath(this.#base, locale, canonicalId)),
      { method: 'DELETE' },
    );
    if (!resp.ok && resp.status !== 404) throw new Error(`Delete failed (${resp.status})`);
  }
}

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
/* eslint-disable no-underscore-dangle, import/no-unresolved, no-console, class-methods-use-this */
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { LitElement, html, nothing } from 'da-lit';
import DaStore, { listSites, listOrgs, assertPageRef } from './core/store.js';
import scanCanonical from './core/scan.js';
import variantStatus from './core/variant-status.js';
import { diffVariants, onlyChanges } from './core/diff.js';
import { materialize } from './core/materialize.js';
import createClassifier from './core/classify.js';
import createArchitect from './core/propose.js';
import { readSheet } from './core/da-config.js';
import runWithConcurrency from './core/concurrency.js';
import { LAYER_PRECEDENCE } from './core/schemas.js';
import { createTranslator } from './core/translate.js';
import { humanizeSlug, chooseSlug } from './core/slug.js';
import { localizePage, applyLocalization, hasPendingOverrides } from './core/localize-page.js';
import { createTmTranslator, record as tmRecord, lookup as tmLookup } from './core/tm.js';
import { icon } from '../msm/core/icons.js';
import { daFetch } from '../msm/core/fetch.js';
import 'https://da.live/nx/public/sl/components.js';
import './shared/tabs/tabs.js';
import './shared/card/card.js';
import './shared/popover/popover.js';

const NX = 'https://da.live/nx';
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const OPERATIONS = ['translate', 'override', 'insert', 'fork'];
const classify = createClassifier();
const architect = createArchitect();

let sl = null;
let tokens = null;
let styles = null;
try {
  const { default: getStyle } = await import(`${NX}/utils/styles.js`);
  [sl, tokens, styles] = await Promise.all([
    getStyle(`${NX}/public/sl/styles.css`),
    getStyle(new URL('./styles/spectrum2.css', import.meta.url).href),
    getStyle(import.meta.url),
  ]);
} catch (e) {
  console.warn('Failed to load styles:', e);
}

// Deep-link org/site so an author arriving from the editor plugin never
// re-enters context (the annoyance called out in the Experience Workspace demo).
const TABS = ['overview', 'pages', 'exposure', 'taste', 'adapt'];

// Plain-language one-liners for the jargon-y queue tabs (shown under the tabs).
const TAB_HELP = {
  exposure: 'Where markets are out of date, missing required content, or drifting from the source.',
  taste: 'Machine changes waiting for your approval before they go live.',
};

// Common target languages offered as quick-pick chips (code + label). Used only
// as a fallback when the site has no DA locale config (/.da/translate-v2.json).
const LANG_OPTIONS = [
  ['es', 'Spanish'], ['it', 'Italian'], ['fr', 'French'], ['de', 'German'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese'], ['zh', 'Chinese'],
  ['ko', 'Korean'], ['ar', 'Arabic'],
];

// Business-readable labels for the freshness states (the internal tokens stay
// current/stale/missing). Aligned to the vocabulary the official DA loc app
// uses so Meridian feels native next to it.
const RISK_LABEL = { current: 'Live', stale: 'Update due', missing: 'Not localized' };
const RISK_TIP = {
  current: 'Localized page is published and up to date with the source.',
  stale: 'Source changed after this market was localized — re-localize to refresh.',
  missing: 'This market has no localized page yet.',
};

// A raw Last-Modified value (epoch ms or an RFC1123 header string) → a short
// human date for a status tooltip, or '' when unknown.
function formatWhen(value) {
  if (value == null) return '';
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Render one coverage cell along both axes — stage (live/staged/none) and
// freshness (stale) — into a label + chip class + tooltip.
function cellDisplay(c) {
  const when = c.at ? ` (${formatWhen(c.at)})` : '';
  if (c.stage === 'none') return { label: '—', cls: 'missing', tip: 'Not localized' };
  if (c.stage === 'staged') {
    return c.fresh === 'stale'
      ? { label: 'Staged ⚠', cls: 'stale', tip: `Staged in sandbox; source changed since${when} — re-localize before promoting` }
      : { label: 'Staged', cls: 'staged', tip: `Reviewed in sandbox — awaiting promotion${when}` };
  }
  return c.fresh === 'stale'
    ? { label: 'Update due', cls: 'stale', tip: `Live, but source changed since${when} — re-localize + promote` }
    : { label: 'Live', cls: 'current', tip: `Promoted & live${when}` };
}

function parseDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const tab = (params.get('tab') || '').trim();
  return {
    org: (params.get('org') || '').trim(),
    site: (params.get('site') || '').trim(),
    tab: TABS.includes(tab) ? tab : 'overview',
    // Arriving from the editor plugin's reference panel: prefill a page + market
    // so the author lands on Pages already scoped, never re-entering context.
    page: (params.get('page') || '').trim().replace(/^\/+/, '').replace(/\.html$/, ''),
    market: (params.get('market') || '').trim(),
  };
}

// Render an adaptation entry's value for the editor textarea: objects as pretty
// JSON, strings verbatim, absent as empty.
function entryValueString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// TM leverage: percent of segments served from Translation Memory (vs sent to
// the provider) — the cost/consistency win, surfaced in the result badge.
function tmLeverage({ hits, misses }) {
  const total = hits + misses;
  return total ? Math.round((hits / total) * 100) : 0;
}

class MeridianApp extends LitElement {
  static properties = {
    context: { attribute: false },
    _state: { state: true },
    _org: { state: true },
    _site: { state: true },
    _findings: { state: true },
    _error: { state: true },
    _diffs: { state: true },
    _loadingDiffs: { state: true },
    _tab: { state: true },
    _queue: { state: true },
    _promotions: { state: true },
    _queueBusy: { state: true },
    _rejectingKey: { state: true },
    _layers: { state: true },
    _editing: { state: true },
    _adaptBusy: { state: true },
    _suggest: { state: true },
    _confirmKey: { state: true },
    _proposing: { state: true },
    _proposal: { state: true },
    _config: { state: true },
    _sites: { state: true },
    _orgs: { state: true },
    _recent: { state: true },
    _translate: { state: true },
    _catalog: { state: true },
    _publishMode: { state: true },
    _edge: { state: true },
    _pageRef: { state: true },
    _pageResults: { state: true },
    _pageBusy: { state: true },
    _pageBusyMsg: { state: true },
    _pageError: { state: true },
    _localizeDrafts: { state: true },
    _localeSel: { state: true },
    _browseOpen: { state: true },
    _pageTree: { state: true },
    _pageExpanded: { state: true },
    _previewOpen: { state: true },
    _compareSource: { state: true },
    _rowMenu: { state: true },
    _pageRisk: { state: true },
    _toast: { state: true },
    _matrix: { state: true },
    _matrixLocales: { state: true },
    _matrixBusy: { state: true },
    _allPages: { state: true },
    _treeQuery: { state: true },
    _selectedPages: { state: true },
    _managed: { state: true },
    _translateSlug: { state: true },
    _bulkResults: { state: true },
    _segEditOpen: { state: true },
    _overlayLocale: { state: true },
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sl, tokens, styles].filter(Boolean);
    this._state = 'init';
    this._org = this._org || '';
    this._site = this._site || '';
    this._findings = [];
    this._diffs = new Map();
    this._loadingDiffs = new Set();
    this._error = '';
    const deepLink = parseDeepLink();
    this._tab = deepLink.tab;
    // Consumed once, on the first scan, then cleared so later manual scans /
    // site switches reset cleanly instead of snapping back to the plugin's page.
    this._deepPage = deepLink.page;
    this._deepMarket = deepLink.market;
    this._queue = [];
    this._promotions = [];
    // Promotion requests we just wrote but DA's /list index may not reflect yet
    // (the source PUT lands before the list endpoint reindexes). Keyed
    // locale:ref; an entry stays here until a server list confirms it, so a
    // lagging reload never drops a request the author just filed.
    this._pendingPromoKeys = new Set();
    this._queueBusy = new Set();
    this._rejectingKey = '';
    this._layers = new Map();
    this._editing = null;
    this._adaptBusy = new Set();
    this._suggest = '';
    this._confirmKey = '';
    this._proposing = false;
    this._proposal = null;
    this._config = null;
    this._recent = this.loadRecent();
    this._sites = [];
    this._orgs = [];
    this._translate = null;
    this._catalog = null;
    // Where materialized pages publish: 'sandbox' (namespaced /meridian/live) or
    // 'locale-root' (clean /{locale} URLs). Defaults from config; toggleable.
    this._publishMode = 'sandbox';
    // Opt-in: translate the page name (slug) so a market publishes at a localized
    // URL (/es/financiacion), not /es/financing. Off = every URL stays the source
    // ref, so behaviour is unchanged until an author turns it on.
    this._translateSlug = false;
    // The site's source language — never offered as a target market. Set from
    // config in scan(); 'en' until then.
    this._sourceLocale = 'en';
    this._edge = new Map();
    this._pageRef = 'international-banking';
    this._pageResults = new Map();
    this._pageBusy = false;
    this._pageBusyMsg = '';
    this._pageError = '';
    this._localizeDrafts = new Map();
    this._localeSel = new Set(['es', 'it']);
    this._browseOpen = false;
    this._pageTree = new Map();
    this._pageExpanded = new Set();
    this._previewOpen = new Set();
    this._pageRisk = [];
    this._toast = '';
    this._matrix = null;
    this._matrixLocales = [];
    this._matrixBusy = false;
    this._allPages = null;
    this._treeQuery = '';
    this._selectedPages = new Set();
    this._managed = [];
    this._bulkResults = [];
    this._segEditOpen = new Set();
    this._overlayLocale = '';
    this._localizeSource = '';
    this._localizeRef = '';
    // The store + base org/site a Localize draft was staged against — captured so
    // a later Publish can never target a since-repointed org/site.
    this._localizeStore = null;
    this._localizeOrg = '';
    this._localizeSite = '';
    // Deep-link / editor context wins; otherwise fall back to the most recent
    // org/site so a returning author lands where they left off.
    this._org = this._org || (this._recent[0]?.org ?? '');
    this._site = this._site || (this._recent[0]?.site ?? '');
    // Scan is triggered by init() once the DA session is (or isn't) available —
    // not here — so the toolbar always renders even without a DA context.
    // Escape closes the editor overlay (WAI-ARIA dialog behaviour).
    this._onKeydown = (e) => { if (e.key === 'Escape' && this._overlayLocale) this._overlayLocale = ''; };
    window.addEventListener('keydown', this._onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeydown);
    clearTimeout(this._toastTimer);
  }

  // Recent org/site pairs, persisted in localStorage so the picker can suggest
  // them across sessions (mirrors config-console's recent-path pattern).
  loadRecent() {
    try {
      const arr = JSON.parse(localStorage.getItem('meridian-recent') || '[]');
      return Array.isArray(arr) ? arr.filter((r) => r && r.org && r.site) : [];
    } catch {
      return [];
    }
  }

  saveRecent(org, site) {
    if (!org || !site) return;
    const next = [{ org, site }, ...this._recent.filter((r) => !(r.org === org && r.site === site))]
      .slice(0, 10);
    this._recent = next;
    try {
      localStorage.setItem('meridian-recent', JSON.stringify(next));
    } catch {
      // storage full/unavailable — in-memory suggestions still work
    }
  }

  async loadSites() {
    this._sites = await listSites(this._org);
  }

  // Every org the signed-in user can access, so the scope picker offers them all
  // (not just recents). Best-effort; falls back to the recents datalist on any
  // failure or if DA doesn't enumerate orgs for this user.
  async loadOrgs() {
    this._orgs = await listOrgs();
  }

  async onOrgChange(e) {
    this._org = e.target.value.trim();
    await this.loadSites();
  }

  async scan() {
    this._state = 'loading';
    this._error = '';
    this._diffs = new Map();
    // Invalidate site-scoped caches so a site switch never shows another site's
    // coverage matrix or page index (they lazy-reload for the new site).
    this._matrix = null;
    this._matrixLocales = [];
    this._catalog = null;
    this._siteStores = null;
    this._allPages = null;
    this._pageRisk = [];
    this._bulkResults = [];
    this._pendingPromoKeys = new Set();
    // Consume the editor-plugin deep link exactly once: capture + clear it now, so
    // a failed first scan or a later site switch can never re-apply a stale page.
    const deepPage = this._deepPage;
    const deepMarket = this._deepMarket;
    this._deepPage = '';
    this._deepMarket = '';
    // Page-scoped state is per-site too — reset it so a scan never carries the
    // previous site's selected page, page tree, or results forward (e.g. the
    // citizens default "international-banking" leaking onto another org's site).
    this._pageRef = '';
    this._pageTree = new Map();
    this._pageExpanded = new Set();
    this._browseOpen = false;
    this._treeQuery = '';
    this._selectedPages = new Set();
    this._managed = [];
    this._pageResults = new Map();
    this._previewOpen = new Set();
    this._localizeDrafts = new Map();
    this._localizeStore = null;
    this._localizeOrg = '';
    this._localizeSite = '';
    try {
      this._store = new DaStore({ org: this._org, site: this._site });
      // config.json is OPTIONAL. Meridian works on any org/site the user can
      // access; /meridian/config.json only adds the canonical/adaptation (variant)
      // model + exposure. Without it, Pages (translate/localize/promote) and the
      // Dashboard still work — so a brand-new site is usable immediately. A genuine
      // auth/read error (not a 404) throws and is surfaced below. (readConfig
      // returns null on 404.)
      const config = await this._store.readConfig();
      const valid = !!(config && config.canonicalId && Array.isArray(config.policies));
      this._config = config || {};
      this._canonicalId = valid ? config.canonicalId : null;
      this._policies = valid ? config.policies : [];
      // The site's source language (its own pages). Rebuild the store with it so
      // the store can refuse to localize INTO the source and hreflang labels the
      // source/x-default correctly.
      this._sourceLocale = (config && typeof config.sourceLocale === 'string' && config.sourceLocale)
        ? config.sourceLocale : 'en';
      this._store = new DaStore({
        org: this._org, site: this._site, sourceLocale: this._sourceLocale,
      });
      this._publishMode = (config && config.publishMode === 'locale-root') ? 'locale-root' : 'sandbox';
      // Exposure findings only exist once markets are configured.
      this._findings = valid
        ? await scanCanonical(this._store, this._canonicalId, this._policies).catch(() => [])
        : [];
      this._state = 'ready';
      // Prefill page/market from an editor-plugin deep link (captured at the top of
      // this scan), so the author lands on Pages already scoped to their page.
      if (deepPage) {
        this._pageRef = deepPage;
        this._tab = 'pages';
        if (deepMarket) this._localeSel = new Set([deepMarket]);
        // Arriving from the editor plugin: show the comparison straight away.
        this.previewPageSelection();
      } else if (deepMarket) {
        this._localeSel = new Set([deepMarket]);
      }
      this.saveRecent(this._org, this._site);
      this.loadQueue();
      if (this._canonicalId) this.loadAdaptations();
      this.loadTranslate();
      this.loadCatalog();
      this.loadManaged();
      if (this._policies.length) this.loadEdgeStatus();
      // Present-but-malformed config: note it, but don't block the Pages flow.
      if (config && !valid) {
        this._error = 'Note: /meridian/config.json is malformed (needs canonicalId + policies[]). Pages still works; fix it to enable exposure & adaptations.';
      }
    } catch (e) {
      console.error(e);
      // A 403 means the user is authenticated but has no access to this org/site
      // (e.g. a shared link carried someone else's org). Recover so ANY user can
      // use the app: switch to an org they can actually read, and let them pick a
      // site. Non-403 errors surface as before.
      if (/^Read failed for .*\(403\)$/.test(e.message || '')) {
        const orgs = await listOrgs().catch(() => []);
        const others = orgs.filter((o) => o && o !== this._org);
        if (others.length) {
          this._orgs = orgs;
          [this._org] = others;
          this._site = '';
          this._error = `You don't have access to that org. Switched to "${others[0]}" — pick a site and hit Scan.`;
          this.loadSites();
        } else {
          const scope = this._site ? `${this._org}/${this._site}` : this._org;
          this._error = `You don't have access to ${scope}. Enter an org and site you can access above, then Scan.`;
        }
      } else {
        this._error = e.message || 'Scan failed.';
      }
      this._state = 'init';
    }
  }

  async loadQueue() {
    try {
      this._queue = await this._store.listQueue();
    } catch (e) {
      console.error('Failed to load taste queue', e);
      this._error = `Could not load taste queue: ${e.message}`;
    }
    // Page-promotion requests are a separate, whole-page approval stream.
    try {
      const server = await this._store.listPromotions();
      const keyOf = (p) => `${p.locale}:${p.ref}`;
      const serverKeys = new Set(server.map(keyOf));
      // Once the server list reflects a request, stop treating it as pending —
      // from then on server truth governs it (so another reviewer's approval
      // can remove it from this author's view).
      this._pendingPromoKeys = new Set(
        [...this._pendingPromoKeys].filter((k) => !serverKeys.has(k)),
      );
      // Keep just-filed requests the list index hasn't caught up to yet.
      const pendingExtras = this._promotions.filter(
        (p) => this._pendingPromoKeys.has(keyOf(p)) && !serverKeys.has(keyOf(p)),
      );
      this._promotions = [...server, ...pendingExtras];
    } catch (e) {
      console.error('Failed to load promotion requests', e);
    }
  }

  // Approve a gated item: promote its materialized variant to /live and clear
  // the queue entry — the publish runs under the author's own DA session.
  // A compliance-blocked item can never be published: this guard is the
  // authoritative check (the disabled button is only a UI cue), so a blocked
  // item is rejected here even if approve() is reached by any other path.
  async approve(item) {
    if (item.gate === 'blocked') {
      this._error = `Cannot approve ${item.locale}: compliance layer absent — publishing is blocked.`;
      return;
    }
    const key = `${item.locale}:${item.canonicalId}`;
    if (this._queueBusy.has(key)) return;
    this._queueBusy = new Set(this._queueBusy).add(key);
    try {
      await this._store.writeVariant(item.variant);
      // Push it to the edge so approving actually publishes (not just writes DA
      // source). Best-effort: a publish failure leaves it written but not live.
      try {
        await this._store.publishVariant(item.locale, item.canonicalId);
      } catch (e) {
        this._error = `Wrote ${item.locale} to DA but could not publish to the edge: ${e.message}`;
      }
      // Clearing the queue entry is a separate write; if it fails the content is
      // already written, so report that distinctly and note re-approving is safe.
      try {
        await this._store.removeQueueItem(item.locale, item.canonicalId);
      } catch (e) {
        this._error = `Published ${item.locale}, but could not clear its queue entry (${e.message}). Re-approving is safe.`;
      }
      await Promise.all([this.loadQueue(), this.scan()]);
    } catch (e) {
      this._error = `Approve failed for ${item.locale} — nothing published: ${e.message}`;
    } finally {
      const done = new Set(this._queueBusy);
      done.delete(key);
      this._queueBusy = done;
    }
  }

  startReject(item) {
    this._rejectingKey = `${item.locale}:${item.canonicalId}`;
  }

  cancelReject() {
    this._rejectingKey = '';
  }

  // Persist the reason before removing the pending entry. Uses an inline
  // sl-input rather than window.prompt: an app iframe without allow-modals
  // silently returns null from prompt(), which would make reject a no-op.
  async confirmReject(item) {
    const reason = this.shadowRoot.querySelector('.mrd-reject-input')?.value.trim();
    if (!reason) {
      this._error = `A reason is required to reject ${item.locale}.`;
      return;
    }
    const key = `${item.locale}:${item.canonicalId}`;
    if (this._queueBusy.has(key)) return;
    this._queueBusy = new Set(this._queueBusy).add(key);
    try {
      await this._store.writeRejection({
        locale: item.locale,
        canonicalId: item.canonicalId,
        gate: item.gate,
        reason,
        rejectedBy: this.context?.user?.email || 'unknown',
        rejectedAt: new Date().toISOString(),
      });
      await this._store.removeQueueItem(item.locale, item.canonicalId);
      this._rejectingKey = '';
      await this.loadQueue();
    } catch (e) {
      this._error = `Reject failed for ${item.locale}: ${e.message}`;
    } finally {
      const done = new Set(this._queueBusy);
      done.delete(key);
      this._queueBusy = done;
    }
  }

  // ---- Adaptations (Phase 3 authoring) --------------------------------
  async loadAdaptations() {
    try {
      this._canonical = await this._store.readCanonical(this._canonicalId);
      const pairs = await Promise.all(this._policies.map(
        async (p) => [p.locale, await this._store.readLayer(p.locale, this._canonicalId)],
      ));
      this._layers = new Map(pairs.filter(([, layer]) => layer));
    } catch (e) {
      console.error('Failed to load adaptations', e);
      this._error = `Could not load adaptations: ${e.message}`;
    }
  }

  // DA's native localization config (/.da/translate.json). Read best-effort so
  // the setup surface can show what DA already knows; never blocks the app.
  async loadTranslate() {
    try {
      this._translate = await this._store.readTranslateConfig();
    } catch (e) {
      console.error('Failed to read DA translate config', e);
      this._translate = null;
    }
  }

  // DA's localization config (/.da/translate-v2.json), normalized to Meridian
  // locale tokens + region groups — the SAME sheet the official DA localization
  // app reads, so a site already configured there needs no reconfiguration.
  // Best-effort: a site with no config just falls back to folder discovery.
  async loadCatalog() {
    try {
      this._catalog = await this.pageStore().localeCatalog();
    } catch (e) {
      console.error('Failed to read DA locale config', e);
      this._catalog = null;
    }
  }

  // The managed manifest for the base site — used to show inline localization
  // status in the page picker (which markets a page already has). Best-effort.
  async loadManaged() {
    try {
      this._managed = await this.pageStore().readManaged();
    } catch {
      this._managed = [];
    }
  }

  // Locale codes already localized for a page (from the manifest), with stage —
  // used to annotate the picker so you skip done pages.
  pageStatus(ref) {
    return (this._managed || [])
      .filter((e) => e.ref === ref)
      .map((e) => ({ locale: e.locale, stage: e.mode === 'locale-root' ? 'live' : 'staged' }));
  }

  // Real edge state per market (publish-state), fetched best-effort with bounded
  // concurrency so a wide site doesn't burst requests. Populates _edge as each
  // market resolves; failures are skipped (the chip just doesn't show).
  async loadEdgeStatus() {
    const policies = this._policies ?? [];
    const next = new Map();
    const tasks = policies.map((p) => async () => {
      try {
        next.set(p.locale, await this._store.variantEdgeStatus(p.locale, this._canonicalId));
      } catch (e) {
        console.error(`Edge status failed for ${p.locale}`, e);
      }
    });
    await runWithConcurrency(tasks);
    this._edge = next;
  }

  get _daLanguages() {
    return readSheet(this._translate, 'languages');
  }

  get _dntRules() {
    return readSheet(this._translate, 'dnt-content-rules');
  }

  // A market that requires a compliance layer but has none authored is
  // non-publishable (PRD §5) — the same gate propagation enforces, surfaced
  // here so the author sees it while editing.
  isNonPublishable(locale) {
    const policy = this._policies?.find((p) => p.locale === locale);
    if (!policy?.requiredLayers?.includes('compliance')) return false;
    const layer = this._layers.get(locale);
    const present = new Set((layer?.entries ?? []).map((e) => e.layer));
    return !present.has('compliance');
  }

  startAdd(locale) {
    this._suggest = '';
    this._editing = { locale, index: null };
  }

  startEdit(locale, index) {
    this._suggest = '';
    this._editing = { locale, index };
  }

  // Prefill a structural-fork entry from the block's current canonical content
  // so the author edits a real starting point (PRD §12.3). If the block already
  // has an entry, convert it in place (reuse its index) rather than appending a
  // second entry for the same block — a fork supersedes the prior adaptation.
  startFork(locale, blockId) {
    const block = this._canonical?.blocks.find((b) => b.id === blockId);
    const layer = this._layers.get(locale);
    const index = layer ? layer.entries.findIndex((e) => e.blockId === blockId) : -1;
    this._suggest = '';
    this._editing = {
      locale,
      index: index >= 0 ? index : null,
      prefill: {
        blockId, layer: 'structural', operation: 'fork', value: block?.content, reason: '',
      },
    };
  }

  cancelEdit() {
    this._editing = null;
    this._suggest = '';
  }

  // Adaptation Agent: suggest a layer type for the selected block and pre-select
  // it. Only a suggestion — the author confirms (PRD §11 keeps humans in charge
  // of commercial/compliance).
  suggestLayer() {
    const blockId = this.shadowRoot.querySelector('#af-block')?.value;
    const block = this._canonical?.blocks.find((b) => b.id === blockId);
    if (!block) {
      this._suggest = 'Select an existing canonical block to get a suggestion.';
      return;
    }
    const s = classify(block);
    const layerSel = this.shadowRoot.querySelector('#af-layer');
    if (layerSel) layerSel.value = s.layer;
    this._suggest = `Suggested: ${s.layer} — ${s.reason}`;
  }

  async saveEntry(locale) {
    const root = this.shadowRoot;
    const blockId = root.querySelector('#af-block')?.value;
    const layer = root.querySelector('#af-layer')?.value;
    const operation = root.querySelector('#af-op')?.value;
    const rawValue = root.querySelector('#af-value')?.value ?? '';
    const reason = root.querySelector('#af-reason')?.value.trim();
    if (!blockId || !reason) {
      this._error = 'Block and reason are required to save an adaptation.';
      return;
    }
    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    // A fork is structural by definition; never let it be saved under another
    // layer (esp. compliance), which would blind staleness detection. The
    // materialize boundary also enforces this — this keeps the UI from ever
    // producing the invalid combination.
    const effectiveLayer = operation === 'fork' ? 'structural' : layer;
    const entry = {
      blockId,
      layer: effectiveLayer,
      operation,
      value,
      reason,
      // Authored in the UI by a person — provenance is the signed-in user, and a
      // compliance entry is marked non-negotiable and never scored (PRD §5/§11).
      provenance: this.context?.user?.email || 'human',
      confidence: null,
      status: effectiveLayer === 'compliance' ? 'human-owned-nonnegotiable' : 'human-owned',
    };
    // Record the canonical block hash this value was authored against, so a
    // later master change flags it for redoing (translate/override track the
    // source; insert/fork/remove don't).
    if (operation === 'translate' || operation === 'override') {
      const src = this._canonical?.blocks.find((b) => b.id === blockId);
      if (src?.hash) entry.sourceHash = src.hash;
    }
    const index = Number.isInteger(this._editing?.index) ? this._editing.index : null;
    await this.writeEntry(locale, entry, index);
  }

  async writeEntry(locale, entry, index) {
    if (this._adaptBusy.has(locale)) return;
    this._adaptBusy = new Set(this._adaptBusy).add(locale);
    try {
      const existing = this._layers.get(locale)
        ?? { locale, canonicalId: this._canonicalId, entries: [] };
      const entries = [...existing.entries];
      if (index === null) entries.push(entry);
      else entries[index] = entry;
      await this._store.writeLayer({
        ...existing, locale, canonicalId: this._canonicalId, entries,
      });
      this._editing = null;
      this._suggest = '';
      await this.refreshAfterAuthoring();
    } catch (e) {
      this._error = `Save failed for ${locale}: ${e.message}`;
    } finally {
      const done = new Set(this._adaptBusy);
      done.delete(locale);
      this._adaptBusy = done;
    }
  }

  async deleteEntry(locale, index) {
    if (this._adaptBusy.has(locale)) return;
    this._confirmKey = '';
    this._adaptBusy = new Set(this._adaptBusy).add(locale);
    try {
      const existing = this._layers.get(locale);
      if (existing) {
        const entries = existing.entries.filter((_, i) => i !== index);
        await this._store.writeLayer({ ...existing, entries });
        await this.refreshAfterAuthoring();
      }
    } catch (e) {
      this._error = `Delete failed for ${locale}: ${e.message}`;
    } finally {
      const done = new Set(this._adaptBusy);
      done.delete(locale);
      this._adaptBusy = done;
    }
  }

  // Re-read layers and re-run the exposure scan so authoring changes are
  // reflected immediately, without the full-page loading reset scan() does.
  // Never throws: the layer write already succeeded by the time this runs, so a
  // transient rescan failure must not be reported as a save failure (which would
  // invite a duplicate re-submit).
  async refreshAfterAuthoring() {
    await this.loadAdaptations();
    try {
      this._findings = await scanCanonical(this._store, this._canonicalId, this._policies);
    } catch (e) {
      console.error('Rescan after authoring failed', e);
      this._error = `Saved, but could not refresh findings: ${e.message}`;
    }
  }

  // ---- Setup surface (Phase 4): stand up a market from one sentence --------
  startPropose() {
    this._proposal = null;
    this._proposing = true;
  }

  cancelPropose() {
    this._proposing = false;
    this._proposal = null;
  }

  // Locale Architect Agent: turn the typed intent into a proposed policy for
  // review. Proposes only — nothing is written until the human hits Activate.
  propose() {
    const intent = this.shadowRoot.querySelector('#lp-intent')?.value.trim();
    if (!intent) {
      this._error = 'Describe the market in a sentence first.';
      return;
    }
    this._error = '';
    this._proposal = architect(intent);
  }

  // Activate the reviewed proposal: append its policy to config and seed an
  // empty adaptation layer so the market is covered and ready for authoring.
  // Scoped to the loaded org/site, so this stands a market up on any site.
  async activateMarket() {
    const p = this._proposal;
    if (!p) return;
    // The reviewer can correct/supply the locale in the form before activating.
    const locale = (this.shadowRoot.querySelector('#lp-locale')?.value || p.locale || '').trim();
    if (!locale) {
      this._error = 'Set a locale (e.g. fr_ca) before activating.';
      return;
    }
    if (this._adaptBusy.has(locale)) return;
    this._adaptBusy = new Set(this._adaptBusy).add(locale);
    try {
      const existing = this._policies ?? [];
      const policy = { locale, requiredLayers: p.requiredLayers };
      const policies = existing.some((x) => x.locale === locale)
        ? existing.map((x) => (x.locale === locale ? policy : x))
        : [...existing, policy];
      const nextConfig = { ...this._config, canonicalId: this._canonicalId, policies };
      await this._store.writeConfig(nextConfig);
      if (!this._layers.get(locale)) {
        await this._store.writeLayer({
          locale, canonicalId: this._canonicalId, entries: [],
        });
      }
      this._config = nextConfig;
      this._policies = policies;
      this._proposal = null;
      this._proposing = false;
      // Best-effort: register the market in DA's native localization config so
      // Meridian complements DA's translation. Never blocks activation.
      try {
        await this._store.registerLanguage(locale);
        await this.loadTranslate();
      } catch (e) {
        console.error('Could not register language in DA translate config', e);
      }
      await this.refreshAfterAuthoring();
    } catch (e) {
      this._error = `Activate failed for ${locale}: ${e.message}`;
    } finally {
      const done = new Set(this._adaptBusy);
      done.delete(locale);
      this._adaptBusy = done;
    }
  }

  handleSubmit(e) {
    e.preventDefault();
    const org = this.shadowRoot.querySelector('#org-input')?.value.trim();
    const site = this.shadowRoot.querySelector('#site-input')?.value.trim();
    if (!org || !site) return;
    this._org = org;
    this._site = site;
    this.scan();
  }

  // Lazy-load the block diff for a drift/stale finding — "view only the changes".
  async toggleDiff(locale) {
    if (this._diffs.has(locale)) {
      const next = new Map(this._diffs);
      next.delete(locale);
      this._diffs = next;
      return;
    }
    if (this._loadingDiffs.has(locale)) return;
    this._loadingDiffs = new Set(this._loadingDiffs).add(locale);
    try {
      const [canonical, layer, stored] = await Promise.all([
        this._store.readCanonical(this._canonicalId),
        this._store.readLayer(locale, this._canonicalId),
        this._store.readVariant(locale, this._canonicalId),
      ]);
      const expected = materialize(canonical, layer);
      // The stored /live variant may have been deleted since the scan; treat a
      // missing variant as empty rather than throwing.
      const actual = stored ?? { locale, canonicalId: this._canonicalId, blocks: [] };
      const next = new Map(this._diffs);
      next.set(locale, onlyChanges(diffVariants(expected, actual)));
      this._diffs = next;
    } catch (e) {
      console.error(e);
      this._error = `Could not load changes for ${locale}: ${e.message}`;
    } finally {
      const done = new Set(this._loadingDiffs);
      done.delete(locale);
      this._loadingDiffs = done;
    }
  }

  get _byLocale() {
    const groups = new Map();
    this._findings.forEach((f) => {
      if (!groups.has(f.locale)) groups.set(f.locale, []);
      groups.get(f.locale).push(f);
    });
    // Sort markets by their most severe finding, then by locale.
    return [...groups.entries()].sort((a, b) => {
      const sa = Math.min(...a[1].map((f) => SEVERITY_RANK[f.severity] ?? 3));
      const sb = Math.min(...b[1].map((f) => SEVERITY_RANK[f.severity] ?? 3));
      return sa - sb || a[0].localeCompare(b[0]);
    });
  }

  get _summary() {
    return this._findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
  }

  get _cleanCount() {
    if (!this._policies) return 0;
    const affected = new Set(this._findings.map((f) => f.locale));
    return this._policies.filter((p) => !affected.has(p.locale)).length;
  }

  // Sites to suggest for the current org: those recently used, merged with the
  // full list fetched live from the DA list API (any site in the org).
  get siteSuggestions() {
    const recentForOrg = this._recent.filter((r) => r.org === this._org).map((r) => r.site);
    return [...new Set([...recentForOrg, ...this._sites])].filter(Boolean);
  }

  renderToolbar() {
    return html`
      <h2 class="mrd-sr-only">Meridian localization</h2>
      <div class="mrd-toolbar">
        <form class="mrd-scope" role="group" aria-label="Site scope" @submit=${this.handleSubmit}>
          <span class="mrd-scope-label" aria-hidden="true">Site</span>
          <input class="mrd-scope-input" id="org-input" list="mrd-orgs" placeholder="org"
            aria-label="Organization"
            value=${this._org} ?disabled=${this._state === 'loading'} @change=${this.onOrgChange} />
          <datalist id="mrd-orgs">
            ${[...new Set([...this._orgs, ...this._recent.map((r) => r.org)])].filter(Boolean)
    .map((o) => html`<option value=${o}></option>`)}
          </datalist>
          <span class="mrd-scope-sep" aria-hidden="true">/</span>
          <select class="mrd-scope-select" id="site-input" aria-label="Site"
            ?disabled=${this._state === 'loading'} @change=${(e) => { this._site = e.target.value; }}>
            ${this._site ? nothing : html`<option value="" selected>Choose a site…</option>`}
            ${[...new Set([this._site, ...this.siteSuggestions].filter(Boolean))]
    .map((s) => html`<option value=${s} ?selected=${s === this._site}>${s}</option>`)}
          </select>
        </form>
        <sl-button class="mrd-scan primary outline" ?disabled=${this._state === 'loading'}
          @click=${this.handleSubmit}>Scan</sl-button>
      </div>
      ${this._state === 'ready' ? html`
        <nx-tabs .items=${this.tabItems()} .active=${this._tab}
          @tab-change=${(e) => {
    const { id } = e.detail;
    if (id === 'taste') this.openApprovals();
    else this._tab = id;
  }}></nx-tabs>
        ${TAB_HELP[this._tab] ? html`<div class="mrd-tab-help">${TAB_HELP[this._tab]}</div>` : nothing}` : nothing}
      ${this._error ? html`<div class="nx-alert warning">${this._error}</div>` : nothing}
    `;
  }

  diffButtonLabel(locale) {
    if (this._loadingDiffs.has(locale)) return 'Loading…';
    return this._diffs.has(locale) ? 'Hide changes' : 'View changes';
  }

  renderDiff(locale) {
    const changes = this._diffs.get(locale);
    if (!changes) return nothing;
    if (!changes.length) return html`<div class="mrd-diff">No block-level changes.</div>`;
    return html`<div class="mrd-diff">
      ${changes.map((c) => html`
        <div class="mrd-diff-row">
          <span class="mrd-diff-block">${c.blockId}</span>
          <span class="mrd-diff-status mrd-${c.status}">${c.status}</span>
          <div class="mrd-diff-cols">
            <pre class="mrd-expected">${JSON.stringify(c.expected ?? '—', null, 2)}</pre>
            <pre class="mrd-actual">${JSON.stringify(c.actual ?? '—', null, 2)}</pre>
          </div>
        </div>`)}
    </div>`;
  }

  // The real edge state chip (publish-state), once loadEdgeStatus resolves it.
  renderEdge(locale) {
    const edge = this._edge.get(locale);
    if (!edge) return nothing;
    return html`<span class="mrd-edge" style="color:${edge.color}" title=${`Edge: ${edge.tip}`}>
      ${icon(edge.name, '0 0 20 20')}
    </span>`;
  }

  renderMarket([locale, findings]) {
    const status = variantStatus(findings);
    const canDiff = findings.some((f) => f.kind === 'drift' || f.kind === 'stale');
    return html`
      <div class="mrd-market">
        <div class="mrd-market-head">
          <span class="mrd-status" style="color:${status.color}" title=${status.tip}>
            ${icon(status.name, '0 0 20 20')}
          </span>
          <span class="mrd-locale">${locale}</span>
          ${this.renderEdge(locale)}
          ${canDiff ? html`<sl-button class="mrd-diff-btn primary outline"
            ?disabled=${this._loadingDiffs.has(locale)}
            @click=${() => this.toggleDiff(locale)}>
            ${this.diffButtonLabel(locale)}
          </sl-button>` : nothing}
        </div>
        ${findings.map((f) => html`
          <div class="mrd-finding mrd-${f.severity}">
            <span class="mrd-kind">${f.kind}</span>
            <span class="mrd-detail">${f.detail}</span>
          </div>`)}
        ${this.renderDiff(locale)}
      </div>`;
  }

  renderExposure() {
    if (!this._findings.length) return html`<div class="mrd-empty">No exposures found.</div>`;
    const s = this._summary;
    return html`
      <div class="mrd-summary">
        <div class="mrd-scorecard mrd-critical">
          <div class="mrd-score">${s.critical ?? 0}</div>
          <div class="mrd-score-label">Critical</div>
        </div>
        <div class="mrd-scorecard mrd-warning">
          <div class="mrd-score">${s.warning ?? 0}</div>
          <div class="mrd-score-label">Warning</div>
        </div>
        <div class="mrd-scorecard mrd-positive">
          <div class="mrd-score">${this._cleanCount}</div>
          <div class="mrd-score-label">Clean markets</div>
        </div>
      </div>
      <div class="mrd-list">${this._byLocale.map((g) => this.renderMarket(g))}</div>
    `;
  }

  renderQueueItem(item) {
    const key = `${item.locale}:${item.canonicalId}`;
    const busy = this._queueBusy.has(key);
    const blocked = item.gate === 'blocked';
    const rejecting = this._rejectingKey === key;
    return html`
      <div class="mrd-queue-card">
        <nx-card heading=${item.locale} subheading=${item.reason}>
          <span class="mrd-kind mrd-${blocked ? 'critical' : 'warning'}" style="align-self:flex-start">${item.gate}</span>
          <span slot="actions">
            <sl-button ?disabled=${busy || blocked}
              title=${blocked ? 'Compliance absent — cannot publish' : 'Publish to /live'}
              @click=${() => this.approve(item)}>Approve</sl-button>
            <sl-button class="negative outline" ?disabled=${busy} @click=${() => this.startReject(item)}>Reject</sl-button>
          </span>
        </nx-card>
        ${rejecting ? html`
          <div class="mrd-reject-form">
            <sl-input class="mrd-reject-input" ?disabled=${busy}
              placeholder="Reason for rejecting ${item.locale}…"></sl-input>
            <sl-button class="negative" ?disabled=${busy} @click=${() => this.confirmReject(item)}>Confirm reject</sl-button>
            <sl-button class="primary outline" ?disabled=${busy} @click=${() => this.cancelReject()}>Cancel</sl-button>
          </div>` : nothing}
      </div>`;
  }

  renderPromotionItem(item) {
    const key = `promo:${item.locale}:${item.ref}`;
    const busy = this._queueBusy.has(key);
    const sub = `${item.ref}${item.requestedBy ? ` · requested by ${item.requestedBy}` : ''}`;
    return html`
      <nx-card heading=${item.locale} subheading=${sub}>
        <span class="mrd-kind mrd-warning" style="align-self:flex-start">promote → live</span>
        <span slot="actions">
          <sl-button ?disabled=${busy}
            title="Promote the reviewed sandbox page to /${item.locale}/${item.ref}"
            @click=${() => this.approvePromotion(item)}>Approve &amp; promote</sl-button>
          <sl-button class="negative outline" ?disabled=${busy}
            @click=${() => this.rejectPromotion(item)}>Reject</sl-button>
        </span>
      </nx-card>`;
  }

  renderTaste() {
    const promos = this._promotions || [];
    if (!this._queue.length && !promos.length) {
      return html`<div class="mrd-empty">Nothing awaiting approval.</div>`;
    }
    return html`
      ${promos.length ? html`
        <div class="mrd-section-label">Page promotions — approve to publish the reviewed page to its live locale URL</div>
        <div class="mrd-list">${promos.map((i) => this.renderPromotionItem(i))}</div>
      ` : nothing}
      ${this._queue.length ? html`
        <div class="mrd-section-label">Variant taste queue — gated recomputes awaiting review</div>
        <div class="mrd-list">${this._queue.map((i) => this.renderQueueItem(i))}</div>
      ` : nothing}
    `;
  }

  // Deleting a non-negotiable (compliance) entry takes a confirm step so legal
  // content is not removed by a single stray click. Inline, not window.confirm
  // (which a sandboxed app iframe can silently suppress).
  renderDelete(locale, i, locked, busy) {
    const key = `${locale}:${i}`;
    if (locked && this._confirmKey === key) {
      return html`
        <sl-button class="negative" ?disabled=${busy} @click=${() => this.deleteEntry(locale, i)}>Confirm delete</sl-button>
        <sl-button class="primary outline" ?disabled=${busy} @click=${() => { this._confirmKey = ''; }}>Cancel</sl-button>`;
    }
    if (locked) {
      return html`<sl-button class="negative outline" ?disabled=${busy} @click=${() => { this._confirmKey = key; }}>Delete</sl-button>`;
    }
    return html`<sl-button class="negative outline" ?disabled=${busy} @click=${() => this.deleteEntry(locale, i)}>Delete</sl-button>`;
  }

  renderEntry(locale, entry, i) {
    const locked = entry.status === 'human-owned-nonnegotiable';
    const busy = this._adaptBusy.has(locale);
    return html`
      <div class="mrd-entry">
        <div class="mrd-entry-head">
          <span class="mrd-entry-block">${entry.blockId}</span>
          <span class="mrd-layer-chip mrd-layer-${entry.layer}">${entry.layer}</span>
          <span class="mrd-entry-op">${entry.operation}</span>
          ${locked ? html`<span class="mrd-lock" title="Human-owned, non-negotiable">human-only</span>` : nothing}
          <span class="mrd-entry-actions">
            <sl-button class="primary outline" ?disabled=${busy} @click=${() => this.startEdit(locale, i)}>Edit</sl-button>
            ${entry.operation === 'fork' ? nothing : html`<sl-button class="primary outline" ?disabled=${busy} @click=${() => this.startFork(locale, entry.blockId)}>Fork</sl-button>`}
            ${this.renderDelete(locale, i, locked, busy)}
          </span>
        </div>
        <div class="mrd-entry-reason">${entry.reason}</div>
        <div class="mrd-entry-meta">${entry.provenance}${entry.confidence != null ? ` · confidence ${entry.confidence}` : ''}</div>
      </div>`;
  }

  renderEntryForm(locale) {
    const editing = this._editing;
    const layer = this._layers.get(locale);
    let entry = {};
    // Prefill (fork) takes precedence over the indexed entry it converts, so a
    // fork opens with structural/fork + canonical content, not the old entry.
    if (editing?.prefill) entry = editing.prefill;
    else if (Number.isInteger(editing?.index) && layer) entry = layer.entries[editing.index];
    const blocks = this._canonical?.blocks ?? [];
    const busy = this._adaptBusy.has(locale);
    return html`
      <div class="mrd-entry-form">
        <div>
          <label for="af-block">Block</label>
          <input id="af-block" list="af-blocks" ?disabled=${busy}
            value=${entry.blockId ?? ''} placeholder="existing or new block id" />
          <datalist id="af-blocks">
            ${blocks.map((b) => html`<option value=${b.id}></option>`)}
          </datalist>
        </div>
        <div>
          <label for="af-layer">Layer</label>
          <select id="af-layer" ?disabled=${busy}>
            ${LAYER_PRECEDENCE.map((l) => html`<option value=${l} ?selected=${l === entry.layer}>${l}</option>`)}
          </select>
        </div>
        <div>
          <label for="af-op">Operation</label>
          <select id="af-op" ?disabled=${busy}>
            ${OPERATIONS.map((o) => html`<option value=${o} ?selected=${o === entry.operation}>${o}</option>`)}
          </select>
        </div>
        <div>
          <label>&nbsp;</label>
          <sl-button class="primary outline" ?disabled=${busy} @click=${() => this.suggestLayer()}>Suggest layer</sl-button>
        </div>
        <div class="mrd-field-wide">
          <label for="af-value">Value (JSON or text)</label>
          <textarea id="af-value" ?disabled=${busy}>${entryValueString(entry.value)}</textarea>
        </div>
        <div class="mrd-field-wide">
          <label for="af-reason">Reason</label>
          <textarea id="af-reason" ?disabled=${busy}>${entry.reason ?? ''}</textarea>
        </div>
        ${this._suggest ? html`<div class="mrd-suggest">${this._suggest}</div>` : nothing}
        <div class="mrd-form-actions">
          <sl-button class="primary outline" ?disabled=${busy} @click=${() => this.cancelEdit()}>Cancel</sl-button>
          <sl-button ?disabled=${busy} @click=${() => this.saveEntry(locale)}>Save adaptation</sl-button>
        </div>
      </div>`;
  }

  renderAdaptCard(locale) {
    const layer = this._layers.get(locale);
    const entries = layer?.entries ?? [];
    const present = [...new Set(entries.map((e) => e.layer))]
      .sort((a, b) => LAYER_PRECEDENCE.indexOf(a) - LAYER_PRECEDENCE.indexOf(b));
    const editingHere = this._editing?.locale === locale;
    return html`
      <div class="mrd-market">
        <div class="mrd-market-head">
          <span class="mrd-locale">${locale}</span>
          <span class="mrd-layer-chips">
            ${present.map((l) => html`<span class="mrd-layer-chip mrd-layer-${l}">${l}</span>`)}
          </span>
        </div>
        ${this.isNonPublishable(locale) ? html`
          <div class="mrd-nonpublishable">
            ${icon('S2_Icon_AlertDiamond', '0 0 18 18')} Non-publishable — required compliance layer absent
          </div>` : nothing}
        ${entries.length
    ? entries.map((e, i) => this.renderEntry(locale, e, i))
    : html`<div class="mrd-empty">No adaptations yet.</div>`}
        ${editingHere
    ? this.renderEntryForm(locale)
    : html`<sl-button class="mrd-add-entry primary outline" @click=${() => this.startAdd(locale)}>Add adaptation</sl-button>`}
      </div>`;
  }

  renderNewMarket() {
    if (!this._proposing) {
      return html`<sl-button class="mrd-newmarket-btn" @click=${() => this.startPropose()}>+ New market</sl-button>`;
    }
    const p = this._proposal;
    const busy = p && this._adaptBusy.has(p.locale);
    return html`
      <div class="mrd-newmarket">
        <div class="mrd-da-context">
          Interoperates with DA localization: ${this._daLanguages.length} language(s),
          ${this._dntRules.length} do-not-translate rule(s) in this site's .da/translate.json.
          Activating a market registers its language there too.
        </div>
        <label for="lp-intent">Describe the market in a sentence</label>
        <textarea id="lp-intent"
          placeholder="e.g. Add a Quebec French market: translate everything, keep US pricing, and it legally needs a French disclosure."></textarea>
        <div class="mrd-form-actions">
          <sl-button class="primary outline" @click=${() => this.cancelPropose()}>Cancel</sl-button>
          <sl-button class=${p ? 'primary outline' : ''} @click=${() => this.propose()}>Propose</sl-button>
        </div>
        ${p ? html`
          <div class="mrd-proposal">
            <div class="mrd-market-head">
              <input id="lp-locale" class="mrd-locale-input" value=${p.locale ?? ''}
                placeholder="locale e.g. fr_ca" ?disabled=${busy} />
              <span class="mrd-layer-chips">
                ${p.requiredLayers.map((l) => html`<span class="mrd-layer-chip mrd-layer-${l}">${l}</span>`)}
              </span>
              <span class="mrd-entry-meta">confidence ${p.confidence}</span>
            </div>
            <ul class="mrd-notes">${p.notes.map((n) => html`<li>${n}</li>`)}</ul>
            <div class="mrd-form-actions">
              <sl-button ?disabled=${busy} @click=${() => this.activateMarket()}>Activate market</sl-button>
            </div>
          </div>` : nothing}
      </div>`;
  }

  renderAdaptations() {
    return html`
      <p class="mrd-adapt-intro">
        Author why each market differs — every difference is a typed, reasoned layer that recomputes with canonical.
      </p>
      ${this.renderNewMarket()}
      ${this._policies?.length
    ? html`<div class="mrd-list">${this._policies.map((p) => this.renderAdaptCard(p.locale))}</div>`
    : html`<div class="mrd-empty">No markets yet — describe one above to stand it up.</div>`}
    `;
  }

  // Shared setup for both page actions. Returns { ref, locales, store, translate }
  // or { error }.
  pageInputs() {
    if (!this._org || !this._site) return { error: 'Set org/site first.' };
    const ref = (this._pageRef || '').trim();
    const locales = [...this._localeSel];
    if (!ref) return { error: 'Choose a page to localize.' };
    if (!locales.length) return { error: 'Pick at least one target language.' };
    const store = this.pageStore();
    // Optional quality controls from /meridian/config.json: a formality hint and
    // a per-language-pair glossary map (brand/legal terminology). Only DeepL
    // honors these; other providers ignore them harmlessly.
    const cfg = this._config || {};
    const translate = createTranslator(daFetch, {
      org: this._org,
      site: this._site,
      formality: cfg.formality,
      glossaries: cfg.glossaries,
    });
    return {
      ref, locales, store, translate,
    };
  }

  // A store for the current org/site, reused across browse + run. Threads the
  // known source locale so even this lazy fallback is consistent with the store
  // scan() builds (source-locale guard + hreflang labeling).
  pageStore() {
    if (!this._store) {
      this._store = new DaStore({
        org: this._org, site: this._site, sourceLocale: this._sourceLocale,
      });
    }
    return this._store;
  }

  // The repo a market publishes into. A DA locale config can route a market to
  // its own site (the `site` column); otherwise it's the base site.
  siteForLocale(code) {
    return this._catalog?.siteByCode?.[code] || this._site;
  }

  // A store bound to a specific target site (cached). The base site reuses the
  // primary store; other sites get their own, so cross-repo publishing writes to
  // the right place. Source pages are always READ from the base store.
  storeForSite(site) {
    if (!site || site === this._site) return this.pageStore();
    if (!this._siteStores) this._siteStores = new Map();
    if (!this._siteStores.has(site)) {
      this._siteStores.set(site, new DaStore({
        org: this._org, site, sourceLocale: this._sourceLocale,
      }));
    }
    return this._siteStores.get(site);
  }

  // ---- Page tree (browse real site pages instead of typing a path) ---------
  async loadFolder(path) {
    if (!this._org || !this._site) { this._pageError = 'Set org/site first.'; return; }
    this._pageError = '';
    try {
      const kids = await this.pageStore().listPages(path);
      this._pageTree = new Map(this._pageTree).set(path, kids);
    } catch (e) {
      // Collapse the folder so it doesn't sit stuck on "Loading…"; the banner
      // explains why, and re-expanding retries the fetch.
      this._pageError = `Could not list pages: ${e.message}`;
      const next = new Set(this._pageExpanded);
      next.delete(path);
      this._pageExpanded = next;
    }
  }

  toggleBrowse() {
    this._browseOpen = !this._browseOpen;
    if (this._browseOpen && !this._pageTree.has('')) this.loadFolder('');
    if (this._browseOpen) this.loadAllPages();
  }

  async loadAllPages() {
    if (this._allPages !== null || !this._org || !this._site) return;
    try {
      this._allPages = await this.pageStore().allPages();
    } catch {
      this._allPages = [];
    }
  }

  renderTreeSearch() {
    if (this._allPages === null) return html`<div class="mrd-tree-note">Indexing pages…</div>`;
    const q = this._treeQuery.trim().toLowerCase();
    const matches = this._allPages.filter((p) => p.toLowerCase().includes(q)).slice(0, 50);
    if (!matches.length) return html`<div class="mrd-tree-note">No pages match “${this._treeQuery}”.</div>`;
    return html`<ul class="mrd-tree-list" role="group">
      ${matches.map((ref) => this.renderPagePickRow(ref, ref))}
    </ul>`;
  }

  toggleFolder(path) {
    const next = new Set(this._pageExpanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (!this._pageTree.has(path)) this.loadFolder(path);
    }
    this._pageExpanded = next;
  }

  // Multi-select: toggle a page ref in the batch selection (checkboxes).
  toggleSelectPage(ref) {
    const next = new Set(this._selectedPages);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    this._selectedPages = next;
  }

  clearSelection() {
    this._selectedPages = new Set();
  }

  toggleLocale(code) {
    const next = new Set(this._localeSel);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    this._localeSel = next;
    this._pageRisk = []; // language set changed; old status no longer matches
  }

  // Select (or clear) a whole region group at once — the "publish all in a
  // locale group" convenience the DA loc app offers, applied to Meridian's
  // select-then-act flow. On when every code is already selected → toggles off.
  toggleGroup(codes) {
    const next = new Set(this._localeSel);
    const allOn = codes.every((c) => next.has(c));
    codes.forEach((c) => (allOn ? next.delete(c) : next.add(c)));
    this._localeSel = next;
    this._pageRisk = [];
  }

  renderChip(code, name) {
    const on = this._localeSel.has(code);
    return html`
      <button class="mrd-lang-chip ${on ? 'on' : ''}"
        aria-pressed=${on} aria-label=${name || code} title=${name || code}
        ?disabled=${this._pageBusy} @click=${() => this.toggleLocale(code)}>${code}</button>`;
  }

  // Market picker: driven by the site's DA locale config when present (base
  // languages, then each region group with a one-click "All"), else the common
  // quick-pick fallback.
  renderLangChips() {
    const cat = this._catalog;
    // The source language is the site's own pages, never a target market.
    const notSource = (code) => code !== this._sourceLocale;
    if (cat && (cat.languages.length || cat.groups.length)) {
      const languages = cat.languages.filter((l) => notSource(l.code));
      const groups = cat.groups
        .map((g) => ({ ...g, locales: g.locales.filter((l) => notSource(l.code)) }))
        .filter((g) => g.locales.length);
      return html`
        ${languages.length ? html`
          <span class="mrd-lang-row">${languages.map((l) => this.renderChip(l.code, l.name))}</span>
        ` : nothing}
        ${groups.map((g) => {
    const codes = g.locales.map((l) => l.code);
    const allOn = codes.every((c) => this._localeSel.has(c));
    return html`
            <span class="mrd-lang-row">
              <span class="mrd-lang-group-label">${g.name}</span>
              <button class="mrd-lang-all ${allOn ? 'on' : ''}" aria-pressed=${allOn}
                ?disabled=${this._pageBusy}
                @click=${() => this.toggleGroup(codes)}>${allOn ? 'Clear' : 'All'}</button>
              ${g.locales.map((l) => this.renderChip(l.code, l.name))}
            </span>`;
  })}`;
    }
    return html`
      <span class="mrd-lang-row">
        ${LANG_OPTIONS.filter(([code]) => notSource(code)).map(([code, name]) => this.renderChip(code, name))}
      </span>`;
  }

  // The published edge URL of a source (English) page, for the side-by-side preview.
  pageEdgeUrl(ref) {
    // Reuse the shared, tested path guard rather than an ad-hoc clean.
    const clean = assertPageRef(ref);
    return `https://main--${this._site}--${this._org}.aem.live/${clean}`;
  }

  // The canonical tail of the picked ref: strip a leading locale folder
  // ("pt/international-banking" -> "international-banking") so the same page can
  // be addressed in a different source locale.
  localeTail(ref) {
    const segs = (ref || '').split('/');
    if (segs.length > 1 && (this._catalog?.all || []).includes(segs[0])) {
      return segs.slice(1).join('/');
    }
    return ref;
  }

  // The left ("source") compare pane. By default it's the page you picked; you
  // can instead compare the localized version against the base source language
  // or any other market's version of the same page. Returns { loc, url }.
  compareSource() {
    const sel = this._compareSource;
    if (!sel) {
      const seg = (this._pageRef || '').split('/')[0];
      const loc = (this._catalog?.all || []).includes(seg) ? seg : this._sourceLocale;
      return { loc, url: this.pageEdgeUrl(this._pageRef) };
    }
    const tail = this.localeTail(this._pageRef);
    if (sel === '__base__') return { loc: this._sourceLocale, url: this.pageEdgeUrl(tail) };
    const site = this.siteForLocale(sel);
    return { loc: sel, url: `https://main--${site}--${this._org}.aem.live/${sel}/${tail}` };
  }

  // Tab model for the shared nx-tabs component (ported from ew-extensions). The
  // Approvals count badge is inline-styled so it keeps the Spectrum blue inside
  // the component's shadow root (meridian.css classes don't cross that boundary).
  tabItems() {
    const pending = this._queue.length + (this._promotions?.length || 0);
    const approvals = pending
      ? html`Approvals <span style="margin-left:5px;background:var(--s2-blue-900,#2680eb);color:#fff;border-radius:999px;padding:0 7px;font-size:11px;line-height:1.6;">${pending}</span>`
      : 'Approvals';
    return [
      { id: 'overview', label: 'Dashboard' },
      { id: 'pages', label: 'Pages' },
      { id: 'exposure', label: 'Issues' },
      { id: 'taste', label: approvals },
      { id: 'adapt', label: 'Market rules' },
    ];
  }

  // Transient success confirmation (auto-dismisses). Actions otherwise complete
  // silently — a toast is the expected feedback affordance.
  showToast(msg) {
    this._toast = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = ''; }, 4000);
  }

  // Deep link straight into the Experience Workspace (DA) editor for a
  // materialized localized page (a
  // scoped source path like /meridian/live/es/international-banking) so an author
  // can hand-edit it — the "Edit" escape hatch the DA loc app offers.
  daEditUrl(path) {
    return `https://da.live/edit#/${this._org}/${this._site}${path}`;
  }

  // Copy a published link to the clipboard on demand (the DA loc app copies live
  // URLs on publish); best-effort with a clear fallback message.
  async copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      this.showToast('Live link copied to clipboard');
    } catch {
      this.showToast('Copy failed — open the link and copy it manually');
    }
  }

  toggleSegEdit(locale) {
    const next = new Set(this._segEditOpen);
    if (next.has(locale)) next.delete(locale);
    else next.add(locale);
    this._segEditOpen = next;
  }

  async publishFromOverlay(locale) {
    await this.publishLocalized(locale);
    if (!this._localizeDrafts.has(locale)) this._overlayLocale = '';
  }

  // A readable, full-surface editor for one market's localization: every
  // segment as source | editable translation, with layer + quality context.
  // (The rendered preview is cross-origin, so it can't be edited in place; this
  // overlay is the editable counterpart to it.)
  renderOverlay() {
    const locale = this._overlayLocale;
    if (!locale) return nothing;
    const draft = this._localizeDrafts.get(locale);
    if (!draft?.ok) return nothing;
    const rows = [
      ...[...draft.dict].map(([source, target]) => ({ source, layer: 'language', machine: target })),
      ...draft.review.map((seg) => ({
        source: seg.source, layer: seg.layer, machine: seg.suggested ?? '', issues: seg.issues,
      })),
    ];
    const pct = Math.round((draft.coverage?.ratio ?? 0) * 100);
    const sev = (l) => {
      if (l === 'compliance') return 'mrd-critical';
      if (l === 'commercial') return 'mrd-warning';
      return '';
    };
    return html`
      <div class="mrd-overlay"
        @click=${(e) => { if (e.target.classList.contains('mrd-overlay')) this._overlayLocale = ''; }}>
        <div class="mrd-overlay-panel" role="dialog" aria-modal="true"
          aria-label="Edit ${locale} localization">
          <div class="mrd-overlay-head">
            <div>
              <div class="mrd-overlay-title">Review &amp; edit — ${locale}</div>
              <div class="mrd-overlay-sub">
              ${this._pageRef} · language ${pct}% · ${rows.length} segment(s) · leave a field blank to keep the source
            </div>
            </div>
            <button class="mrd-overlay-close" aria-label="Close"
              @click=${() => { this._overlayLocale = ''; }}>×</button>
          </div>
          <div class="mrd-overlay-body">
            ${rows.map((r) => html`
              <div class="mrd-overlay-row">
                <div class="mrd-overlay-src">
                  <span class="mrd-kind ${sev(r.layer)}">${r.layer}</span>
                  <div class="mrd-overlay-srctext">${r.source}</div>
                  ${r.issues?.length
    ? html`<div class="mrd-override-issues">${r.issues.map((i) => i.detail).join('; ')}</div>` : nothing}
                </div>
                <textarea class="mrd-overlay-input" ?disabled=${this._pageBusy}
                  placeholder=${r.layer === 'language'
    ? `${locale} translation (blank = keep source)`
    : `Market ${r.layer} text for ${locale} (blank = keep source)`}
                  .value=${draft.overrides[r.source] ?? r.machine ?? ''}
                  @change=${(e) => this.setOverride(locale, r.source, e.target.value)}></textarea>
              </div>`)}
          </div>
          ${this._pageError ? html`<div class="nx-alert warning mrd-overlay-error">${this._pageError}</div>` : nothing}
          <div class="mrd-overlay-foot">
            <sl-button class="primary outline" ?disabled=${this._pageBusy}
              @click=${() => { this._overlayLocale = ''; }}>Close</sl-button>
            <sl-button ?disabled=${this._pageBusy} @click=${() => this.publishFromOverlay(locale)}>
              ${this._pageBusy ? 'Publishing…' : `Publish ${locale}`}
            </sl-button>
          </div>
        </div>
      </div>`;
  }

  togglePreview(key) {
    const next = new Set(this._previewOpen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this._previewOpen = next;
  }

  // Localization risk radar: for the chosen page + languages, is each market's
  // published page current / stale (source moved) / not yet localized.
  async checkStatus() {
    const ctx = this.pageInputs();
    if (ctx.error) { this._pageError = ctx.error; return; }
    this._pageBusy = true;
    this._pageError = '';
    try {
      this._pageBusyMsg = `Checking ${ctx.locales.length} market(s)…`;
      this._pageRisk = await this.pageRiskMultiSite(ctx.ref, ctx.locales, this._publishMode);
    } catch (e) {
      this._pageError = e.message;
    } finally {
      this._pageBusy = false;
    }
  }

  // Select a page and immediately preview its existing localized copies — so the
  // canvas shows a comparison the moment you pick a page, not only after Translate.
  pickPage(ref) {
    this._pageRef = ref;
    this._browseOpen = false;
    this._treeQuery = '';
    this._pageRisk = [];
    this._previewOpen = new Set();
    this._compareSource = '';
    this.previewPageSelection();
  }

  // Seed the canvas from what already exists (manifest + edge URLs, no
  // re-translation): a side-by-side compare for each selected market that has a
  // copy (staged → reviewable/promotable, live → published), plus risk chips for
  // every market. Missing markets have no pane — the chips say "not localized".
  async previewPageSelection() {
    const ref = this._pageRef;
    if (!ref) return;
    this._pageError = '';
    this._pageResults = new Map();
    this._pageBusy = true;
    this._pageBusyMsg = 'Loading preview…';
    try {
      const { rows } = await this.pageStore().pageReferenceStatus(ref);
      // A newer selection may have superseded this one while the fetch was in
      // flight — don't overwrite the current page's canvas with a stale response.
      if (this._pageRef !== ref) return;
      const byLocale = new Map(rows.map((r) => [r.locale, r]));
      const riskState = (r) => {
        if (r.status === 'missing') return 'missing';
        return r.stale ? 'stale' : 'current';
      };
      this._pageRisk = rows.map((r) => ({ locale: r.locale, state: riskState(r) }));
      const results = new Map();
      [...this._localeSel].forEach((locale) => {
        const row = byLocale.get(locale);
        if (!row || row.status === 'missing') return;
        const stage = row.status === 'live' ? 'live' : 'staged';
        const slug = row.slug || ref;
        results.set(locale, {
          ok: true,
          kind: row.status,
          ref,
          slug,
          mode: row.status === 'live' ? 'locale-root' : 'sandbox',
          sourceUrl: this.pageEdgeUrl(ref),
          liveUrl: this.localizedEdgeUrl(ref, locale, stage, slug),
          path: row.status === 'live' ? `/${locale}/${slug}` : `/meridian/live/${locale}/${slug}`,
        });
      });
      this._pageResults = results;
      // Open the first comparison so the side-by-side shows without a click.
      if (results.size) this._previewOpen = new Set([[...results.keys()][0]]);
    } catch (e) {
      if (this._pageRef === ref) this._pageError = e.message;
    } finally {
      if (this._pageRef === ref) this._pageBusy = false;
    }
  }

  // TRANSLATE: language layer only, published immediately (the fast path). The
  // withheld commercial/compliance segments stay in the source language.
  // Refuse to discard hand-authored, unpublished overrides silently. Returns
  // true (and sets the error) when there is pending work to protect.
  guardPendingDrafts() {
    if (hasPendingOverrides(this._localizeDrafts.values())) {
      this._pageError = 'You have unpublished market overrides — Publish them, or Clear drafts, first.';
      return true;
    }
    return false;
  }

  clearDrafts() {
    this._localizeDrafts = new Map();
    this._localizeStore = null;
    this._localizeOrg = '';
    this._localizeSite = '';
    this._pageError = '';
  }

  // Update one page-result row immutably (Lit reactivity: new Map).
  patchResult(locale, patch) {
    const cur = this._pageResults.get(locale);
    if (!cur) return;
    this._pageResults = new Map(this._pageResults).set(locale, { ...cur, ...patch });
  }

  // Promote a reviewed sandbox page straight to the live locale URL (self-review
  // path). Routes to the market's target site; records the manifest + hreflang.
  async promoteToLive(locale, ref, slug) {
    this._pageBusy = true;
    this._pageError = '';
    try {
      this._pageBusyMsg = `Promoting ${locale} to live…`;
      // The sandbox page lives at its (possibly translated) slug; promote reads
      // and republishes at that path, while the manifest keeps the source ref.
      const target = slug || ref;
      const pub = await this.storeForSite(this.siteForLocale(locale)).promotePage(locale, target);
      await this.saveManagedGrouped([{
        ref, locale, mode: 'locale-root', slug: target,
      }]);
      this.patchResult(locale, { promoted: true, liveUrl: pub.liveUrl, path: pub.path });
      this.showToast(`Promoted ${locale} → live (${pub.path})`);
    } catch (e) {
      this._pageError = `Promote failed for ${locale}: ${e.message}`;
    } finally {
      this._pageBusy = false;
    }
  }

  // Remove a promotion request from the local view + pending set (after it's
  // been approved/rejected server-side) so the pending-merge in loadQueue can't
  // resurrect it.
  dropPromotion(locale, ref) {
    const key = `${locale}:${ref}`;
    this._pendingPromoKeys = new Set([...this._pendingPromoKeys].filter((k) => k !== key));
    this._promotions = this._promotions.filter((p) => `${p.locale}:${p.ref}` !== key);
  }

  // Open the Approvals tab and refresh from the server so a reviewer sees
  // requests filed since the last load (the tab is otherwise passive).
  openApprovals() {
    this._tab = 'taste';
    this.loadQueue();
  }

  // Request approval instead of promoting directly (governed path): file a
  // promotion request a different reviewer approves in the Approvals tab.
  async requestPromotion(locale, ref, slug) {
    this._pageBusy = true;
    this._pageError = '';
    try {
      this._pageBusyMsg = `Requesting approval for ${locale}…`;
      const record = {
        ref,
        locale,
        // The reviewed sandbox page's (possibly translated) slug, so the approver
        // promotes the right path even when slug translation is on.
        ...(slug && slug !== ref ? { slug } : {}),
        site: this.siteForLocale(locale),
        requestedBy: (this.context && this.context.user && this.context.user.email) || 'author',
        at: Date.now(),
      };
      await this.storeForSite(this.siteForLocale(locale)).writePromotionRequest(record);
      // Show it in Approvals immediately. DA's /list index lags a fresh source
      // write, so we can't rely on a reload here — insert optimistically and
      // track it as pending until a later server list confirms it.
      const key = `${locale}:${ref}`;
      this._pendingPromoKeys = new Set(this._pendingPromoKeys).add(key);
      const others = this._promotions.filter((p) => `${p.locale}:${p.ref}` !== key);
      this._promotions = [...others, record];
      this.patchResult(locale, { requested: true });
      this.showToast(`Approval requested for ${locale} — a reviewer can approve it in Approvals.`);
    } catch (e) {
      this._pageError = `Could not request approval for ${locale}: ${e.message}`;
    } finally {
      this._pageBusy = false;
    }
  }

  // Reviewer approves a promotion request → promote the reviewed page to live and
  // clear the request. Runs under the approver's own DA session.
  async approvePromotion(item) {
    const key = `promo:${item.locale}:${item.ref}`;
    this._queueBusy = new Set(this._queueBusy).add(key);
    try {
      const store = this.storeForSite(item.site || this.siteForLocale(item.locale));
      const target = item.slug || item.ref;
      await store.promotePage(item.locale, target);
      await this.saveManagedGrouped([{
        ref: item.ref, locale: item.locale, mode: 'locale-root', slug: target,
      }]);
      await store.removePromotionRequest(item.locale, item.ref);
      this.dropPromotion(item.locale, item.ref);
      this.showToast(`Approved & promoted ${item.locale} / ${item.ref} → live`);
      await this.loadQueue();
    } catch (e) {
      this._error = `Approve failed: ${e.message}`;
    } finally {
      const next = new Set(this._queueBusy);
      next.delete(key);
      this._queueBusy = next;
    }
  }

  async rejectPromotion(item) {
    const key = `promo:${item.locale}:${item.ref}`;
    if (this._queueBusy.has(key)) return;
    this._queueBusy = new Set(this._queueBusy).add(key);
    try {
      await this.storeForSite(item.site || this.siteForLocale(item.locale))
        .removePromotionRequest(item.locale, item.ref);
      this.dropPromotion(item.locale, item.ref);
      await this.loadQueue();
    } catch (e) {
      this._error = `Reject failed: ${e.message}`;
    } finally {
      const next = new Set(this._queueBusy);
      next.delete(key);
      this._queueBusy = next;
    }
  }

  // TM is an asset/cache layer — a save failure must never fail the primary
  // translate/publish path, so persistence is best-effort and only warns.
  // eslint-disable-next-line class-methods-use-this
  async saveTm(store, tm, updates, origin, locale) {
    try {
      await store.writeTm(tmRecord(tm, updates, { origin, locale }));
    } catch (e) {
      console.warn(`Translation memory save failed for ${locale}:`, e.message);
    }
  }

  // Record what we materialized so the dashboard can enumerate managed pages
  // (essential once they publish to clean locale roots) and the hreflang index
  // stays current. Best-effort: the pages are already live, so an index hiccup
  // must never surface as a failure.
  // eslint-disable-next-line class-methods-use-this
  async saveManaged(store, entries) {
    if (!entries.length) return;
    try {
      await store.recordManaged(entries);
    } catch (e) {
      console.warn('Managed manifest / hreflang update failed:', e.message);
    }
  }

  // Record entries against the RIGHT site's manifest — a batch may span markets
  // that publish into different repos, so group by target site first.
  async saveManagedGrouped(entries) {
    if (!entries.length) return;
    const grouped = this.groupBySite(entries.map((e) => e.locale));
    await Promise.all([...grouped].map(([site, locales]) => {
      const list = entries.filter((e) => locales.includes(e.locale));
      return this.saveManaged(this.storeForSite(site), list);
    }));
  }

  // Partition locale tokens by their target repo (base site unless the DA config
  // routes a market elsewhere). Returns Map<site, locale[]>.
  groupBySite(locales) {
    const bySite = new Map();
    locales.forEach((code) => {
      const site = this.siteForLocale(code);
      if (!bySite.has(site)) bySite.set(site, []);
      bySite.get(site).push(code);
    });
    return bySite;
  }

  // Per-page risk radar across markets that may live in different repos: query
  // each target site's store, then merge back into the requested locale order.
  async pageRiskMultiSite(ref, locales, mode) {
    const byLocale = new Map();
    await Promise.all([...this.groupBySite(locales)].map(async ([site, locs]) => {
      const rows = await this.storeForSite(site).pageRisk(ref, locs, mode);
      rows.forEach((r) => byLocale.set(r.locale, r));
    }));
    return locales.map((code) => byLocale.get(code) || { locale: code, state: 'missing' });
  }

  // The ref a market publishes under. With slug translation on, the page's
  // last-segment name is machine-translated and slugified so the localized page
  // lands at /es/financiacion instead of /es/financing; the source ref stays the
  // manifest identity. `existing` is the target site's manifest entries, used to
  // (a) REUSE an already-chosen slug so a re-run never re-translates and orphans
  // the live URL, and (b) de-duplicate against other pages' slugs in this locale
  // so two source names that translate alike can't clobber each other. Best-
  // effort: off, empty, or any failure returns the source ref.
  async localizedRefFor(page, locale, translate, existing = []) {
    if (!this._translateSlug) return page;
    const prior = existing.find((e) => e.ref === page && e.locale === locale && e.slug);
    if (prior) return prior.slug;
    const name = humanizeSlug(page.split('/').pop());
    if (!name) return page;
    try {
      const m = await translate([name], { from: this._sourceLocale, to: locale });
      const taken = new Set(existing
        .filter((e) => e.locale === locale && e.ref !== page && e.slug)
        .map((e) => e.slug));
      return chooseSlug(page, (m && m.get && m.get(name)) || name, taken);
    } catch {
      return page;
    }
  }

  async translatePages() {
    const ctx = this.pageInputs();
    if (ctx.error) { this._pageError = ctx.error; return; }
    if (this.guardPendingDrafts()) return;
    this._pageBusy = true;
    this._pageError = '';
    this._pageResults = new Map();
    this._localizeDrafts = new Map();
    const mode = this._publishMode;
    this._pageBusyMsg = `Translating ${ctx.ref} → ${ctx.locales.length} market(s)…`;
    try {
      const source = await ctx.store.readPageHtml(ctx.ref);
      const dnt = await ctx.store.readDnt().catch(() => []);
      const tasks = ctx.locales.map((locale) => async () => {
        try {
          // The market may publish into its own repo (DA `site` column); TM lives
          // with the localized page, so read/write it on the target store too.
          const targetStore = this.storeForSite(this.siteForLocale(locale));
          const tm = await targetStore.readTm(locale);
          const tmt = createTmTranslator({ tm, translate: ctx.translate });
          const out = await localizePage(source, tmt.translate, { to: locale, dnt });
          // Learn only the translations that PASSED the quality gate (out.dict),
          // never the flagged ones — TM stores approved translations.
          const learned = new Map([...tmt.learned].filter(([s]) => out.dict.has(s)));
          if (learned.size) await this.saveTm(targetStore, tm, learned, 'mt', locale);
          const managed = this._translateSlug
            ? await targetStore.readManaged().catch(() => [])
            : [];
          const targetRef = await this.localizedRefFor(ctx.ref, locale, ctx.translate, managed);
          await targetStore.writeLocalizedPage(locale, targetRef, out.html, mode);
          const pub = await targetStore.publishLocalizedPage(locale, targetRef, mode);
          return [locale, {
            ok: true,
            kind: 'translate',
            locale,
            ref: ctx.ref,
            slug: targetRef,
            mode,
            coverage: out.coverage,
            review: out.review,
            memory: tmLeverage(tmt.stats),
            sourceUrl: this.pageEdgeUrl(ctx.ref),
            ...pub,
          }];
        } catch (e) {
          return [locale, { ok: false, error: e.message }];
        }
      });
      const settled = await runWithConcurrency(tasks, 3);
      this._pageResults = new Map(settled.map((s) => s.value));
      const ok = [...this._pageResults.values()].filter((r) => r.ok).length;
      await this.saveManagedGrouped([...this._pageResults]
        .filter(([, r]) => r.ok).map(([locale, r]) => ({
          ref: ctx.ref, locale, mode, slug: r.slug,
        })));
      if (ok) this.showToast(`Translated & published ${ok} market(s) of ${ctx.ref}`);
    } catch (e) {
      this._pageError = e.message;
    } finally {
      this._pageBusy = false;
    }
  }

  // BULK: translate + publish every page under the selected page's folder,
  // across the chosen languages (fast path, language layer only). Capped and
  // concurrency-limited. Results render in their own compact table.
  async translateFolder() {
    const ctx = this.pageInputs();
    if (ctx.error) { this._pageError = ctx.error; return; }
    if (this.guardPendingDrafts()) return;
    await this.loadAllPages();
    const folder = ctx.ref.includes('/') ? ctx.ref.slice(0, ctx.ref.lastIndexOf('/')) : '';
    const pages = (this._allPages || [])
      .filter((p) => (folder ? p === ctx.ref || p.startsWith(`${folder}/`) : true))
      .slice(0, 25);
    if (!pages.length) { this._pageError = 'No pages found to bulk-translate.'; return; }
    await this.runBulkTranslate(ctx, pages, `under ${folder || 'the site'}`);
  }

  // Batch translate + publish a set of pages × the chosen markets (fast path,
  // language layer only). Shared by "Translate folder" and "Translate selected".
  async runBulkTranslate(ctx, pages, label) {
    this._pageBusy = true;
    this._pageError = '';
    this._bulkResults = [];
    this._pageResults = new Map();
    const mode = this._publishMode;
    this._pageBusyMsg = `Translating ${pages.length} page(s) × ${ctx.locales.length} market(s)…`;
    try {
      const dnt = await ctx.store.readDnt().catch(() => []);
      // Read each page's source ONCE (not once per locale).
      const sourceByPage = new Map();
      await runWithConcurrency(pages.map((p) => async () => {
        try {
          sourceByPage.set(p, await ctx.store.readPageHtml(p));
        } catch {
          sourceByPage.set(p, null);
        }
      }), 4);
      // Read each locale's TM once and accumulate learnings to write back once,
      // so concurrent page tasks for the same locale can't clobber each other.
      const tmByLocale = new Map();
      const learnedByLocale = new Map();
      await runWithConcurrency(ctx.locales.map((locale) => async () => {
        tmByLocale.set(locale, await this.storeForSite(this.siteForLocale(locale)).readTm(locale));
        learnedByLocale.set(locale, new Map());
      }), 4);

      // Slug translation: pre-compute each page's localized slug per locale in a
      // single sequential pass (keyed `${p}|${locale}`), so a re-run reuses the
      // chosen slug and no two pages in this batch collide — the concurrent
      // translate tasks below just look theirs up.
      const slugMap = new Map();
      if (this._translateSlug) {
        await runWithConcurrency(ctx.locales.map((locale) => async () => {
          const store = this.storeForSite(this.siteForLocale(locale));
          const chosen = [...(await store.readManaged().catch(() => []))];
          await pages.reduce((prev, p) => prev.then(async () => {
            const ref = await this.localizedRefFor(p, locale, ctx.translate, chosen);
            slugMap.set(`${p}|${locale}`, ref);
            chosen.push({ ref: p, locale, slug: ref });
          }), Promise.resolve());
        }), 4);
      }

      const tasks = [];
      pages.forEach((p) => ctx.locales.forEach((locale) => {
        tasks.push(async () => {
          const source = sourceByPage.get(p);
          if (source == null) {
            return {
              ref: p, locale, ok: false, error: 'Could not read source page',
            };
          }
          try {
            const tmt = createTmTranslator({
              tm: tmByLocale.get(locale), translate: ctx.translate,
            });
            const out = await localizePage(source, tmt.translate, { to: locale, dnt });
            const acc = learnedByLocale.get(locale);
            tmt.learned.forEach((t, s) => { if (out.dict.has(s)) acc.set(s, t); });
            const targetStore = this.storeForSite(this.siteForLocale(locale));
            const targetRef = this._translateSlug ? (slugMap.get(`${p}|${locale}`) || p) : p;
            await targetStore.writeLocalizedPage(locale, targetRef, out.html, mode);
            const pub = await targetStore.publishLocalizedPage(locale, targetRef, mode);
            const pct = Math.round((out.coverage?.ratio ?? 0) * 100);
            return {
              ref: p, locale, slug: targetRef, ok: true, pct, liveUrl: pub.liveUrl,
            };
          } catch (e) {
            return {
              ref: p, locale, ok: false, error: e.message,
            };
          }
        });
      }));
      const settled = await runWithConcurrency(tasks, 3);
      this._bulkResults = settled.map((s) => s.value);
      // One merged TM write per locale, on that market's target store.
      await runWithConcurrency(ctx.locales.map((locale) => async () => {
        const acc = learnedByLocale.get(locale);
        const targetStore = this.storeForSite(this.siteForLocale(locale));
        if (acc.size) await this.saveTm(targetStore, tmByLocale.get(locale), acc, 'mt', locale);
      }), 4);
      const ok = this._bulkResults.filter((r) => r.ok).length;
      await this.saveManagedGrouped(this._bulkResults
        .filter((r) => r.ok).map((r) => ({
          ref: r.ref, locale: r.locale, mode, slug: r.slug,
        })));
      this.showToast(`Translated ${ok}/${this._bulkResults.length} page × market ${label || ''}`.trim());
    } catch (e) {
      this._pageError = e.message;
    } finally {
      this._pageBusy = false;
    }
  }

  // Translate every checked page in one batch (multi-select), across the chosen
  // markets. Localize stays single-page (it needs per-page human authoring).
  async translateSelected() {
    if (this.guardPendingDrafts()) return;
    if (!this._org || !this._site) { this._pageError = 'Set org/site first.'; return; }
    const pages = [...this._selectedPages].slice(0, 50);
    if (!pages.length) { this._pageError = 'Select at least one page (check the boxes).'; return; }
    const locales = [...this._localeSel];
    if (!locales.length) { this._pageError = 'Pick at least one target market.'; return; }
    const cfg = this._config || {};
    const ctx = {
      locales,
      store: this.pageStore(),
      translate: createTranslator(daFetch, {
        org: this._org, site: this._site, formality: cfg.formality, glossaries: cfg.glossaries,
      }),
    };
    await this.runBulkTranslate(ctx, pages, `${pages.length} selected page(s)`);
  }

  // LOCALIZE step 1: translate the language layer, then stage the withheld
  // commercial/compliance segments for human authoring before any publish.
  async startLocalize() {
    const ctx = this.pageInputs();
    if (ctx.error) { this._pageError = ctx.error; return; }
    if (this.guardPendingDrafts()) return;
    this._pageBusy = true;
    this._pageError = '';
    this._pageResults = new Map();
    this._localizeDrafts = new Map();
    try {
      this._pageBusyMsg = `Preparing ${ctx.ref} for ${ctx.locales.length} market(s)…`;
      this._localizeSource = await ctx.store.readPageHtml(ctx.ref);
      this._localizeRef = ctx.ref;
      // Bind the draft to the exact store + base org/site it was staged against,
      // so a later Publish can detect a since-repointed org/site and refuse.
      this._localizeStore = ctx.store;
      this._localizeOrg = this._org;
      this._localizeSite = this._site;
      const dnt = await ctx.store.readDnt().catch(() => []);
      const tasks = ctx.locales.map((locale) => async () => {
        try {
          // TM lives with the localized page — on the market's target store.
          const targetStore = this.storeForSite(this.siteForLocale(locale));
          const tm = await targetStore.readTm(locale);
          const tmt = createTmTranslator({ tm, translate: ctx.translate });
          const out = await localizePage(this._localizeSource, tmt.translate, { to: locale, dnt });
          const learned = new Map([...tmt.learned].filter(([s]) => out.dict.has(s)));
          if (learned.size) await this.saveTm(targetStore, tm, learned, 'mt', locale);
          // Prefill each review field: a low-confidence language segment starts
          // from its machine attempt (to verify/fix); commercial/compliance
          // start from any prior human sign-off in TM (reuse, not re-authoring).
          const tmHits = tmLookup(tm, out.review.map((seg) => seg.source)).hits;
          const overrides = {};
          out.review.forEach((seg) => {
            if (seg.suggested != null) overrides[seg.source] = seg.suggested;
            else if (tmHits.has(seg.source)) overrides[seg.source] = tmHits.get(seg.source);
          });
          return [locale, {
            ok: true,
            dict: out.dict,
            review: out.review,
            coverage: out.coverage,
            memory: tmLeverage(tmt.stats),
            overrides,
          }];
        } catch (e) {
          return [locale, { ok: false, error: e.message }];
        }
      });
      const settled = await runWithConcurrency(tasks, 3);
      this._localizeDrafts = new Map(settled.map((s) => s.value));
    } catch (e) {
      this._pageError = e.message;
    } finally {
      this._pageBusy = false;
    }
  }

  setOverride(locale, source, value) {
    const draft = this._localizeDrafts.get(locale);
    if (!draft) return;
    const next = new Map(this._localizeDrafts);
    next.set(locale, { ...draft, overrides: { ...draft.overrides, [source]: value } });
    this._localizeDrafts = next;
  }

  // LOCALIZE step 2: merge language translations + the human-authored market
  // overrides and publish the fully localized page for one market.
  async publishLocalized(locale) {
    const draft = this._localizeDrafts.get(locale);
    if (!draft?.ok || !this._localizeStore) return;
    // Refuse if org OR site was repointed after the draft was staged (the target
    // store is resolved against the current org/site, so a repoint would
    // mis-target — including a same-named site under a different org).
    if (this._org !== this._localizeOrg || this._site !== this._localizeSite) {
      this._pageError = 'Org/site changed since this draft was staged — re-run Localize.';
      return;
    }
    // The market may publish into its own repo (DA `site` column).
    const store = this.storeForSite(this.siteForLocale(locale));
    this._pageBusy = true;
    this._pageError = '';
    const mode = this._publishMode;
    try {
      // An override only counts as "authored" if it is non-blank AND — for a
      // low-confidence language suggestion — actually edited away from the
      // machine attempt. An untouched failed suggestion is NEVER published and
      // never recorded as human sign-off (it stays in source language).
      const suggestions = new Map(
        draft.review
          .filter((s) => s.suggested != null)
          .map((s) => [s.source, String(s.suggested).trim()]),
      );
      const authored = Object.fromEntries(
        Object.entries(draft.overrides).filter(([src, v]) => {
          const val = (v ?? '').trim();
          // Non-blank AND actually changed from what the machine produced —
          // whether that's a flagged suggestion or a full segment's translation
          // — so an untouched value is never published or stamped human TM.
          const machine = String(draft.dict.get(src) ?? '').trim();
          return val && val !== suggestions.get(src) && val !== machine;
        }),
      );
      this._pageBusyMsg = `Publishing ${locale}…`;
      const localizedHtml = applyLocalization(this._localizeSource, draft.dict, authored);
      const cfg = this._config || {};
      const translate = createTranslator(daFetch, {
        org: this._org, site: this._site, formality: cfg.formality, glossaries: cfg.glossaries,
      });
      const existing = this._translateSlug ? await store.readManaged().catch(() => []) : [];
      const targetRef = await this.localizedRefFor(this._localizeRef, locale, translate, existing);
      await store.writeLocalizedPage(locale, targetRef, localizedHtml, mode);
      const pub = await store.publishLocalizedPage(locale, targetRef, mode);
      // Commit the successful publish (result + drop the draft) BEFORE touching
      // TM, so a TM hiccup can never mislabel a live page as failed or lose the
      // draft.
      const heldDone = Object.keys(authored).length;
      this._pageResults = new Map(this._pageResults).set(locale, {
        ok: true,
        kind: 'localize',
        ref: this._localizeRef,
        slug: targetRef,
        mode,
        coverage: draft.coverage,
        heldTotal: draft.review.length,
        heldDone,
        memory: draft.memory,
        sourceUrl: this.pageEdgeUrl(this._localizeRef),
        ...pub,
      });
      const drafts = new Map(this._localizeDrafts);
      drafts.delete(locale);
      this._localizeDrafts = drafts;
      this.showToast(`Localized & published ${locale} — live`);
      await this.saveManaged(store, [{
        ref: this._localizeRef, locale, mode, slug: targetRef,
      }]);
      // Human sign-off becomes durable TM (origin human), reused next run — but
      // it is best-effort: the page is already live.
      if (heldDone) await this.saveTm(store, await store.readTm(locale), authored, 'human', locale);
    } catch (e) {
      this._pageError = `Publish failed for ${locale}: ${e.message}`;
    } finally {
      this._pageBusy = false;
    }
  }

  // Row overflow menu (shared nx-popover): secondary actions (copy link, edit in
  // EW) kept out of the row until asked for; primary actions stay inline.
  async openRowMenu(e, r) {
    this._rowMenu = r;
    const anchor = e.currentTarget;
    await this.updateComplete;
    this.shadowRoot.querySelector('.mrd-row-more-menu')?.show({ anchor, placement: 'below-end' });
  }

  renderRowMenu(r) {
    const close = () => this.shadowRoot.querySelector('.mrd-row-more-menu')?.close();
    return html`
      <button class="mrd-page-link-btn" @click=${() => { this.copyLink(r.liveUrl); close(); }}>
        <span aria-hidden="true">⧉</span> Copy link</button>
      ${r.path ? html`
        <a class="mrd-page-link" href=${this.daEditUrl(r.path)} target="_blank" rel="noopener"
          @click=${close}>Edit in EW ↗</a>` : nothing}`;
  }

  renderPageResult(locale, r) {
    if (!r.ok) {
      return html`
        <div class="mrd-market">
          <div class="mrd-market-head">
            <span class="mrd-locale">${locale}</span>
            <span class="mrd-kind mrd-critical">failed</span>
          </div>
          <div class="mrd-detail">${r.error}</div>
        </div>`;
    }
    const pct = Math.round((r.coverage?.ratio ?? 0) * 100);
    const mem = r.memory ? ` · ${r.memory}% from memory` : '';
    let badge = `translated · language ${pct}%${mem}`;
    if (r.kind === 'staged') badge = 'staged — review, then promote';
    else if (r.kind === 'live') badge = 'live — published';
    else if (r.kind === 'localize') badge = `localized · language ${pct}% · market ${r.heldDone}/${r.heldTotal}${mem}`;
    const previewing = this._previewOpen.has(locale);
    // The source pane is the picked page by default, but can compare against the
    // base language or any market's version of the same page (see compareSource).
    const cs = this.compareSource();
    const pickedSeg = (this._pageRef || '').split('/')[0];
    const pickedLoc = (this._catalog?.all || []).includes(pickedSeg) ? pickedSeg : this._sourceLocale;
    const cmpMarkets = this._catalog?.all || [];
    return html`
      <div class="mrd-market">
        <div class="mrd-market-head">
          <span class="mrd-locale">${locale}</span>
          <span class="mrd-kind mrd-positive">${badge}</span>
          <button class="mrd-preview-toggle" @click=${() => this.togglePreview(locale)}>
            ${previewing ? 'Hide preview' : 'Preview'}
          </button>
          <span class="mrd-market-actions">
            <a class="mrd-page-link" href=${r.liveUrl} target="_blank" rel="noopener">View live page ↗</a>
            ${r.mode === 'sandbox' && r.ref && !r.promoted ? html`
              <sl-button ?disabled=${this._pageBusy}
                title="Publish this reviewed page to the live /${locale}/ URL"
                @click=${() => this.promoteToLive(locale, r.ref, r.slug)}>Promote to live ↑</sl-button>
              <sl-button class="primary outline" ?disabled=${this._pageBusy || r.requested}
                @click=${() => this.requestPromotion(locale, r.ref, r.slug)}>${r.requested ? 'Approval requested ✓' : 'Request approval'}</sl-button>
            ` : nothing}
            ${r.promoted ? html`<span class="mrd-kind mrd-positive">promoted → live</span>` : nothing}
            <sl-button class="mrd-row-more" title="More actions" ?disabled=${this._pageBusy}
              @click=${(e) => this.openRowMenu(e, r)}>⋯</sl-button>
          </span>
        </div>
        ${r.kind === 'translate' && r.review?.length ? html`
          <div class="mrd-entry-meta">
            ${r.review.length} segment(s) held in source language (market copy + low-confidence
            translations) — use Localize to resolve them per market.
          </div>` : nothing}
        ${previewing ? html`
          <div class="mrd-preview">
            <div class="mrd-preview-pane">
              <div class="mrd-preview-label">
                Source (${cs.loc})
                <select class="mrd-cmp-src" title="Compare against a different source"
                  style="margin-left:8px;font:inherit;font-size:12px;text-transform:none;letter-spacing:normal;"
                  @change=${(e) => { this._compareSource = e.target.value; }}>
                  <option value="" ?selected=${!this._compareSource}>This page (${pickedLoc})</option>
                  <option value="__base__" ?selected=${this._compareSource === '__base__'}>${this._sourceLocale} source</option>
                  ${cmpMarkets.map((m) => html`<option value=${m} ?selected=${this._compareSource === m}>${m}</option>`)}
                </select>
              </div>
              <iframe class="mrd-preview-frame" title="Source page (${cs.loc})"
                src=${cs.url} loading="lazy"
                sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
            </div>
            <div class="mrd-preview-pane">
              <div class="mrd-preview-label">${locale} (localized)</div>
              <iframe class="mrd-preview-frame" title="Localized page ${locale}"
                src=${r.liveUrl} loading="lazy"
                sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
            </div>
          </div>
          <div class="mrd-entry-meta">
            If a pane is blank, the site blocks framing — open
            <a class="mrd-page-link-inline" href=${cs.url} target="_blank" rel="noopener">source</a>
            /
            <a class="mrd-page-link-inline" href=${r.liveUrl} target="_blank" rel="noopener">localized</a>
            in new tabs.
          </div>` : nothing}
      </div>`;
  }

  renderOverride(locale, seg, draft) {
    const isQuality = seg.layer === 'language';
    const chip = isQuality ? 'low-confidence' : seg.layer;
    const severity = seg.layer === 'compliance' ? 'critical' : 'warning';
    return html`
      <label class="mrd-override">
        <span class="mrd-override-cap">
          <span class="mrd-kind mrd-${severity}">${chip}</span>
          ${seg.source}
        </span>
        ${isQuality && seg.issues?.length ? html`
          <span class="mrd-override-issues">${seg.issues.map((i) => i.detail).join('; ')}</span>` : nothing}
        <textarea class="mrd-override-input" ?disabled=${this._pageBusy}
          placeholder=${isQuality
    ? `Verify/fix the ${locale} translation (blank = keep source language)`
    : `Market ${seg.layer} text for ${locale} (blank = keep source language)`}
          .value=${draft.overrides[seg.source] ?? ''}
          @change=${(e) => this.setOverride(locale, seg.source, e.target.value)}></textarea>
      </label>`;
  }

  renderLocalizeDraft(locale, draft) {
    if (!draft.ok) {
      return html`
        <div class="mrd-market">
          <div class="mrd-market-head">
            <span class="mrd-locale">${locale}</span>
            <span class="mrd-kind mrd-critical">failed</span>
          </div>
          <div class="mrd-detail">${draft.error}</div>
        </div>`;
    }
    const pct = Math.round((draft.coverage?.ratio ?? 0) * 100);
    return html`
      <div class="mrd-market">
        <div class="mrd-market-head">
          <span class="mrd-locale">${locale}</span>
          <span class="mrd-kind mrd-positive">
            language ${pct}% translated${draft.memory ? ` · ${draft.memory}% from memory` : ''}
          </span>
          <sl-button class="mrd-page-publish primary outline" ?disabled=${this._pageBusy}
            @click=${() => { this._pageError = ''; this._overlayLocale = locale; }}>Review &amp; edit</sl-button>
          <sl-button ?disabled=${this._pageBusy}
            @click=${() => this.publishLocalized(locale)}>
            ${this._pageBusy ? 'Publishing…' : `Publish ${locale}`}
          </sl-button>
        </div>
        ${draft.review.length ? html`
          <div class="mrd-entry-meta">
            Resolve the ${draft.review.length} held segment(s) — market copy to <em>author</em>
            (machine never writes these) and low-confidence translations to <em>verify</em>
            (prefilled from the machine attempt or prior sign-off):
          </div>
          ${draft.review.map((seg) => this.renderOverride(locale, seg, draft))}
        ` : html`<div class="mrd-entry-meta">Nothing held — publish to finish.</div>`}
        ${draft.dict && draft.dict.size ? html`
          <button class="mrd-seg-toggle" @click=${() => this.toggleSegEdit(locale)}>
            ${this._segEditOpen.has(locale) ? 'Hide' : 'Edit'} the ${draft.dict.size} translated segment(s)
          </button>
          ${this._segEditOpen.has(locale) ? html`
            <div class="mrd-entry-meta">
              Fix any machine translation before publishing — edits override the machine output.
            </div>
            ${[...draft.dict].map(([source, target]) => html`
              <label class="mrd-override">
                <span class="mrd-override-cap"><span class="mrd-kind">language</span> ${source}</span>
                <textarea class="mrd-override-input" ?disabled=${this._pageBusy}
                  .value=${draft.overrides[source] ?? target}
                  @change=${(e) => this.setOverride(locale, source, e.target.value)}></textarea>
              </label>`)}` : nothing}` : nothing}
      </div>`;
  }

  renderTreeLevel(path) {
    const kids = this._pageTree.get(path);
    if (!kids) return html`<div class="mrd-tree-note">Loading…</div>`;
    if (!kids.length) return html`<div class="mrd-tree-note">(empty)</div>`;
    return html`<ul class="mrd-tree-list" role="group">${kids.map((n) => this.renderTreeNode(n))}</ul>`;
  }

  renderTreeNode(node) {
    if (node.isFolder) {
      const open = this._pageExpanded.has(node.path);
      return html`
        <li role="none">
          <button class="mrd-tree-folder" role="treeitem" aria-expanded=${open}
            @click=${() => this.toggleFolder(node.path)}>
            <span class="mrd-tree-caret" aria-hidden="true">${open ? '▾' : '▸'}</span> ${node.name}
          </button>
          ${open ? this.renderTreeLevel(node.path) : nothing}
        </li>`;
    }
    const ref = node.path.replace(/^\/+/, '').replace(/\.html$/, '');
    return this.renderPagePickRow(ref, node.name.replace(/\.html$/, ''));
  }

  // One selectable page: a checkbox (adds to the batch selection) + the name
  // (single-select for per-page actions) + inline status chips showing which
  // markets it already has (so you can skip done pages).
  renderPagePickRow(ref, displayName) {
    const checked = this._selectedPages.has(ref);
    const sel = ref === this._pageRef;
    const status = this.pageStatus(ref);
    return html`
      <li role="none" class="mrd-pick-row">
        <input type="checkbox" class="mrd-pick-check" ?checked=${checked}
          aria-label="Select ${ref} for batch translate"
          @change=${() => this.toggleSelectPage(ref)} />
        <button class="mrd-tree-page ${sel ? 'sel' : ''}" role="treeitem" aria-selected=${sel}
          @click=${() => this.pickPage(ref)}>${displayName}</button>
        ${status.length ? html`<span class="mrd-pick-status">${status.map((s) => html`
          <span class="mrd-risk-chip mrd-risk-${s.stage === 'live' ? 'current' : 'staged'}"
            title="${s.locale}: ${s.stage}">${s.locale}</span>`)}</span>` : nothing}
      </li>`;
  }

  renderPages() {
    // The comparison/result is the payoff — it lives in the right-hand canvas so
    // it's always on screen next to the controls (TMS workbench pattern), instead
    // of stacked below a full-height page tree.
    const hasCanvas = this._pageBusy || this._bulkResults.length || this._pageRisk.length
      || this._pageError || this._localizeDrafts.size || this._pageResults.size;
    // Localize drafts belong to one page (_localizeRef). Only show the editor on
    // that page; on any other page surface a banner instead of leaking a stale
    // editor into the wrong page's canvas (drafts are kept, never silently lost).
    const draftsHere = this._localizeDrafts.size && this._localizeRef === this._pageRef;
    const draftsElsewhere = this._localizeDrafts.size && this._localizeRef
      && this._localizeRef !== this._pageRef;
    return html`
      <nx-popover class="mrd-row-more-menu" @close=${() => { this._rowMenu = null; }}>
        ${this._rowMenu ? this.renderRowMenu(this._rowMenu) : nothing}
      </nx-popover>
      <div class="mrd-workbench">
        <aside class="mrd-rail" aria-label="Page and market controls">
          ${this._publishMode === 'locale-root' ? html`
            <div class="mrd-entry-meta mrd-mode-note">
              <strong>Direct publish is on</strong> (configured): pages go straight to real locale
              URLs (e.g. <code>/fr/${this._pageRef || 'page'}</code>), skipping the sandbox review
              step. Existing non-Meridian pages are still protected.
            </div>` : nothing}
          <div class="mrd-page-form">
            <label id="mrd-page-lbl">Page</label>
            <button class="mrd-page-pick" aria-labelledby="mrd-page-lbl" aria-haspopup="tree"
              aria-expanded=${this._browseOpen} ?disabled=${this._pageBusy}
              @click=${() => this.toggleBrowse()}>
              ${this._pageRef || 'Choose a page…'} <span class="mrd-tree-caret" aria-hidden="true">▾</span>
            </button>
            <label id="mrd-lang-lbl">Markets</label>
            <span class="mrd-lang-chips" role="group" aria-labelledby="mrd-lang-lbl">
              ${this.renderLangChips()}
            </span>
          </div>
          ${this._browseOpen ? html`
            <div class="mrd-tree" role="tree" aria-label="Site pages">
              <input class="mrd-tree-search" type="search" placeholder="Search pages…"
                aria-label="Search pages" .value=${this._treeQuery}
                @input=${(e) => { this._treeQuery = e.target.value; }} />
              ${this._treeQuery.trim() ? this.renderTreeSearch() : this.renderTreeLevel('')}
            </div>` : nothing}
          ${this._selectedPages.size ? html`
            <div class="mrd-selbar" role="group" aria-label="Selected pages">
              <span class="mrd-selbar-count">${this._selectedPages.size} page(s) selected</span>
              <sl-button ?disabled=${this._pageBusy}
                @click=${() => this.translateSelected()}>Translate &amp; publish selected</sl-button>
              <sl-button class="primary outline" ?disabled=${this._pageBusy}
                @click=${() => this.clearSelection()}>Clear selection</sl-button>
            </div>` : nothing}
          <div class="mrd-page-actions">
            <sl-button class="primary outline" ?disabled=${this._pageBusy}
              @click=${() => this.translatePages()}>Translate &amp; publish</sl-button>
            <sl-button ?disabled=${this._pageBusy} @click=${() => this.startLocalize()}>Localize</sl-button>
            <sl-button class="primary outline" ?disabled=${this._pageBusy}
              @click=${() => this.translateFolder()}>Translate folder</sl-button>
            <sl-button class="primary outline" ?disabled=${this._pageBusy}
              @click=${() => this.checkStatus()}>Check status</sl-button>
          </div>
          <label class="mrd-slug-toggle">
            <input type="checkbox" ?checked=${this._translateSlug} ?disabled=${this._pageBusy}
              @change=${(e) => { this._translateSlug = e.target.checked; }} />
            <span>Translate the page name (slug) &mdash; publishes at <code>/es/financiacion</code>, not <code>/es/financing</code></span>
          </label>
          <p class="mrd-action-help">
            <strong>Translate</strong> = language only (machine). <strong>Localize</strong> = language
            + market copy &amp; compliance you author (includes translation).
          </p>
        </aside>
        <section class="mrd-canvas" aria-label="Comparison and results">
          ${this._pageBusy ? html`
            <div class="mrd-busy" role="status" aria-live="polite">
              <span class="mrd-spinner" aria-hidden="true"></span>
              <span>${this._pageBusyMsg || 'Working…'}</span>
            </div>` : nothing}
          ${this._bulkResults.length ? html`
            <div class="mrd-section-label">Bulk translate — ${this._bulkResults.length} page × market</div>
            <div class="mrd-matrix-wrap">
              <table class="mrd-matrix">
                <thead>
                  <tr><th scope="col">Page</th><th scope="col">Market</th><th scope="col">Result</th><th></th></tr>
                </thead>
                <tbody>
                  ${this._bulkResults.map((r) => html`
                    <tr>
                      <td>${r.ref}</td>
                      <td>${r.locale}</td>
                      <td>${r.ok
    ? html`<span class="mrd-risk-chip mrd-risk-current">${r.pct}%</span>`
    : html`<span class="mrd-risk-chip mrd-risk-stale">failed</span>`}</td>
                      <td>${r.ok
    ? html`<a class="mrd-page-link-inline" href=${r.liveUrl} target="_blank" rel="noopener">view ↗</a>`
    : r.error}</td>
                    </tr>`)}
                </tbody>
              </table>
            </div>` : nothing}
          ${this._pageRisk.length ? html`
            <div class="mrd-risk">
              ${this._pageRisk.map((r) => html`
                <span class="mrd-risk-chip mrd-risk-${r.state}" title=${RISK_TIP[r.state]}>
                  <span class="mrd-risk-locale">${r.locale}</span> ${RISK_LABEL[r.state]}
                </span>`)}
            </div>` : nothing}
          ${this._pageError ? html`<div class="nx-alert warning">${this._pageError}</div>` : nothing}
          ${draftsElsewhere ? html`
            <div class="nx-alert warning mrd-draft-banner">
              <span>Unpublished market drafts on <strong>${this._localizeRef}</strong>.</span>
              <sl-button ?disabled=${this._pageBusy}
                @click=${() => this.pickPage(this._localizeRef)}>Resume ${this._localizeRef}</sl-button>
              <sl-button class="primary outline" ?disabled=${this._pageBusy}
                @click=${() => this.clearDrafts()}>Discard</sl-button>
            </div>` : nothing}
          ${draftsHere ? html`
            <div class="mrd-section-label">
              <span>Localize — author each market's commercial/compliance text, then publish per market:</span>
              <sl-button class="primary outline mrd-clear-drafts" ?disabled=${this._pageBusy}
                @click=${() => this.clearDrafts()}>Clear drafts</sl-button>
            </div>
            <div class="mrd-list">
              ${[...this._localizeDrafts].map(([l, d]) => this.renderLocalizeDraft(l, d))}
            </div>` : nothing}
          ${this._pageResults.size
    ? html`<div class="mrd-list">${[...this._pageResults].map(([l, r]) => this.renderPageResult(l, r))}</div>`
    : nothing}
          ${hasCanvas ? nothing : html`
            <div class="mrd-canvas-empty">
              <p>Pick a page and one or more markets, then <strong>Translate &amp; publish</strong> or
              <strong>Localize</strong>.</p>
              <p class="mrd-canvas-empty-sub">The source ↔ market comparison shows here, side by side,
              ready to review and promote.</p>
            </div>`}
        </section>
      </div>
    `;
  }

  // The localization dashboard: discover localized pages × markets and their
  // health once, on demand. Guarded so render-triggered loads run only once.
  async loadMatrix() {
    if (!this._org || !this._site || this._matrixBusy) return;
    this._matrixBusy = true;
    this._error = '';
    try {
      // Ensure the configured markets are known so the matrix shows every
      // target from DA's locale config — even ones not yet localized — not just
      // the folders that already exist.
      if (this._catalog === null) await this.loadCatalog();
      // Configured markets, minus the source language (its own pages aren't a market).
      const configured = (this._catalog?.all ?? []).filter((c) => c !== this._sourceLocale);
      // Markets can live in different repos, so compute a coverage sub-matrix per
      // target site (from each site's managed manifest) and merge by page. Scan the
      // base site plus any site the config routes a configured market to.
      const sites = new Set([this._site, ...configured.map((c) => this.siteForLocale(c))]);
      const rowsByRef = new Map(); // ref -> Map(locale -> cell)
      const localeSet = new Set(configured);
      await runWithConcurrency([...sites].map((site) => async () => {
        const store = this.storeForSite(site);
        const here = (code) => this.siteForLocale(code) === site && code !== this._sourceLocale;
        const siteLocales = new Set(configured.filter(here));
        const managed = await store.readManaged();
        managed.forEach((e) => {
          if (here(e.locale)) siteLocales.add(e.locale);
        });
        const locs = [...siteLocales];
        if (!locs.length) return;
        locs.forEach((l) => localeSet.add(l));
        (await store.promotionMatrix(locs, managed)).forEach((row) => {
          if (!rowsByRef.has(row.ref)) rowsByRef.set(row.ref, new Map());
          const rc = rowsByRef.get(row.ref);
          row.cells.forEach((c) => rc.set(c.locale, c));
        });
      }), 4);
      const locales = [...localeSet];
      const refs = [...rowsByRef.keys()].sort();
      this._matrixLocales = locales;
      this._matrix = refs.map((ref) => ({
        ref,
        cells: locales.map((loc) => rowsByRef.get(ref).get(loc) || {
          locale: loc, stage: 'none', fresh: 'missing', at: null,
        }),
      }));
    } catch (e) {
      this._error = e.message;
      this._matrix = [];
    } finally {
      this._matrixBusy = false;
    }
  }

  // Jump from a coverage cell straight into Localize, pre-scoped to that page +
  // market (act-from-dashboard, like the DA loc app's status list).
  localizeFromMatrix(ref, locale) {
    this._pageRef = ref;
    this._localeSel = new Set([locale]);
    this._pageRisk = [];
    this._tab = 'pages';
  }

  // The edge URL of a localized page for a dashboard cell: the live locale URL
  // when promoted, or the sandbox preview URL when only staged. Routes to the
  // market's target site (multi-site).
  localizedEdgeUrl(ref, locale, stage, slug) {
    const site = this.siteForLocale(locale);
    // The localized page may sit at a translated slug: prefer an explicit one,
    // else the manifest's, else the source ref.
    const entry = (this._managed || []).find((e) => e.ref === ref && e.locale === locale);
    const path = slug || (entry && entry.slug) || ref;
    const rel = stage === 'live' ? `/${locale}/${path}` : `/meridian/live/${locale}/${path}`;
    return `https://main--${site}--${this._org}.aem.live${rel}`;
  }

  // Launch into Pages to REVIEW a staged page and then promote it — seed a
  // promotable result row (from the manifest, no re-translation) so the author
  // lands on the page with Preview + Promote + Request approval ready.
  reviewStaged(ref, locale) {
    this._pageRef = ref;
    this._localeSel = new Set([locale]);
    this._pageError = '';
    const entry = (this._managed || []).find((e) => e.ref === ref && e.locale === locale);
    const slug = (entry && entry.slug) || ref;
    this._pageResults = new Map([[locale, {
      ok: true,
      kind: 'staged',
      ref,
      slug,
      mode: 'sandbox',
      sourceUrl: this.pageEdgeUrl(ref),
      liveUrl: this.localizedEdgeUrl(ref, locale, 'staged', slug),
      path: `/meridian/live/${locale}/${slug}`,
    }]]);
    this._tab = 'pages';
  }

  renderOverview() {
    if (this._matrix === null) {
      if (!this._matrixBusy) this.loadMatrix();
      return html`<div class="mrd-loading">Loading localization coverage…</div>`;
    }
    const locales = this._matrixLocales;
    if (!locales.length || !this._matrix.length) {
      return html`<div class="mrd-empty">
        No localized pages yet — open <strong>Pages</strong> to localize your first page.
      </div>`;
    }
    const cells = this._matrix.flatMap((r) => r.cells);
    const staged = cells.filter((c) => c.stage === 'staged').length;
    const live = cells.filter((c) => c.stage === 'live').length;
    return html`
      <div class="mrd-summary">
        <div class="mrd-scorecard mrd-positive">
          <div class="mrd-score">${this._matrix.length}</div><div class="mrd-score-label">Pages</div>
        </div>
        <div class="mrd-scorecard">
          <div class="mrd-score">${locales.length}</div><div class="mrd-score-label">Markets</div>
        </div>
        <div class="mrd-scorecard mrd-warning">
          <div class="mrd-score">${staged}</div><div class="mrd-score-label">Staged · awaiting promotion</div>
        </div>
        <div class="mrd-scorecard mrd-positive">
          <div class="mrd-score">${live}</div><div class="mrd-score-label">Live</div>
        </div>
        <sl-button class="primary outline mrd-matrix-refresh" ?disabled=${this._matrixBusy}
          @click=${() => this.loadMatrix()}>Refresh</sl-button>
      </div>
      <div class="mrd-matrix-wrap">
        <table class="mrd-matrix">
          <thead>
            <tr><th scope="col">Page</th>${locales.map((l) => html`<th scope="col">${l}</th>`)}</tr>
          </thead>
          <tbody>
            ${this._matrix.map((row) => html`
              <tr>
                <th scope="row" class="mrd-matrix-page">
                  <button class="mrd-matrix-link"
                    @click=${() => { this._tab = 'pages'; this.pickPage(row.ref); }}
                    title="Open in Pages">${row.ref}</button>
                </th>
                ${row.cells.map((c) => {
    const d = cellDisplay(c);
    // Empty cell → jump into Localize to create it. Staged cell → launch into
    // Pages (review side-by-side, then Promote) — never a blind grid-promote.
    if (c.stage !== 'live') {
      const act = c.stage === 'staged'
        ? () => this.reviewStaged(row.ref, c.locale)
        : () => this.localizeFromMatrix(row.ref, c.locale);
      const tip = c.stage === 'staged'
        ? `Review & promote ${c.locale} · ${d.tip}`
        : `Localize ${row.ref} → ${c.locale}`;
      return html`
                  <td>
                    <button class="mrd-matrix-cell" @click=${act} title=${tip}>
                      <span class="mrd-risk-chip mrd-risk-${d.cls}">${d.label}</span>
                    </button>
                  </td>`;
    }
    // Live cell → deep-link to the real live page (a quick peek).
    return html`
                  <td>
                    <a class="mrd-matrix-cell"
                      href=${this.localizedEdgeUrl(row.ref, c.locale, 'live')}
                      target="_blank" rel="noopener"
                      title=${`Open live ${c.locale} page · ${d.tip}`}>
                      <span class="mrd-risk-chip mrd-risk-${d.cls}">${d.label}</span>
                    </a>
                  </td>`;
  })}
              </tr>`)}
          </tbody>
        </table>
      </div>`;
  }

  renderContent() {
    if (this._state === 'init') return nothing;
    if (this._state === 'loading') return html`<div class="mrd-loading">Scanning ${this._org}/${this._site}…</div>`;
    if (this._tab === 'overview') return this.renderOverview();
    if (this._tab === 'taste') return this.renderTaste();
    if (this._tab === 'adapt') return this.renderAdaptations();
    if (this._tab === 'pages') return this.renderPages();
    return this.renderExposure();
  }

  render() {
    return html`
      ${this.renderToolbar()}${this.renderContent()}
      ${this.renderOverlay()}
      ${this._toast ? html`<div class="mrd-toast" role="status">${this._toast}</div>` : nothing}`;
  }
}

customElements.define('meridian-app', MeridianApp);

(async function init() {
  const deepLink = parseDeepLink();
  const cmp = document.createElement('meridian-app');
  cmp._org = deepLink.org || '';
  cmp._site = deepLink.site || '';
  // Render the UI first so the page is never blank. DA_SDK only resolves when
  // running inside da.live (it injects context + auth via postMessage); opened
  // standalone it never resolves, so race it with a timeout.
  document.body.append(cmp);

  // DEMO: the standalone GitHub Pages prototype pre-installs an in-memory DA
  // (via setDaFetch) and a fake context before this module loads, so skip the
  // DA_SDK handshake and boot straight into the seeded project. No-op in prod.
  const demo = typeof window !== 'undefined' ? window.__MERIDIAN_DEMO__ : null;
  if (demo && demo.context) {
    cmp.context = demo.context;
    cmp._org = demo.context.org;
    cmp._site = demo.context.site;
    cmp.loadSites();
    cmp.scan();
    return;
  }

  let sdk = null;
  try {
    sdk = await Promise.race([
      DA_SDK,
      new Promise((resolve) => { setTimeout(() => resolve(null), 4000); }),
    ]);
  } catch {
    sdk = null;
  }

  if (sdk && sdk.context) {
    cmp.context = sdk.context;
    cmp._org = cmp._org || sdk.context.org || '';
    cmp._site = cmp._site || sdk.context.site || sdk.context.repo || '';
    // Load the current org's site list so the picker offers every site.
    if (cmp._org) cmp.loadSites();
    if (cmp._org && cmp._site) cmp.scan();
  } else {
    // No DA session (opened standalone). Render, but be clear reads/writes need
    // DA auth — the app must run inside DA (Library or Prepare menu).
    cmp._error = 'Meridian needs a DA session. Open it from within DA — a citizens page → Library or Prepare menu — so it can authenticate. Opened standalone it can render but cannot read or write DA content.';
  }
}());

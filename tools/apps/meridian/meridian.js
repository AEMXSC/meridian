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
import DaStore, { listSites, assertPageRef } from './core/store.js';
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
import { localizePage, applyLocalization, hasPendingOverrides } from './core/localize-page.js';
import { createTmTranslator, record as tmRecord, lookup as tmLookup } from './core/tm.js';
import { icon } from '../msm/core/icons.js';
import { daFetch } from '../msm/core/fetch.js';
import 'https://da.live/nx/public/sl/components.js';

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
const TABS = ['exposure', 'taste', 'adapt', 'pages'];

// Common target languages offered as quick-pick chips (code + label).
const LANG_OPTIONS = [
  ['es', 'Spanish'], ['it', 'Italian'], ['fr', 'French'], ['de', 'German'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese'], ['zh', 'Chinese'],
  ['ko', 'Korean'], ['ar', 'Arabic'],
];

function parseDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const tab = (params.get('tab') || '').trim();
  return {
    org: (params.get('org') || '').trim(),
    site: (params.get('site') || '').trim(),
    tab: TABS.includes(tab) ? tab : 'exposure',
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
    _recent: { state: true },
    _translate: { state: true },
    _edge: { state: true },
    _pageRef: { state: true },
    _pageResults: { state: true },
    _pageBusy: { state: true },
    _pageError: { state: true },
    _localizeDrafts: { state: true },
    _localeSel: { state: true },
    _browseOpen: { state: true },
    _pageTree: { state: true },
    _pageExpanded: { state: true },
    _previewOpen: { state: true },
    _pageRisk: { state: true },
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
    this._tab = parseDeepLink().tab;
    this._queue = [];
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
    this._translate = null;
    this._edge = new Map();
    this._pageRef = 'international-banking';
    this._pageResults = new Map();
    this._pageBusy = false;
    this._pageError = '';
    this._localizeDrafts = new Map();
    this._localeSel = new Set(['es', 'it']);
    this._browseOpen = false;
    this._pageTree = new Map();
    this._pageExpanded = new Set();
    this._previewOpen = new Set();
    this._pageRisk = [];
    this._localizeSource = '';
    this._localizeRef = '';
    // The store a Localize draft was staged against — captured so a later
    // Publish can never target a since-repointed org/site.
    this._localizeStore = null;
    // Deep-link / editor context wins; otherwise fall back to the most recent
    // org/site so a returning author lands where they left off.
    this._org = this._org || (this._recent[0]?.org ?? '');
    this._site = this._site || (this._recent[0]?.site ?? '');
    // Scan is triggered by init() once the DA session is (or isn't) available —
    // not here — so the toolbar always renders even without a DA context.
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

  async onOrgChange(e) {
    this._org = e.target.value.trim();
    await this.loadSites();
  }

  async scan() {
    this._state = 'loading';
    this._error = '';
    this._diffs = new Map();
    try {
      this._store = new DaStore({ org: this._org, site: this._site });
      const config = await this._store.readConfig();
      if (!config) {
        this._error = `No /meridian/config.json found in ${this._org}/${this._site}.`;
        this._state = 'init';
        return;
      }
      if (!config.canonicalId || !Array.isArray(config.policies)) {
        this._error = `Malformed /meridian/config.json in ${this._org}/${this._site} (needs canonicalId + policies[]).`;
        this._state = 'init';
        return;
      }
      this._config = config;
      this._canonicalId = config.canonicalId;
      this._policies = config.policies;
      this._findings = await scanCanonical(this._store, config.canonicalId, config.policies);
      this._state = 'ready';
      this.saveRecent(this._org, this._site);
      this.loadQueue();
      this.loadAdaptations();
      this.loadTranslate();
      this.loadEdgeStatus();
    } catch (e) {
      console.error(e);
      this._error = e.message || 'Scan failed.';
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
            ${[...new Set(this._recent.map((r) => r.org))].map((o) => html`<option value=${o}></option>`)}
          </datalist>
          <span class="mrd-scope-sep" aria-hidden="true">/</span>
          <input class="mrd-scope-input" id="site-input" list="mrd-sites" placeholder="site"
            aria-label="Site"
            value=${this._site} ?disabled=${this._state === 'loading'} />
          <datalist id="mrd-sites">
            ${this.siteSuggestions.map((s) => html`<option value=${s}></option>`)}
          </datalist>
        </form>
        <sl-button class="mrd-scan primary outline" ?disabled=${this._state === 'loading'}
          @click=${this.handleSubmit}>Scan</sl-button>
      </div>
      ${this._state === 'ready' ? html`
        <div class="mrd-tabs">
          <button class="mrd-tab ${this._tab === 'exposure' ? 'active' : ''}"
            @click=${() => { this._tab = 'exposure'; }}>Exposure queue</button>
          <button class="mrd-tab ${this._tab === 'taste' ? 'active' : ''}"
            @click=${() => { this._tab = 'taste'; }}>Taste queue${this._queue.length ? html` <span class="mrd-badge">${this._queue.length}</span>` : nothing}</button>
          <button class="mrd-tab ${this._tab === 'adapt' ? 'active' : ''}"
            @click=${() => { this._tab = 'adapt'; }}>Adaptations</button>
          <button class="mrd-tab ${this._tab === 'pages' ? 'active' : ''}"
            @click=${() => { this._tab = 'pages'; }}>Pages</button>
        </div>` : nothing}
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
      <div class="mrd-market">
        <div class="mrd-market-head">
          <span class="mrd-kind mrd-${blocked ? 'critical' : 'warning'}">${item.gate}</span>
          <span class="mrd-locale">${item.locale}</span>
          <span class="mrd-detail">${item.reason}</span>
          <span class="mrd-queue-actions">
            <sl-button ?disabled=${busy || blocked}
              title=${blocked ? 'Compliance absent — cannot publish' : 'Publish to /live'}
              @click=${() => this.approve(item)}>Approve</sl-button>
            <sl-button class="negative outline" ?disabled=${busy} @click=${() => this.startReject(item)}>Reject</sl-button>
          </span>
        </div>
        ${rejecting ? html`
          <div class="mrd-reject-form">
            <sl-input class="mrd-reject-input" ?disabled=${busy}
              placeholder="Reason for rejecting ${item.locale}…"></sl-input>
            <sl-button class="negative" ?disabled=${busy} @click=${() => this.confirmReject(item)}>Confirm reject</sl-button>
            <sl-button class="primary outline" ?disabled=${busy} @click=${() => this.cancelReject()}>Cancel</sl-button>
          </div>` : nothing}
      </div>`;
  }

  renderTaste() {
    if (!this._queue.length) return html`<div class="mrd-empty">Taste queue is empty.</div>`;
    return html`<div class="mrd-list">${this._queue.map((i) => this.renderQueueItem(i))}</div>`;
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
    const translate = createTranslator(daFetch, { org: this._org, site: this._site });
    return {
      ref, locales, store, translate,
    };
  }

  // A store for the current org/site, reused across browse + run.
  pageStore() {
    if (!this._store) this._store = new DaStore({ org: this._org, site: this._site });
    return this._store;
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

  selectPage(node) {
    this._pageRef = node.path.replace(/^\/+/, '').replace(/\.html$/, '');
    this._browseOpen = false;
    this._pageRisk = []; // status chips referred to the previous page
  }

  toggleLocale(code) {
    const next = new Set(this._localeSel);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    this._localeSel = next;
    this._pageRisk = []; // language set changed; old status no longer matches
  }

  // The published edge URL of a source (English) page, for the side-by-side preview.
  pageEdgeUrl(ref) {
    // Reuse the shared, tested path guard rather than an ad-hoc clean.
    const clean = assertPageRef(ref);
    return `https://main--${this._site}--${this._org}.aem.live/${clean}`;
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
      this._pageRisk = await ctx.store.pageRisk(ctx.ref, ctx.locales);
    } catch (e) {
      this._pageError = e.message;
    } finally {
      this._pageBusy = false;
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
    this._pageError = '';
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

  async translatePages() {
    const ctx = this.pageInputs();
    if (ctx.error) { this._pageError = ctx.error; return; }
    if (this.guardPendingDrafts()) return;
    this._pageBusy = true;
    this._pageError = '';
    this._pageResults = new Map();
    this._localizeDrafts = new Map();
    try {
      const source = await ctx.store.readPageHtml(ctx.ref);
      const dnt = await ctx.store.readDnt().catch(() => []);
      const tasks = ctx.locales.map((locale) => async () => {
        try {
          const tm = await ctx.store.readTm(locale);
          const tmt = createTmTranslator({ tm, translate: ctx.translate });
          const out = await localizePage(source, tmt.translate, { to: locale, dnt });
          // Learn only the translations that PASSED the quality gate (out.dict),
          // never the flagged ones — TM stores approved translations.
          const learned = new Map([...tmt.learned].filter(([s]) => out.dict.has(s)));
          if (learned.size) await this.saveTm(ctx.store, tm, learned, 'mt', locale);
          await ctx.store.writeLocalizedPage(locale, ctx.ref, out.html);
          const pub = await ctx.store.publishLocalizedPage(locale, ctx.ref);
          return [locale, {
            ok: true,
            kind: 'translate',
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
    } catch (e) {
      this._pageError = e.message;
    } finally {
      this._pageBusy = false;
    }
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
      this._localizeSource = await ctx.store.readPageHtml(ctx.ref);
      this._localizeRef = ctx.ref;
      // Bind the draft to the exact store it was staged against.
      this._localizeStore = ctx.store;
      const dnt = await ctx.store.readDnt().catch(() => []);
      const tasks = ctx.locales.map((locale) => async () => {
        try {
          const tm = await ctx.store.readTm(locale);
          const tmt = createTmTranslator({ tm, translate: ctx.translate });
          const out = await localizePage(this._localizeSource, tmt.translate, { to: locale, dnt });
          const learned = new Map([...tmt.learned].filter(([s]) => out.dict.has(s)));
          if (learned.size) await this.saveTm(ctx.store, tm, learned, 'mt', locale);
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
    const store = this._localizeStore;
    if (!draft?.ok || !store) return;
    this._pageBusy = true;
    this._pageError = '';
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
          return val && val !== suggestions.get(src);
        }),
      );
      const localizedHtml = applyLocalization(this._localizeSource, draft.dict, authored);
      await store.writeLocalizedPage(locale, this._localizeRef, localizedHtml);
      const pub = await store.publishLocalizedPage(locale, this._localizeRef);
      // Commit the successful publish (result + drop the draft) BEFORE touching
      // TM, so a TM hiccup can never mislabel a live page as failed or lose the
      // draft.
      const heldDone = Object.keys(authored).length;
      this._pageResults = new Map(this._pageResults).set(locale, {
        ok: true,
        kind: 'localize',
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
      // Human sign-off becomes durable TM (origin human), reused next run — but
      // it is best-effort: the page is already live.
      if (heldDone) await this.saveTm(store, await store.readTm(locale), authored, 'human', locale);
    } catch (e) {
      this._pageError = `Publish failed for ${locale}: ${e.message}`;
    } finally {
      this._pageBusy = false;
    }
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
    const badge = r.kind === 'localize'
      ? `localized · language ${pct}% · market ${r.heldDone}/${r.heldTotal}${mem}`
      : `translated · language ${pct}%${mem}`;
    const previewing = this._previewOpen.has(locale);
    return html`
      <div class="mrd-market">
        <div class="mrd-market-head">
          <span class="mrd-locale">${locale}</span>
          <span class="mrd-kind mrd-positive">${badge}</span>
          <button class="mrd-preview-toggle" @click=${() => this.togglePreview(locale)}>
            ${previewing ? 'Hide preview' : 'Preview'}
          </button>
          <a class="mrd-page-link" href=${r.liveUrl} target="_blank" rel="noopener">View live page ↗</a>
        </div>
        ${r.kind === 'translate' && r.review?.length ? html`
          <div class="mrd-entry-meta">
            ${r.review.length} segment(s) held in source language (market copy + low-confidence
            translations) — use Localize to resolve them per market.
          </div>` : nothing}
        ${previewing ? html`
          <div class="mrd-preview">
            <div class="mrd-preview-pane">
              <div class="mrd-preview-label">Source (English)</div>
              <iframe class="mrd-preview-frame" title="Source page ${locale}"
                src=${r.sourceUrl} loading="lazy"
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
            <a class="mrd-page-link-inline" href=${r.sourceUrl} target="_blank" rel="noopener">source</a>
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
          <sl-button class="mrd-page-publish" ?disabled=${this._pageBusy}
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
    const sel = ref === this._pageRef;
    return html`
      <li role="none">
        <button class="mrd-tree-page ${sel ? 'sel' : ''}" role="treeitem" aria-selected=${sel}
          @click=${() => this.selectPage(node)}>${node.name.replace(/\.html$/, '')}</button>
      </li>`;
  }

  renderPages() {
    return html`
      <p class="mrd-adapt-intro">
        Localize a real page from this site. <strong>Translate</strong> does the language layer
        automatically (machine). <strong>Localize</strong> also lets you author the market-specific
        commercial &amp; compliance segments before publishing — the difference between a
        <em>translated</em> page and a <em>localized</em> one.
      </p>
      <div class="mrd-page-form">
        <label id="mrd-page-lbl">Page</label>
        <button class="mrd-page-pick" aria-labelledby="mrd-page-lbl" aria-haspopup="tree"
          aria-expanded=${this._browseOpen} ?disabled=${this._pageBusy}
          @click=${() => this.toggleBrowse()}>
          ${this._pageRef || 'Choose a page…'} <span class="mrd-tree-caret" aria-hidden="true">▾</span>
        </button>
        <label id="mrd-lang-lbl">Languages</label>
        <span class="mrd-lang-chips" role="group" aria-labelledby="mrd-lang-lbl">
          ${LANG_OPTIONS.map(([code, name]) => html`
            <button class="mrd-lang-chip ${this._localeSel.has(code) ? 'on' : ''}"
              aria-pressed=${this._localeSel.has(code)} aria-label=${name}
              ?disabled=${this._pageBusy}
              @click=${() => this.toggleLocale(code)}>${code}</button>`)}
        </span>
      </div>
      ${this._browseOpen ? html`
        <div class="mrd-tree" role="tree" aria-label="Site pages">${this.renderTreeLevel('')}</div>` : nothing}
      <div class="mrd-page-actions">
        <sl-button class="primary outline" ?disabled=${this._pageBusy}
          @click=${() => this.translatePages()}>Translate &amp; publish</sl-button>
        <sl-button ?disabled=${this._pageBusy} @click=${() => this.startLocalize()}>Localize</sl-button>
        <sl-button class="primary outline" ?disabled=${this._pageBusy}
          @click=${() => this.checkStatus()}>Check status</sl-button>
      </div>
      ${this._pageRisk.length ? html`
        <div class="mrd-risk">
          ${this._pageRisk.map((r) => html`
            <span class="mrd-risk-chip mrd-risk-${r.state}">
              <span class="mrd-risk-locale">${r.locale}</span> ${r.state}
            </span>`)}
        </div>` : nothing}
      ${this._pageError ? html`<div class="nx-alert warning">${this._pageError}</div>` : nothing}
      ${this._localizeDrafts.size ? html`
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
    `;
  }

  renderContent() {
    if (this._state === 'init') return nothing;
    if (this._state === 'loading') return html`<div class="mrd-loading">Scanning ${this._org}/${this._site}…</div>`;
    if (this._tab === 'taste') return this.renderTaste();
    if (this._tab === 'adapt') return this.renderAdaptations();
    if (this._tab === 'pages') return this.renderPages();
    return this.renderExposure();
  }

  render() {
    return html`${this.renderToolbar()}${this.renderContent()}`;
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
    // Always load the org's site list so the picker offers every site — not
    // just recents — even when we also deep-link straight into one and scan.
    if (cmp._org) cmp.loadSites();
    if (cmp._org && cmp._site) cmp.scan();
  } else {
    // No DA session (opened standalone). Render, but be clear reads/writes need
    // DA auth — the app must run inside DA (Library or Prepare menu).
    cmp._error = 'Meridian needs a DA session. Open it from within DA — a citizens page → Library or Prepare menu — so it can authenticate. Opened standalone it can render but cannot read or write DA content.';
  }
}());

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
import DaStore from './core/store.js';
import scanCanonical from './core/scan.js';
import variantStatus from './core/variant-status.js';
import { diffVariants, onlyChanges } from './core/diff.js';
import { materialize } from './core/materialize.js';
import { icon } from '../msm/core/icons.js';
import 'https://da.live/nx/public/sl/components.js';

const NX = 'https://da.live/nx';
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

let sl = null;
let styles = null;
try {
  const { default: getStyle } = await import(`${NX}/utils/styles.js`);
  [sl, styles] = await Promise.all([
    getStyle(`${NX}/public/sl/styles.css`),
    getStyle(import.meta.url),
  ]);
} catch (e) {
  console.warn('Failed to load styles:', e);
}

// Deep-link org/site so an author arriving from the editor plugin never
// re-enters context (the annoyance called out in the Experience Workspace demo).
function parseDeepLink() {
  const params = new URLSearchParams(window.location.search);
  return { org: (params.get('org') || '').trim(), site: (params.get('site') || '').trim() };
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
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sl, styles].filter(Boolean);
    this._state = 'init';
    this._org = this._org || '';
    this._site = this._site || '';
    this._findings = [];
    this._diffs = new Map();
    this._loadingDiffs = new Set();
    this._error = '';
    if (this._org && this._site) this.scan();
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
      this._canonicalId = config.canonicalId;
      this._findings = await scanCanonical(this._store, config.canonicalId, config.policies);
      this._state = 'ready';
    } catch (e) {
      console.error(e);
      this._error = e.message || 'Scan failed.';
      this._state = 'init';
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

  renderToolbar() {
    return html`
      <div class="mrd-toolbar">
        <h1>Meridian — Exposure</h1>
        <form class="mrd-form" @submit=${this.handleSubmit}>
          <sl-input id="org-input" placeholder="org" value=${this._org} ?disabled=${this._state === 'loading'}></sl-input>
          <sl-input id="site-input" placeholder="site" value=${this._site} ?disabled=${this._state === 'loading'}></sl-input>
          <sl-button ?disabled=${this._state === 'loading'} @click=${this.handleSubmit}>Scan</sl-button>
        </form>
      </div>
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
          ${canDiff ? html`<sl-button class="mrd-diff-btn"
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

  renderContent() {
    if (this._state === 'init') return nothing;
    if (this._state === 'loading') return html`<div class="mrd-loading">Scanning ${this._org}/${this._site}…</div>`;
    if (!this._findings.length) return html`<div class="mrd-empty">No exposures found.</div>`;
    const s = this._summary;
    return html`
      <div class="mrd-summary">
        <span class="mrd-critical">${s.critical ?? 0} critical</span>
        <span class="mrd-warning">${s.warning ?? 0} warning</span>
      </div>
      <div class="mrd-list">${this._byLocale.map((g) => this.renderMarket(g))}</div>
    `;
  }

  render() {
    return html`${this.renderToolbar()}${this.renderContent()}`;
  }
}

customElements.define('meridian-app', MeridianApp);

(async function init() {
  const deepLink = parseDeepLink();
  const { context } = await DA_SDK;
  const cmp = document.createElement('meridian-app');
  cmp.context = context;
  cmp._org = deepLink.org || context.org || '';
  cmp._site = deepLink.site || context.site || context.repo || '';
  document.body.append(cmp);
}());

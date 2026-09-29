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
import { LitElement, html, nothing } from 'da-lit';
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import DaStore from '../../apps/meridian/core/store.js';
import { setDaFetch } from '../../apps/msm/core/fetch.js';

// The editor plugin's reference/status panel: for the page an author is editing,
// show where it lives in every market (live / staged / not localized) — the AEM
// "references" sidebar reimagined for EDS. Deep-links each row into the Meridian
// app pre-scoped so the author never re-enters context.
const APP_URL = 'https://da.live/app/AEMXSC/meridian/tools/apps/meridian/meridian';
const NX = 'https://da.live/nx';

const STATUS_LABEL = { live: 'Live', staged: 'Staged', missing: 'Not localized' };

let nexter = null;
let tokens = null;
let styles = null;
try {
  const { default: getStyle } = await import(`${NX}/utils/styles.js`);
  [nexter, tokens, styles] = await Promise.all([
    getStyle(`${NX}/styles/nexter.css`),
    getStyle(new URL('../../apps/meridian/styles/spectrum2.css', import.meta.url).href),
    getStyle(import.meta.url),
  ]);
} catch (e) {
  console.warn('[Meridian plugin] styles failed', e);
}

class DaMeridian extends LitElement {
  static properties = {
    details: { attribute: false },
    _state: { state: true },
    _ref: { state: true },
    _rows: { state: true },
    _summary: { state: true },
    _error: { state: true },
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [nexter, tokens, styles].filter(Boolean);
    this._state = 'loading';
    this._rows = [];
    this._summary = {};
    this._error = '';
    this.scan();
  }

  // The source page ref: the current editor path, site-relative, no leading slash
  // or .html. (v1 assumes the author is on the source page.)
  get _pageRef() {
    return (this.details.path || '').replace(/^\/+/, '').replace(/\.html$/, '');
  }

  async scan() {
    const { org, site } = this.details;
    const ref = this._pageRef;
    this._ref = ref;
    if (!ref) {
      this._state = 'no-page';
      return;
    }
    try {
      const store = new DaStore({ org, site });
      const { rows, summary } = await store.pageReferenceStatus(ref);
      this._rows = rows;
      this._summary = summary;
      this._state = 'ready';
    } catch (e) {
      console.error(e);
      this._error = e.message;
      this._state = 'error';
    }
  }

  _appLink(params = {}) {
    const { org, site } = this.details;
    const qs = new URLSearchParams({ org, site, ...params });
    return `${APP_URL}?${qs.toString()}`;
  }

  // The published edge URL for a localized page — clean locale root when live,
  // the sandbox path when still staged. Uses the market's localized ref (a
  // translated slug when slug translation is on), falling back to the source ref.
  _edgeUrl(locale, status, slug) {
    const { org, site } = this.details;
    const ref = slug || this._ref;
    const rel = status === 'live' ? `/${locale}/${ref}` : `/meridian/live/${locale}/${ref}`;
    return `https://main--${site}--${org}.aem.live${rel}`;
  }

  renderRow(row) {
    const label = STATUS_LABEL[row.status] || row.status;
    const appLink = this._appLink({ page: this._ref, market: row.locale, tab: 'pages' });
    return html`
      <div class="mrd-row">
        <span class="mrd-dot mrd-dot-${row.status}" aria-hidden="true"></span>
        <span class="mrd-locale">${row.locale}</span>
        <span class="mrd-status mrd-status-${row.status}">
          ${label}${row.stale ? html` <span class="mrd-stale" title="Source changed since this was localized">· update due</span>` : nothing}
        </span>
        <span class="mrd-row-actions">
          ${row.status === 'missing'
    ? html`<a href=${appLink} target="_blank" rel="noopener">Translate ↗</a>`
    : html`
            <a href=${this._edgeUrl(row.locale, row.status, row.slug)} target="_blank" rel="noopener">View ↗</a>
            <a href=${appLink} target="_blank" rel="noopener">${row.status === 'staged' ? 'Review ↗' : 'Compare ↗'}</a>`}
        </span>
      </div>`;
  }

  render() {
    if (this._state === 'loading') return html`<p class="mrd-msg">Checking markets…</p>`;
    if (this._state === 'no-page') return html`<p class="mrd-msg">Open a page to see its markets.</p>`;
    if (this._state === 'error') return html`<p class="mrd-msg mrd-err">${this._error}</p>`;

    const s = this._summary;
    return html`
      <div class="mrd-head">
        <span class="mrd-page-ref" title=${this._ref}>${this._ref}</span>
        <span class="mrd-counts">
          <span class="mrd-count mrd-count-live">${s.live ?? 0} live</span>
          <span class="mrd-count mrd-count-staged">${s.staged ?? 0} staged</span>
          <span class="mrd-count mrd-count-missing">${s.missing ?? 0} missing</span>
        </span>
      </div>
      ${this._rows.length
    ? html`<div class="mrd-markets">${this._rows.map((r) => this.renderRow(r))}</div>`
    : html`<p class="mrd-msg">No markets configured for this site yet. Open Meridian to translate this page.</p>`}
      <div class="mrd-actions">
        <a class="mrd-open" href=${this._appLink({ page: this._ref, tab: 'pages' })} target="_blank" rel="noopener">
          Open in Meridian ↗
        </a>
      </div>
    `;
  }
}

customElements.define('da-meridian', DaMeridian);

(async function init() {
  try {
    const { context, actions } = await DA_SDK;
    setDaFetch(actions.daFetch);
    const cmp = document.createElement('da-meridian');
    cmp.details = {
      org: context.org,
      site: context.site || context.repo,
      path: context.path,
    };
    document.body.append(cmp);
  } catch (e) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'padding:12px;color:#d31510;font:12px monospace;';
    pre.textContent = `Failed to initialise Meridian plugin: ${e.message}`;
    document.body.append(pre);
  }
}());

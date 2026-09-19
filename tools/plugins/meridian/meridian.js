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
import { LitElement, html } from 'da-lit';
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import DaStore from '../../apps/meridian/core/store.js';
import scanCanonical from '../../apps/meridian/core/scan.js';
import variantStatus from '../../apps/meridian/core/variant-status.js';
import { setDaFetch } from '../../apps/msm/core/fetch.js';
import { icon } from '../../apps/msm/core/icons.js';

const APP_URL = 'https://da.live/app/AEMXSC/meridian/tools/apps/meridian/meridian';
const NX = 'https://da.live/nx';

let nexter = null;
let styles = null;
try {
  const { default: getStyle } = await import(`${NX}/utils/styles.js`);
  [nexter, styles] = await Promise.all([
    getStyle(`${NX}/styles/nexter.css`),
    getStyle(import.meta.url),
  ]);
} catch (e) {
  console.warn('[Meridian plugin] styles failed', e);
}

class DaMeridian extends LitElement {
  static properties = {
    details: { attribute: false },
    _state: { state: true },
    _findings: { state: true },
    _error: { state: true },
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [nexter, styles].filter(Boolean);
    this._state = 'loading';
    this._findings = [];
    this._error = '';
    this.scan();
  }

  async scan() {
    const { org, site } = this.details;
    try {
      const store = new DaStore({ org, site });
      const config = await store.readConfig();
      if (!config || !Array.isArray(config.policies)) {
        this._state = 'no-config';
        return;
      }
      this._findings = await scanCanonical(store, config.canonicalId, config.policies);
      this._state = 'ready';
    } catch (e) {
      console.error(e);
      this._error = e.message;
      this._state = 'error';
    }
  }

  get _byLocale() {
    const groups = new Map();
    this._findings.forEach((f) => {
      if (!groups.has(f.locale)) groups.set(f.locale, []);
      groups.get(f.locale).push(f);
    });
    return [...groups.entries()];
  }

  get _summary() {
    return this._findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
  }

  get _appLink() {
    const { org, site } = this.details;
    return `${APP_URL}?org=${encodeURIComponent(org)}&site=${encodeURIComponent(site)}`;
  }

  render() {
    if (this._state === 'loading') return html`<p class="mrd-msg">Scanning…</p>`;
    if (this._state === 'no-config') {
      return html`<p class="mrd-msg">No Meridian content configured for this site.</p>`;
    }
    if (this._state === 'error') return html`<p class="mrd-msg mrd-err">${this._error}</p>`;

    const s = this._summary;
    return html`
      <div class="mrd-head">
        <span class="mrd-count mrd-critical">${s.critical ?? 0} critical</span>
        <span class="mrd-count mrd-warning">${s.warning ?? 0} warning</span>
      </div>
      <div class="mrd-markets">
        ${this._byLocale.map(([locale, findings]) => {
    const st = variantStatus(findings);
    return html`<div class="mrd-row">
            <span class="mrd-status" style="color:${st.color}" title=${st.tip}>
              ${icon(st.name, '0 0 18 18')}
            </span>
            <span class="mrd-locale">${locale}</span>
            <span class="mrd-kinds">${findings.map((f) => f.kind).join(', ')}</span>
          </div>`;
  })}
      </div>
      <a class="mrd-open" href=${this._appLink} target="_blank" rel="noopener">Open in Meridian app ↗</a>
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

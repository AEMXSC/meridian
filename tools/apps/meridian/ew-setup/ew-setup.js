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
/* eslint-disable no-underscore-dangle, import/no-unresolved, no-console */
import { LitElement, html, nothing } from 'da-lit';
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import 'https://da.live/nx/public/sl/components.js';
import {
  parseOrgSite, findEditorPathRows, hasEditorPathForSite, buildUpdatedConfig,
  hasCorrectSidekickConfig, buildUpdatedSidekickConfig,
} from './utils.js';

// Experience Workspace enablement for a site, aligned with adobe-rnd/ew-extensions
// `ew-setup`: EW is the DA canvas editor, so a site is EW-enabled by writing an
// `editor.path` config row (pages open in da.live/canvas) + a sidekick
// editUrlPattern. Writes run under the signed-in user's IMS token (DA_SDK).

const DA_CONFIG = 'https://admin.da.live/config';
const AEM_CONFIG = 'https://admin.hlx.page/config';
const NX = 'https://da.live/nx';

let sl = null;
let tokens = null;
let styles = null;
try {
  const { default: getStyle } = await import(`${NX}/utils/styles.js`);
  [sl, tokens, styles] = await Promise.all([
    getStyle(`${NX}/public/sl/styles.css`),
    getStyle(new URL('../styles/spectrum2.css', import.meta.url).href),
    getStyle(import.meta.url),
  ]);
} catch (e) {
  console.warn('[ew-setup] styles failed', e);
}

class EwSetup extends LitElement {
  static properties = {
    _org: { state: true },
    _site: { state: true },
    _input: { state: true },
    _token: { state: true },
    _busy: { state: true },
    _ew: { state: true }, // idle | exists | written | error
    _sk: { state: true },
    _skNote: { state: true },
    _error: { state: true },
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sl, tokens, styles].filter(Boolean);
    this._org = '';
    this._site = '';
    this._input = '';
    this._token = null;
    this._busy = false;
    this._ew = 'idle';
    this._sk = 'idle';
    this._skNote = '';
    this._error = '';
    this.init();
  }

  async init() {
    try {
      const { token, context } = await DA_SDK;
      this._token = token;
      if (context?.org) {
        this._org = context.org;
        this._site = context.site || context.repo || '';
        this._input = this._site ? `/${this._org}/${this._site}` : `/${this._org}`;
      }
    } catch {
      this._error = 'Open this from within DA so it can authenticate (it writes config under your IMS session).';
    }
  }

  get _auth() {
    return { Authorization: `Bearer ${this._token}` };
  }

  get _orgEnc() { return encodeURIComponent(this._org); }

  get _siteEnc() { return encodeURIComponent(this._site); }

  // Write the editor.path row so this site's pages open in the DA canvas (EW).
  async enableEw() {
    const resp = await fetch(`${DA_CONFIG}/${this._orgEnc}`, { headers: this._auth });
    if (resp.status === 404) {
      await this.writeEw(null);
      return;
    }
    if (!resp.ok) throw new Error(resp.status === 401 || resp.status === 403 ? 'No permission to read the org config.' : `Config read failed (${resp.status}).`);
    const json = await resp.json();
    const { rows } = findEditorPathRows(json);
    if (hasEditorPathForSite(rows, this._org, this._site)) { this._ew = 'exists'; return; }
    await this.writeEw(json);
  }

  async writeEw(existing) {
    const body = new FormData();
    body.append('config', JSON.stringify(buildUpdatedConfig(existing, this._org, this._site)));
    const resp = await fetch(`${DA_CONFIG}/${this._orgEnc}`, { method: 'POST', headers: this._auth, body });
    if (!resp.ok) throw new Error(resp.status === 401 || resp.status === 403 ? 'No permission to write the org config.' : `Config write failed (${resp.status}).`);
    this._ew = 'written';
  }

  // Point the sidekick's editUrlPattern at the canvas so "Edit" opens EW.
  async configureSidekick() {
    const url = `${AEM_CONFIG}/${this._orgEnc}/sites/${this._siteEnc}/sidekick.json`;
    const resp = await fetch(url, { headers: this._auth });
    let existing = null;
    if (resp.ok) existing = await resp.json();
    else if (resp.status !== 404) throw new Error(resp.status === 401 || resp.status === 403 ? 'No permission to read the sidekick config.' : `Sidekick read failed (${resp.status}).`);
    if (hasCorrectSidekickConfig(existing)) { this._sk = 'exists'; return; }
    const body = new FormData();
    body.append('config', JSON.stringify(buildUpdatedSidekickConfig(existing)));
    const wr = await fetch(url, { method: 'POST', headers: this._auth, body });
    if (!wr.ok) throw new Error(wr.status === 401 || wr.status === 403 ? 'No permission to write the sidekick config.' : `Sidekick write failed (${wr.status}).`);
    this._sk = 'written';
  }

  async run() {
    const parsed = parseOrgSite(this._input);
    if (!parsed) { this._error = 'Enter a valid org and site, e.g. /aemxsc/citizens.'; return; }
    this._org = parsed.org;
    this._site = parsed.site;
    if (!this._token) { this._error = 'No DA session — open this tool from within DA.'; return; }
    this._busy = true;
    this._error = '';
    this._ew = 'idle';
    this._sk = 'idle';
    this._skNote = '';
    try {
      await this.enableEw();
    } catch (e) {
      this._error = e.message || 'Setup failed.';
      this._busy = false;
      return;
    }
    // Sidekick is best-effort: admin.hlx.page config can need site-level auth
    // this tool doesn't hold, so a failure must not block EW enablement.
    try {
      await this.configureSidekick();
    } catch (e) {
      this._sk = 'error';
      this._skNote = e.message || 'Could not configure the sidekick automatically.';
    }
    this._busy = false;
  }

  renderStatus(label, state) {
    const map = {
      idle: ['', ''],
      exists: ['mrd-positive', 'already set'],
      written: ['mrd-positive', 'enabled'],
      error: ['mrd-critical', 'failed'],
    };
    const [cls, text] = map[state] || ['', ''];
    if (!text) return nothing;
    return html`<div class="ews-row"><span class="mrd-kind ${cls}">${text}</span> ${label}</div>`;
  }

  render() {
    const done = this._ew === 'exists' || this._ew === 'written';
    return html`
      <div class="ews">
        <h1>Enable Experience Workspace</h1>
        <p class="ews-lede">
          Experience Workspace is the DA canvas editor. This points a site's pages at the
          canvas and sets the sidekick so authors edit in EW. Writes run under your DA session.
        </p>
        <div class="ews-field">
          <label for="ews-os">Org / site</label>
          <input id="ews-os" class="ews-input" placeholder="/aemxsc/citizens"
            .value=${this._input} ?disabled=${this._busy}
            @input=${(e) => { this._input = e.target.value; }}>
        </div>
        <div class="ews-cta">
          <sl-button ?disabled=${this._busy} @click=${() => this.run()}>
            ${this._busy ? 'Enabling…' : 'Enable Experience Workspace'}
          </sl-button>
        </div>
        ${this.renderStatus('Pages open in the canvas (editor.path)', this._ew)}
        ${this.renderStatus('Sidekick edits in the canvas (editUrlPattern)', this._sk)}
        ${this._sk === 'error' && this._skNote ? html`
          <p class="ews-note">Sidekick: ${this._skNote} You can set it manually — editUrlPattern =
          <code>https://da.live/canvas#/{{org}}/{{site}}{{pathname}}</code>.</p>` : nothing}
        ${done ? html`<p class="ews-done">This site is Experience Workspace ready.</p>` : nothing}
        ${this._error ? html`<p class="ews-error">${this._error}</p>` : nothing}
      </div>`;
  }
}

customElements.define('ew-setup', EwSetup);

(function init() {
  document.body.append(document.createElement('ew-setup'));
}());

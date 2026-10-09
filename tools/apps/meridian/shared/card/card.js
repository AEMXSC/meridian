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

// Ported from adobe-rnd/ew-extensions (blocks/skills/shared/card) so Meridian's
// list items match the Experience Workspace extensions. Spectrum 2 via --s2-*.
import { LitElement, html, nothing } from 'da-lit';
import { loadStyle } from '../_loader.js';

const styles = await loadStyle(import.meta.url);

class NxCard extends LitElement {
  static properties = {
    heading: { type: String },
    subheading: { type: String },
    pill: { type: String },
    selected: { type: Boolean, reflect: true },
    interactive: { type: Boolean, reflect: true },
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [styles];
  }

  render() {
    return html`
      <div class="card" part="card">
        ${this.pill !== undefined
    ? html`<div class="card-pill" part="pill">${this.pill}</div>`
    : nothing}
        <slot name="pill"></slot>
        <div class="card-body">
          ${this.heading
    ? html`<span class="card-heading" part="heading">${this.heading}</span>`
    : nothing}
          ${this.subheading
    ? html`<span class="card-subheading" part="subheading">${this.subheading}</span>`
    : nothing}
          <slot></slot>
        </div>
        <div class="card-actions">
          <slot name="actions"></slot>
        </div>
      </div>
    `;
  }
}

if (!customElements.get('nx-card')) customElements.define('nx-card', NxCard);

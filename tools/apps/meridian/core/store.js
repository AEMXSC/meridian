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

import { daFetch, DA_ORIGIN } from '../../msm/core/fetch.js';

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

export default class DaStore {
  #org;

  #site;

  #base;

  constructor({ org, site, base = '/meridian' }) {
    assertSiteRef(org, site);
    this.#org = org;
    this.#site = site;
    this.#base = base.replace(/\/$/, '');
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
    const resp = await daFetch(this.#sourceUrl(path), { cache: 'no-store' });
    if (resp.ok) return resp.json();
    if (resp.status === 404) return null;
    throw new Error(`Read failed for ${path} (${resp.status})`);
  }

  async #writeJson(path, value) {
    const body = new FormData();
    body.append('data', new Blob([serialize(value)], { type: 'application/json' }));
    const resp = await daFetch(this.#sourceUrl(path), { method: 'PUT', body });
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

  writeVariant(variant) {
    return this.#writeJson(this.#livePath(variant.locale, variant.canonicalId), variant);
  }

  async deleteVariant(locale, canonicalId) {
    const resp = await daFetch(this.#sourceUrl(this.#livePath(locale, canonicalId)), { method: 'DELETE' });
    if (!resp.ok && resp.status !== 404) throw new Error(`Delete failed (${resp.status})`);
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
      const resp = await daFetch(`${DA_ORIGIN}/list/${this.#org}/${this.#site}${path}`, { cache: 'no-store' });
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

  // Persist a rejection record so the human's stated reason is auditable even
  // after the pending queue entry is removed (PRD §6 reject-with-reason).
  writeRejection(record) {
    return this.#writeJson(
      rejectionPath(this.#base, record.locale, record.canonicalId),
      record,
    );
  }

  async removeQueueItem(locale, canonicalId) {
    const resp = await daFetch(
      this.#sourceUrl(queuePath(this.#base, locale, canonicalId)),
      { method: 'DELETE' },
    );
    if (!resp.ok && resp.status !== 404) throw new Error(`Delete failed (${resp.status})`);
  }
}

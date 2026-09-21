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

// Node-side DA store for the MCP server. Reuses the browser core's validated,
// traversal-safe path builders (canonPath/adaptPath/livePath/queuePath) so the
// agent surface and the DA app address content identically, then talks to
// admin.da.live directly with an IMS token from DA_TOKEN (same forward-the-token
// model the worker uses — no separate credential).

/* eslint-disable import/no-relative-packages */
// Reuses the sibling app package's validated path builders by design.
import {
  canonPath, adaptPath, livePath, queuePath, assertSiteRef,
} from '../../tools/apps/meridian/core/store.js';

const DA_ORIGIN = 'https://admin.da.live';
const AEM_ADMIN = 'https://admin.hlx.page';

function authHeader() {
  const t = process.env.DA_TOKEN;
  if (!t) throw new Error('DA_TOKEN environment variable is required (an IMS access token for admin.da.live)');
  return t.startsWith('Bearer ') ? t : `Bearer ${t}`;
}

// admin.hlx.page for a DA-backed site needs BOTH Authorization and
// x-content-source-authorization (the IMS token) — either alone → 401.
function aemHeaders() {
  const t = process.env.DA_TOKEN || '';
  const bare = t.replace(/^Bearer /, '');
  return { Authorization: authHeader(), 'x-content-source-authorization': bare };
}

async function aemPost(org, site, kind, path) {
  const res = await fetch(`${AEM_ADMIN}/${kind}/${org}/${site}/main${path}`, { method: 'POST', headers: aemHeaders() });
  if (!res.ok) throw new Error(`${kind} ${path} failed (${res.status})`);
}

async function aemDelete(org, site, kind, path) {
  const res = await fetch(`${AEM_ADMIN}/${kind}/${org}/${site}/main${path}`, { method: 'DELETE', headers: aemHeaders() });
  if (!res.ok && res.status !== 404) throw new Error(`un-${kind} ${path} failed (${res.status})`);
}

function sourceUrl(org, site, path) {
  return `${DA_ORIGIN}/source/${org}/${site}${path}`;
}

async function get(org, site, path) {
  const res = await fetch(sourceUrl(org, site, path), { headers: { Authorization: authHeader() } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DA read ${path} failed (${res.status})`);
  return res.json();
}

async function put(org, site, path, value) {
  const body = new FormData();
  body.append('data', new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const res = await fetch(sourceUrl(org, site, path), {
    method: 'PUT',
    headers: { Authorization: authHeader() },
    body,
  });
  if (!res.ok) throw new Error(`DA write ${path} failed (${res.status})`);
}

async function del(org, site, path) {
  const res = await fetch(sourceUrl(org, site, path), {
    method: 'DELETE',
    headers: { Authorization: authHeader() },
  });
  if (!res.ok && res.status !== 404) throw new Error(`DA delete ${path} failed (${res.status})`);
}

/**
 * A store implementing the interface the engine expects (readCanonical/readLayer/
 * readVariant/writeVariant/writeQueueItem/deleteVariant/readConfig), backed by DA.
 * @param {string} org
 * @param {string} site
 * @param {string} [base]
 */
export default function nodeStore(org, site, base = '/meridian') {
  assertSiteRef(org, site);
  return {
    readConfig: () => get(org, site, `${base}/config.json`),
    readCanonical: async (id) => {
      const c = await get(org, site, canonPath(base, id));
      if (!c) throw new Error(`Canonical not found: ${id}`);
      return c;
    },
    readLayer: (locale, id) => get(org, site, adaptPath(base, locale, id)),
    readVariant: (locale, id) => get(org, site, livePath(base, locale, id)),
    writeConfig: (config) => put(org, site, `${base}/config.json`, config),
    writeCanonical: (canonical) => put(org, site, canonPath(base, canonical.id), canonical),
    writeLayer: (layer) => put(org, site, adaptPath(base, layer.locale, layer.canonicalId), layer),
    writeVariant: (variant) => {
      const p = livePath(base, variant.locale, variant.canonicalId);
      return put(org, site, p, variant);
    },
    writeQueueItem: (item) => {
      const p = queuePath(base, item.locale, item.canonicalId);
      return put(org, site, p, item);
    },
    deleteVariant: (locale, id) => del(org, site, livePath(base, locale, id)),
    publishVariant: async (locale, id) => {
      const path = `${livePath(base, locale, id).replace(/\.json$/, '')}.json`;
      await aemPost(org, site, 'preview', path);
      await aemPost(org, site, 'live', path);
    },
    unpublishVariant: async (locale, id) => {
      const path = `${livePath(base, locale, id).replace(/\.json$/, '')}.json`;
      await aemDelete(org, site, 'live', path);
      await aemDelete(org, site, 'preview', path);
    },
  };
}

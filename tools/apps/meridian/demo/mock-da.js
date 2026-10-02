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

// DEMO ONLY. Routes the app's single authenticated-fetch seam (setDaFetch) to an
// in-memory DA source tree, so the whole app runs on GitHub Pages with no DA
// session, no IMS, and no network. It emulates exactly the four URL families the
// app hits: DA source (GET/HEAD/PUT/DELETE), DA list, AEM Admin status/preview/
// live, and the worker /translate proxy. Everything else falls through to the
// real network (public da.live modules + styles).

import { setDaFetch } from '../../msm/core/fetch.js';
import buildFs from './fixtures.js';
import fakeTranslate from './translate-dict.js';

const DA_HOST = 'admin.da.live';
const AEM_HOST = 'admin.hlx.page';

function res(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}
const notFound = () => new Response(null, { status: 404 });

// Immediate children of a source folder, shaped like a DA /list response:
// { name, path, ext } with the /org/site prefix the app strips off.
function listChildren(fs, org, site, sub) {
  const base = sub === '/' ? '' : sub;
  const folders = new Set();
  const files = [];
  fs.forEach((_v, key) => {
    if (!key.startsWith(`${base}/`)) return;
    const rest = key.slice(base.length + 1);
    const segs = rest.split('/');
    if (segs.length === 1) {
      const name = segs[0];
      const ext = name.includes('.') ? name.split('.').pop() : '';
      files.push({ name, path: `/${org}/${site}${base}/${name}`, ext });
    } else {
      folders.add(segs[0]);
    }
  });
  const folderItems = [...folders].map((name) => ({ name, path: `/${org}/${site}${base}/${name}` }));
  return [...folderItems, ...files];
}

async function handleSource(fs, sourcePath, method, opts) {
  if (method === 'HEAD') {
    const entry = fs.get(sourcePath);
    if (!entry) return notFound();
    return res(null, 200, { 'Last-Modified': new Date(entry.lastModified).toUTCString() });
  }
  if (method === 'GET') {
    const entry = fs.get(sourcePath);
    if (!entry) return notFound();
    return res(entry.body, 200, { 'Last-Modified': new Date(entry.lastModified).toUTCString() });
  }
  if (method === 'PUT') {
    const data = opts.body && typeof opts.body.get === 'function' ? opts.body.get('data') : null;
    const body = data ? await data.text() : '';
    fs.set(sourcePath, { body, lastModified: Date.now() });
    return res('{}', 200);
  }
  if (method === 'DELETE') {
    fs.delete(sourcePath);
    return res(null, 200);
  }
  return res(null, 405);
}

// The real app's daFetch replacement. Resolves to a standard Response.
async function mockFetch(fs, org, site, url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  let u;
  try { u = new URL(url); } catch { return fetch(url, opts); }

  // Worker /translate proxy -> offline dictionary.
  if (u.pathname.endsWith('/translate')) {
    let payload = {};
    try { payload = JSON.parse(opts.body || '{}'); } catch { /* keep {} */ }
    const translations = fakeTranslate(payload.strings, payload.to);
    return res(JSON.stringify({ translations }), 200, { 'content-type': 'application/json' });
  }

  if (u.hostname === DA_HOST) {
    // /source/{org}/{site}{path}
    const srcPre = `/source/${org}/${site}`;
    if (u.pathname.startsWith(srcPre)) {
      const sourcePath = u.pathname.slice(srcPre.length) || '/';
      return handleSource(fs, sourcePath, method, opts);
    }
    // A source read for any other org/site: nothing seeded there.
    if (u.pathname.startsWith('/source/')) return notFound();

    // /list, /list/{org}/, /list/{org}/{site}{sub}
    if (u.pathname === '/list' || u.pathname.startsWith('/list/')) {
      const parts = u.pathname.slice('/list'.length).split('/').filter(Boolean);
      if (parts.length === 0) return res(JSON.stringify([{ name: org }]), 200);
      if (parts.length === 1) {
        return res(JSON.stringify(parts[0] === org ? [{ name: site }] : []), 200);
      }
      if (parts[0] !== org || parts[1] !== site) return res('[]', 200);
      const sub = parts.length > 2 ? `/${parts.slice(2).join('/')}` : '';
      return res(JSON.stringify(listChildren(fs, org, site, sub)), 200);
    }
    return notFound();
  }

  if (u.hostname === AEM_HOST) {
    const kind = u.pathname.split('/')[1]; // status | preview | live
    if (kind === 'status') {
      // /status/{org}/{site}/main{sourcePath}. Report edge state off whether the
      // DA source actually exists, so a never-materialized market (e.g. the
      // planted uncovered locale) shows "not published", not a false green chip.
      const marker = '/main';
      const idx = u.pathname.indexOf(marker);
      const rest = idx === -1 ? '' : (u.pathname.slice(idx + marker.length) || '/');
      const entry = fs.get(rest) || (/\.[a-z0-9]+$/i.test(rest) ? null : fs.get(`${rest}.html`));
      if (!entry) {
        return res(JSON.stringify({ preview: { status: 404 }, live: { status: 404 } }), 200, { 'content-type': 'application/json' });
      }
      const ts = new Date(entry.lastModified).toUTCString();
      return res(JSON.stringify({
        preview: { status: 200, lastModified: ts },
        live: { status: 200, lastModified: ts },
      }), 200, { 'content-type': 'application/json' });
    }
    // preview/live POST (publish) and DELETE (unpublish) — always succeed here.
    return res('{}', 200);
  }

  // Anything else (public da.live modules/styles) hits the real network.
  return fetch(url, opts);
}

// Build the fixture tree, wire the fetch seam, and hand back the DA context the
// app's init expects (org/site/user) — no DA_SDK, no IMS.
export default async function installDemo() {
  const { fs, org, site } = await buildFs();
  setDaFetch((url, opts) => mockFetch(fs, org, site, url, opts));
  return {
    context: {
      org, site, path: '/personal-banking', user: { email: 'you@meridian.demo' },
    },
  };
}

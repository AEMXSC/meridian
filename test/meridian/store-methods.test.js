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

// Instance-method coverage for DaStore's safety-critical paths using an injected
// fake DA transport (fetchImpl) — the source-locale guard, the locale-root
// collision guard, the ownership marker, and the managed manifest. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import DaStore from '../../tools/apps/meridian/core/store.js';
import { MANAGED_MARK } from '../../tools/apps/meridian/core/managed.js';

const REF = 'aemxsc';
const SITE = 'citizens';

// A fake DA transport. `handler(url, opts)` returns a Response-like object; every
// call is recorded on `fetchImpl.calls` for assertions.
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

function resp({
  ok = true, status = 200, body = '', json,
} = {}) {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => (json !== undefined ? json : JSON.parse(body || 'null')),
  };
}

function store(fetchImpl, opts = {}) {
  return new DaStore({
    org: REF, site: SITE, sourceLocale: 'en', fetchImpl, ...opts,
  });
}

test('writeLocalizedPage/publishLocalizedPage refuse the source locale before any network', async () => {
  const s = store(async () => { throw new Error('must not touch the network'); });
  await assert.rejects(() => s.writeLocalizedPage('en', 'x', '<p>hi</p>', 'locale-root'), /source locale/);
  await assert.rejects(() => s.publishLocalizedPage('en', 'x', 'locale-root'), /source locale/);
});

test('locale-root write refuses to overwrite a non-Meridian page', async () => {
  const fetchImpl = makeFetch((url, opts) => {
    if ((opts.method || 'GET') === 'GET') return resp({ body: '<p>hand authored</p>' });
    return resp({});
  });
  const s = store(fetchImpl);
  await assert.rejects(
    () => s.writeLocalizedPage('fr', 'international-banking', '<p>bonjour</p>', 'locale-root'),
    /already exists and isn't managed by Meridian/,
  );
  // The guard must fail BEFORE writing anything.
  assert.equal(fetchImpl.calls.some((c) => c.method === 'PUT'), false);
});

test('locale-root write overwrites a Meridian-managed page and stamps the marker', async () => {
  let putBody;
  const fetchImpl = makeFetch((url, opts) => {
    if ((opts.method || 'GET') === 'GET') return resp({ body: `${MANAGED_MARK}\n<p>old</p>` });
    putBody = opts.body;
    return resp({});
  });
  const s = store(fetchImpl);
  const path = await s.writeLocalizedPage('fr', 'international-banking', '<p>new</p>', 'locale-root');
  assert.equal(path, '/fr/international-banking.html');
  const written = await putBody.get('data').text();
  assert.ok(written.includes(MANAGED_MARK), 'output carries the ownership marker');
  assert.ok(written.includes('<p>new</p>'));
});

test('locale-root write creates an absent page (404 → writable)', async () => {
  const fetchImpl = makeFetch((url, opts) => {
    if ((opts.method || 'GET') === 'GET') return resp({ ok: false, status: 404 });
    return resp({});
  });
  const s = store(fetchImpl);
  const path = await s.writeLocalizedPage('de', 'x', '<p>neu</p>', 'locale-root');
  assert.equal(path, '/de/x.html');
});

test('sandbox write is namespaced and skips the collision read', async () => {
  const fetchImpl = makeFetch((url, opts) => resp({ ok: !!opts }));
  const s = store(fetchImpl);
  const path = await s.writeLocalizedPage('fr', 'x', '<p>bonjour</p>');
  assert.equal(path, '/meridian/live/fr/x.html');
  assert.deepEqual(fetchImpl.calls.map((c) => c.method), ['PUT'], 'no pre-write GET in sandbox');
});

test('promotePage refuses the source locale before any network', async () => {
  const s = store(async () => { throw new Error('must not touch the network'); });
  await assert.rejects(() => s.promotePage('en', 'x'), /source locale/);
});

test('promotePage throws when there is no sandbox page to promote', async () => {
  // GET the sandbox artifact → 404 → nothing to promote.
  const s = store(makeFetch((url, opts) => ((opts.method || 'GET') === 'GET'
    ? resp({ ok: false, status: 404 })
    : resp({}))));
  await assert.rejects(() => s.promotePage('fr', 'international-banking'), /No sandbox page to promote/);
});

test('listPromotions treats a 404 as no pending requests', async () => {
  const s = store(makeFetch(() => resp({ ok: false, status: 404 })));
  assert.deepEqual(await s.listPromotions(), []);
});

test('readManaged parses entries and treats a 404 as an empty manifest', async () => {
  const withDoc = store(makeFetch(() => resp({ json: { entries: [{ ref: 'a', locale: 'fr', mode: 'locale-root' }] } })));
  assert.deepEqual(await withDoc.readManaged(), [{ ref: 'a', locale: 'fr', mode: 'locale-root' }]);
  const empty = store(makeFetch(() => resp({ ok: false, status: 404 })));
  assert.deepEqual(await empty.readManaged(), []);
});

// ---- Setup surface: declare / edit a site's markets ----

const V2_URL = `https://admin.da.live/source/${REF}/${SITE}/.da/translate-v2.json`;

async function putJson(call) {
  return JSON.parse(await call.body.get('data').text());
}

const lang = (name, location) => ({ name, location });
const v2Doc = (rows, extra = {}) => ({
  ':type': 'multi-sheet',
  ':names': ['languages', ...Object.keys(extra)],
  languages: {
    total: rows.length, limit: rows.length, offset: 0, data: rows,
  },
  ...extra,
});
const reader = (doc) => makeFetch((url, opts) => {
  if ((opts.method || 'GET') !== 'GET') return resp({});
  return doc ? resp({ json: doc }) : resp({ ok: false, status: 404 });
});

test('updateMarkets applies the author delta to a FRESH read, keeping edits made elsewhere', async () => {
  // "ja" was added by someone else after Setup opened; Meridian's save must not drop it.
  const fresh = v2Doc([lang('Spanish', '/es'), lang('Japanese', '/ja')], {
    locales: {
      total: 1, limit: 1, offset: 0, data: [{ name: 'Canada', location: '/ca' }],
    },
  });
  const fetchImpl = reader(fresh);
  await store(fetchImpl).updateMarkets({
    add: [{ code: 'fr', name: 'French' }], remove: ['es'], sourceLocale: 'en',
  });
  const put = fetchImpl.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, V2_URL);
  const doc = await putJson(put);
  assert.deepEqual(doc.languages.data.map((r) => r.location), ['/ja', '/fr']);
  assert.deepEqual(doc.locales, fresh.locales);
});

test('updateMarkets stands up a catalog on a blank site (404 -> new doc)', async () => {
  const fetchImpl = reader(null);
  await store(fetchImpl).updateMarkets({ add: [{ code: 'fr', name: 'French' }], remove: [] });
  const doc = await putJson(fetchImpl.calls.find((c) => c.method === 'PUT'));
  assert.equal(doc[':type'], 'multi-sheet');
  assert.deepEqual(doc.languages.data, [{ name: 'French', location: '/fr' }]);
});

test('updateMarkets writes nothing when there is no change', async () => {
  const fetchImpl = reader(v2Doc([lang('Spanish', '/es')]));
  await store(fetchImpl).updateMarkets({ add: [], remove: [] });
  await store(fetchImpl).updateMarkets({ add: [{ code: 'es', name: 'Spanish' }], remove: ['zz'] });
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('updateMarkets guards the DRAFT source language, case-insensitively, before any write', async () => {
  const fetchImpl = reader(null);
  await assert.rejects(
    () => store(fetchImpl).updateMarkets({ add: [{ code: 'FR', name: 'x' }], remove: [], sourceLocale: 'fr' }),
    /source locale/,
  );
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'PUT').length, 0);
  // A legitimate swap: the OLD source (en) can become a market once the source is fr.
  const ok = reader(null);
  await store(ok, { sourceLocale: 'en' }).updateMarkets({
    add: [{ code: 'en', name: 'English' }], remove: [], sourceLocale: 'fr',
  });
  assert.equal(ok.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('updateMarkets refuses to write when the config read fails (never builds from a failed read)', async () => {
  const fetchImpl = makeFetch(() => resp({ ok: false, status: 500 }));
  await assert.rejects(() => store(fetchImpl).updateMarkets({ add: [], remove: ['es'] }), /500/);
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'PUT').length, 0);
});

const CFG_URL = `https://admin.da.live/config/${REF}`;

test('enableExperienceWorkspace adds editor.path via the config KV, keeping existing rows', async () => {
  const existing = { data: [{ key: 'other', value: 'x' }] };
  const fetchImpl = makeFetch((url, opts) => (
    (opts.method || 'GET') === 'GET' ? resp({ json: existing }) : resp({})));
  assert.equal(await store(fetchImpl).enableExperienceWorkspace(), 'written');
  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, CFG_URL);
  const doc = JSON.parse(post.body.get('config'));
  assert.deepEqual(doc.data.map((r) => r.key), ['other', 'editor.path']);
  assert.equal(doc.data[1].value, `/${REF}/${SITE}=https://da.live/canvas#`);
});

test('enableExperienceWorkspace is idempotent and surfaces permission errors', async () => {
  const already = { data: [{ key: 'editor.path', value: `/${REF}/${SITE}=https://da.live/canvas#` }] };
  const f1 = makeFetch(() => resp({ json: already }));
  assert.equal(await store(f1).enableExperienceWorkspace(), 'exists');
  assert.equal(f1.calls.filter((c) => c.method === 'POST').length, 0);

  const f2 = makeFetch(() => resp({ ok: false, status: 403 }));
  await assert.rejects(() => store(f2).enableExperienceWorkspace(), /permission/i);
});

test('enableExperienceWorkspace reports a non-JSON org config instead of throwing a raw parse error', async () => {
  const fetchImpl = makeFetch(() => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
  }));
  await assert.rejects(() => store(fetchImpl).enableExperienceWorkspace(), /not valid JSON/i);
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'POST').length, 0);
});

// ---- config.json: merge onto a FRESH read, never the scan-time copy ----

const CONFIG_URL = `https://admin.da.live/source/${REF}/${SITE}/meridian/config.json`;

test('updateConfig merges the patch onto a fresh read, keeping edits made elsewhere', async () => {
  const fresh = { canonicalId: 'c1', policies: [{ locale: 'es', requiredLayers: [] }], note: 'edited elsewhere' };
  const fetchImpl = makeFetch((url, opts) => (
    (opts.method || 'GET') === 'GET' ? resp({ json: fresh }) : resp({})));
  await store(fetchImpl).updateConfig({ sourceLocale: 'fr', publishMode: 'locale-root' });
  const put = fetchImpl.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, CONFIG_URL);
  assert.deepEqual(await putJson(put), { ...fresh, sourceLocale: 'fr', publishMode: 'locale-root' });
});

test('updateConfig creates the file from the patch alone on a blank site', async () => {
  const fetchImpl = makeFetch((url, opts) => (
    (opts.method || 'GET') === 'GET' ? resp({ ok: false, status: 404 }) : resp({})));
  await store(fetchImpl).updateConfig({ sourceLocale: 'en' });
  assert.deepEqual(await putJson(fetchImpl.calls.find((c) => c.method === 'PUT')), { sourceLocale: 'en' });
});

test('updateConfig refuses to write when the config read fails', async () => {
  const fetchImpl = makeFetch(() => resp({ ok: false, status: 500 }));
  await assert.rejects(() => store(fetchImpl).updateConfig({ sourceLocale: 'en' }), /500/);
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('a store reports the org and site it was built for', () => {
  const s = store(makeFetch(() => resp({})));
  assert.equal(s.org, REF);
  assert.equal(s.site, SITE);
});

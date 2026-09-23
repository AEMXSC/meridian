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

test('readManaged parses entries and treats a 404 as an empty manifest', async () => {
  const withDoc = store(makeFetch(() => resp({ json: { entries: [{ ref: 'a', locale: 'fr', mode: 'locale-root' }] } })));
  assert.deepEqual(await withDoc.readManaged(), [{ ref: 'a', locale: 'fr', mode: 'locale-root' }]);
  const empty = store(makeFetch(() => resp({ ok: false, status: 404 })));
  assert.deepEqual(await empty.readManaged(), []);
});

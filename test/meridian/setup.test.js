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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDraftMarket, removeDraftMarket, validateSetup, diffMarkets, isPartialModelConfig,
} from '../../tools/apps/meridian/core/setup.js';

test('addDraftMarket appends a market without mutating the draft', () => {
  const draft = [{ code: 'es', name: 'Spanish' }];
  const { markets, error } = addDraftMarket(draft, 'fr', 'French');
  assert.equal(error, '');
  assert.deepEqual(markets, [{ code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' }]);
  assert.equal(draft.length, 1);
});

test('addDraftMarket names a market by its code when no name is given', () => {
  assert.deepEqual(addDraftMarket([], ' de ').markets, [{ code: 'de', name: 'de' }]);
});

test('addDraftMarket rejects empty, unsafe and duplicate codes and returns the draft unchanged', () => {
  const draft = [{ code: 'es', name: 'Spanish' }];
  ['', '  ', '../x', 'a/b', 'a b'].forEach((bad) => {
    const r = addDraftMarket(draft, bad, 'x');
    assert.match(r.error, /valid locale code/);
    assert.equal(r.markets, draft);
  });
  const dup = addDraftMarket(draft, 'es', 'Spanish');
  assert.match(dup.error, /already/);
  assert.equal(dup.markets, draft);
});

test('removeDraftMarket drops one market and leaves the rest', () => {
  const draft = [{ code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' }];
  assert.deepEqual(removeDraftMarket(draft, 'es'), [{ code: 'fr', name: 'French' }]);
  assert.equal(draft.length, 2);
});

test('validateSetup requires a safe source, no source-as-market, and a known publish mode', () => {
  const ok = { sourceLocale: 'en', markets: [{ code: 'es', name: 'Spanish' }], publishMode: 'sandbox' };
  assert.equal(validateSetup(ok), '');
  assert.match(validateSetup({ ...ok, sourceLocale: '' }), /source language/);
  assert.match(validateSetup({ ...ok, sourceLocale: '../x' }), /source language/);
  assert.match(validateSetup({ ...ok, markets: [{ code: 'en', name: 'English' }] }), /is the source language/);
  assert.match(validateSetup({ ...ok, publishMode: 'nope' }), /publish mode/);
  assert.equal(validateSetup({ ...ok, publishMode: 'locale-root' }), '');
});

test('validateSetup compares the source language case-insensitively', () => {
  const draft = { sourceLocale: 'EN', markets: [{ code: 'en', name: 'English' }], publishMode: 'sandbox' };
  assert.match(validateSetup(draft), /is the source language/);
});

test('diffMarkets reports only what the author changed against what was loaded', () => {
  const loaded = ['es', 'fr', 'de'];
  const draft = [{ code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' }, { code: 'ja', name: 'Japanese' }];
  assert.deepEqual(diffMarkets(loaded, draft), {
    add: [{ code: 'ja', name: 'Japanese' }],
    remove: ['de'],
  });
  assert.deepEqual(diffMarkets(['es'], [{ code: 'es', name: 'Spanish' }]), { add: [], remove: [] });
  assert.deepEqual(diffMarkets([], []), { add: [], remove: [] });
});

test('isPartialModelConfig flags a half-authored exposure model, not a Setup-only config', () => {
  // Setup writes only sourceLocale/publishMode — that is a complete, minimal config.
  assert.equal(isPartialModelConfig({ sourceLocale: 'en', publishMode: 'sandbox' }), false);
  assert.equal(isPartialModelConfig({}), false);
  assert.equal(isPartialModelConfig(null), false);
  // A valid model is not partial.
  assert.equal(isPartialModelConfig({ canonicalId: 'c', policies: [] }), false);
  // Only one half present (or policies not an array) IS partial.
  assert.equal(isPartialModelConfig({ canonicalId: 'c' }), true);
  assert.equal(isPartialModelConfig({ policies: [] }), true);
  assert.equal(isPartialModelConfig({ canonicalId: 'c', policies: 'x' }), true);
});

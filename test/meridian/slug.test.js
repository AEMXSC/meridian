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
  slugify, humanizeSlug, localizeRef, chooseSlug,
} from '../../tools/apps/meridian/core/slug.js';

test('slugify folds accents and non-alnum to a safe path segment', () => {
  assert.equal(slugify('Mercados de Capitales'), 'mercados-de-capitales');
  assert.equal(slugify('Financiación'), 'financiacion');
  assert.equal(slugify('Crédit & Prêts'), 'credit-prets');
  assert.equal(slugify('  spaced  out  '), 'spaced-out');
  assert.equal(slugify('already-ok'), 'already-ok');
});

test('slugify only ever emits [a-z0-9-]', () => {
  const out = slugify('Ĉ Ä ñ 123 !!! ——');
  assert.match(out, /^[a-z0-9-]*$/);
});

test('slugify tolerates non-strings', () => {
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify(42), '');
});

test('humanizeSlug turns a ref segment into words', () => {
  assert.equal(humanizeSlug('capital-markets'), 'capital markets');
  assert.equal(humanizeSlug('home_equity'), 'home equity');
  assert.equal(humanizeSlug('financing'), 'financing');
  assert.equal(humanizeSlug(null), '');
});

test('localizeRef replaces only the last segment, keeping the parent path', () => {
  assert.equal(localizeRef('corporate/capital-markets', 'Mercados de Capitales'), 'corporate/mercados-de-capitales');
  assert.equal(localizeRef('financing', 'Financiación'), 'financiacion');
});

test('localizeRef falls back to the original segment on an empty translation', () => {
  assert.equal(localizeRef('corporate/financing', ''), 'corporate/financing');
  assert.equal(localizeRef('financing', '!!!'), 'financing');
  assert.equal(localizeRef('financing', null), 'financing');
});

test('localizeRef strips leading/trailing slashes and tolerates empties', () => {
  assert.equal(localizeRef('/financing/', 'Financiación'), 'financiacion');
  assert.equal(localizeRef('', 'x'), '');
});

test('chooseSlug returns the base slug when nothing else has taken it', () => {
  assert.equal(chooseSlug('financing', 'Financiación', new Set()), 'financiacion');
  assert.equal(chooseSlug('financing', 'Financiación', new Set(['ahorros'])), 'financiacion');
});

test('chooseSlug disambiguates a same-locale collision deterministically', () => {
  const taken = new Set(['financiacion']);
  assert.equal(chooseSlug('funding', 'Financiación', taken), 'financiacion-2');
  const taken2 = new Set(['financiacion', 'financiacion-2']);
  assert.equal(chooseSlug('funding', 'Financiación', taken2), 'financiacion-3');
});

test('chooseSlug preserves the parent path when disambiguating', () => {
  const taken = new Set(['corporate/financiacion']);
  assert.equal(chooseSlug('corporate/funding', 'Financiación', taken), 'corporate/financiacion-2');
});

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
import { localeCode, parseLocaleConfig } from '../../tools/apps/meridian/core/locale-config.js';

test('localeCode turns a DA location path into a safe Meridian locale token', () => {
  assert.equal(localeCode('/de'), 'de');
  assert.equal(localeCode('de'), 'de');
  assert.equal(localeCode('/es/mx'), 'es-mx');
  assert.equal(localeCode('/'), '');
  assert.equal(localeCode(''), '');
  assert.equal(localeCode(null), '');
});

test('parseLocaleConfig on an absent or empty doc yields an empty catalog', () => {
  const empty = { languages: [], groups: [], all: [] };
  assert.deepEqual(parseLocaleConfig(null), empty);
  assert.deepEqual(parseLocaleConfig({ ':type': 'multi-sheet', ':names': [] }), empty);
});

const DOC = {
  ':type': 'multi-sheet',
  ':names': ['languages', 'locales'],
  languages: {
    data: [
      { name: 'English', location: '' }, // root/source language — not a target
      { name: 'German', location: '/de' },
      { name: 'French', location: '/fr' },
    ],
  },
  locales: {
    data: [
      { name: 'Canada', location: '/ca' },
      { name: 'Switzerland', location: '/ch' },
    ],
  },
};

test('parseLocaleConfig lists base languages, dropping the root source language', () => {
  const { languages } = parseLocaleConfig(DOC);
  assert.deepEqual(languages, [
    { code: 'de', name: 'German' },
    { code: 'fr', name: 'French' },
  ]);
});

test('parseLocaleConfig composes region groups the way DA derives variants', () => {
  const { groups } = parseLocaleConfig(DOC);
  assert.equal(groups.length, 2);
  const canada = groups[0];
  assert.equal(canada.name, 'Canada');
  assert.equal(canada.region, 'ca');
  // One variant per language, including the root language's regional flavor (ca).
  assert.deepEqual(canada.locales, [
    { code: 'ca', name: 'English' },
    { code: 'de-ca', name: 'German' },
    { code: 'fr-ca', name: 'French' },
  ]);
});

test('parseLocaleConfig.all is the deduped union of every target token', () => {
  const { all } = parseLocaleConfig(DOC);
  assert.deepEqual(all, ['de', 'fr', 'ca', 'de-ca', 'fr-ca', 'ch', 'de-ch', 'fr-ch']);
});

test('parseLocaleConfig tolerates null/scalar rows without throwing', () => {
  const doc = {
    ':type': 'multi-sheet',
    ':names': ['languages', 'locales'],
    languages: { data: [null, 'oops', { name: 'German', location: '/de' }] },
    locales: { data: [null, { name: 'Canada', location: '/ca' }] },
  };
  let out;
  assert.doesNotThrow(() => { out = parseLocaleConfig(doc); });
  assert.deepEqual(out.languages, [{ code: 'de', name: 'German' }]);
  assert.deepEqual(out.groups[0].locales, [{ code: 'de-ca', name: 'German' }]);
});

test('parseLocaleConfig drops groups that resolve to no safe locales', () => {
  const doc = {
    ':type': 'multi-sheet',
    ':names': ['languages', 'locales'],
    languages: { data: [{ name: 'Root', location: '' }] },
    locales: { data: [{ name: 'Nowhere', location: '' }] },
  };
  assert.deepEqual(parseLocaleConfig(doc), { languages: [], groups: [], all: [] });
});

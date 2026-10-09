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
import { localeCode, parseLocaleConfig, splitLocalePrefix } from '../../tools/apps/meridian/core/locale-config.js';

test('localeCode turns a DA location path into a safe Meridian locale token', () => {
  assert.equal(localeCode('/de'), 'de');
  assert.equal(localeCode('de'), 'de');
  assert.equal(localeCode('/es/mx'), 'es-mx');
  assert.equal(localeCode('/'), '');
  assert.equal(localeCode(''), '');
  assert.equal(localeCode(null), '');
});

test('parseLocaleConfig on an absent or empty doc yields an empty catalog', () => {
  const empty = {
    languages: [], groups: [], all: [], siteByCode: {},
  };
  assert.deepEqual(parseLocaleConfig(null), empty);
  assert.deepEqual(parseLocaleConfig({ ':type': 'multi-sheet', ':names': [] }), empty);
});

test('splitLocalePrefix strips a leading locale folder using the known-locale list', () => {
  const known = ['es', 'fr', 'de', 'pt'];
  assert.deepEqual(splitLocalePrefix('pt/international-banking', known), { locale: 'pt', tail: 'international-banking' });
  assert.deepEqual(splitLocalePrefix('es/personal-banking/checking', known), { locale: 'es', tail: 'personal-banking/checking' });
});

test('splitLocalePrefix leaves a source (unprefixed) ref untouched', () => {
  const known = ['es', 'fr', 'pt'];
  // Single segment never carries a locale.
  assert.deepEqual(splitLocalePrefix('international-banking', known), { locale: null, tail: 'international-banking' });
  // A multi-segment source path whose head is not a known/shaped locale.
  assert.deepEqual(splitLocalePrefix('personal-banking/checking', known), { locale: null, tail: 'personal-banking/checking' });
});

test('splitLocalePrefix falls back to the EDS locale-folder shape when no markets are declared', () => {
  // Regression: the live site had an empty translate-v2.json, so the catalog was
  // empty and a /pt/ page was mislabeled as the English source. With no known
  // locales, a convention-shaped head segment is still recognized.
  assert.deepEqual(splitLocalePrefix('pt/international-banking', []), { locale: 'pt', tail: 'international-banking' });
  assert.deepEqual(splitLocalePrefix('es-mx/mortgages', []), { locale: 'es-mx', tail: 'mortgages' });
  // But a real English page section ("personal-banking") is not a locale shape.
  assert.deepEqual(splitLocalePrefix('personal-banking/checking', []), { locale: null, tail: 'personal-banking/checking' });
});

test('splitLocalePrefix: empty-catalog fallback is a heuristic (accepted limitation)', () => {
  // Documented trade-off: with no declared markets, a 2-letter top-level English
  // section is indistinguishable from a locale folder, so it's treated as one.
  // Acceptable because an empty-catalog site gives no authoritative signal, and
  // the prior behavior (every localized page mislabeled as source) was worse.
  assert.deepEqual(splitLocalePrefix('eu/pricing', []), { locale: 'eu', tail: 'pricing' });
  // A PARTIAL catalog gets NO fallback: an undeclared locale stays a source path,
  // so declared-market sites don't suffer false positives.
  assert.deepEqual(splitLocalePrefix('pt/international-banking', ['es', 'fr']), { locale: null, tail: 'pt/international-banking' });
});

test('splitLocalePrefix handles empty and nullish refs', () => {
  assert.deepEqual(splitLocalePrefix('', []), { locale: null, tail: '' });
  assert.deepEqual(splitLocalePrefix(null, []), { locale: null, tail: '' });
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
  assert.deepEqual(parseLocaleConfig(doc), {
    languages: [], groups: [], all: [], siteByCode: {},
  });
});

test('parseLocaleConfig captures per-market target sites (DA `site` column)', () => {
  const doc = {
    ':type': 'multi-sheet',
    ':names': ['languages', 'locales'],
    languages: {
      data: [
        { name: 'German', location: '/de', site: 'citizens-de' },
        { name: 'French', location: '/fr' }, // no site → base site
      ],
    },
    locales: {
      // A region group can target its own repo, overriding the language's site.
      data: [{ name: 'Canada', location: '/ca', site: '/citizens-ca' }],
    },
  };
  const { languages, siteByCode } = parseLocaleConfig(doc);
  assert.deepEqual(languages[0], { code: 'de', name: 'German', site: 'citizens-de' });
  assert.deepEqual(languages[1], { code: 'fr', name: 'French' }, 'no site key when unset');
  assert.equal(siteByCode.de, 'citizens-de');
  assert.equal(siteByCode['de-ca'], 'citizens-ca', 'group site overrides + strips leading slash');
  assert.equal(siteByCode['fr-ca'], 'citizens-ca');
  assert.equal('fr' in siteByCode, false, 'base-site locales are absent from the map');
});

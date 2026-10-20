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
  localeCode, parseLocaleConfig, splitLocalePrefix, buildLocaleConfigDoc,
} from '../../tools/apps/meridian/core/locale-config.js';

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

test('buildLocaleConfigDoc stands up a catalog from a blank site and round-trips through parseLocaleConfig', () => {
  const doc = buildLocaleConfigDoc(null, [
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
  ]);
  assert.equal(doc[':type'], 'multi-sheet');
  assert.deepEqual(parseLocaleConfig(doc).all, ['es', 'fr']);
  assert.deepEqual(parseLocaleConfig(doc).languages.map((l) => l.name), ['Spanish', 'French']);
});

test('buildLocaleConfigDoc preserves the source row, region groups, sibling sheets and per-market site routing', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['languages', 'locales', 'other'],
    languages: {
      total: 3,
      limit: 3,
      offset: 0,
      data: [
        { name: 'English', location: '' },
        { name: 'German', location: '/de', site: 'citizens-de' },
        { name: 'Italian', location: '/it' },
      ],
    },
    locales: {
      total: 1, limit: 1, offset: 0, data: [{ name: 'Canada', location: '/ca' }],
    },
    other: {
      total: 1, limit: 1, offset: 0, data: [{ k: 'v' }],
    },
  };
  const next = buildLocaleConfigDoc(existing, [
    { code: 'de', name: 'German' },
    { code: 'es', name: 'Spanish' },
  ]);
  // Italian removed, Spanish added, German keeps its routing.
  const langs = next.languages.data;
  assert.deepEqual(langs.map((r) => r.location), ['', '/de', '/es']);
  assert.equal(langs[1].site, 'citizens-de');
  // Untouched sheets survive verbatim.
  assert.deepEqual(next.locales, existing.locales);
  assert.deepEqual(next.other, existing.other);
  assert.deepEqual(parseLocaleConfig(next).languages.map((l) => l.code), ['de', 'es']);
});

test('buildLocaleConfigDoc renames a kept market, dedupes codes, and never mutates its input', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['languages'],
    languages: {
      total: 1, limit: 1, offset: 0, data: [{ name: 'Old', location: '/es' }],
    },
  };
  const frozen = JSON.parse(JSON.stringify(existing));
  const next = buildLocaleConfigDoc(existing, [
    { code: 'es', name: 'Spanish' },
    { code: 'es', name: 'Dup' },
  ]);
  assert.deepEqual(next.languages.data.map((r) => r.name), ['Spanish']);
  assert.deepEqual(existing, frozen);
});

test('buildLocaleConfigDoc rejects empty or unsafe market codes before producing a doc', () => {
  assert.throws(() => buildLocaleConfigDoc(null, [{ code: '', name: 'x' }]), /locale code/i);
  assert.throws(() => buildLocaleConfigDoc(null, [{ code: '../x', name: 'x' }]), /locale code/i);
  assert.throws(() => buildLocaleConfigDoc(null, [{ code: 'a/b', name: 'x' }]), /locale code/i);
});

test('buildLocaleConfigDoc leaves rows it cannot interpret untouched (no silent deletion)', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['languages'],
    languages: {
      total: 2,
      limit: 2,
      offset: 0,
      data: [{ name: 'Hand note', location: '/not a locale' }, { name: 'Spanish', location: '/es' }],
    },
  };
  const next = buildLocaleConfigDoc(existing, [{ code: 'fr', name: 'French' }]);
  assert.deepEqual(next.languages.data.map((r) => r.location), ['/not a locale', '/fr']);
});

test('buildLocaleConfigDoc keeps a kept market\'s location verbatim (no nested-path rewrite)', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['languages'],
    languages: {
      total: 2,
      limit: 2,
      offset: 0,
      data: [
        { name: 'Spanish (Mexico)', location: '/es/mx' },
        { name: 'German', location: '/de/' },
      ],
    },
  };
  const next = buildLocaleConfigDoc(existing, [
    { code: 'es-mx', name: 'Spanish (Mexico)' },
    { code: 'de', name: 'German' },
    { code: 'fr', name: 'French' },
  ]);
  // Existing rows keep exactly what DA has; only the NEW row gets a derived location.
  assert.deepEqual(next.languages.data.map((r) => r.location), ['/es/mx', '/de/', '/fr']);
});

test('buildLocaleConfigDoc preserves sibling sheets even when the doc lacks a :type marker', () => {
  const existing = {
    languages: {
      total: 1, limit: 1, offset: 0, data: [{ name: 'Italian', location: '/it' }],
    },
    locales: {
      total: 1, limit: 1, offset: 0, data: [{ name: 'Canada', location: '/ca' }],
    },
  };
  const next = buildLocaleConfigDoc(existing, [{ code: 'es', name: 'Spanish' }]);
  assert.deepEqual(next.locales, existing.locales);
  assert.deepEqual(next.languages.data.map((r) => r.location), ['/es']);
});

test('buildLocaleConfigDoc does not invent a name for a kept row that has none', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['languages'],
    languages: {
      total: 1,
      limit: 1,
      offset: 0,
      data: [{ name: '', location: '/es' }],
    },
  };
  // The Setup UI shows a nameless market by its code, so the draft carries name === code.
  const next = buildLocaleConfigDoc(existing, [
    { code: 'es', name: 'es' },
    { code: 'fr', name: 'fr' },
  ]);
  assert.deepEqual(next.languages.data[0], { name: '', location: '/es' });
  assert.deepEqual(next.languages.data[1], { name: 'fr', location: '/fr' });
});

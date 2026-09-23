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
import { buildPageReference } from '../../tools/apps/meridian/core/page-reference.js';

test('a configured market with no Meridian copy is missing', () => {
  const { rows, summary } = buildPageReference({
    ref: 'capital-markets',
    locales: ['es', 'it', 'fr'],
    sourceLocale: 'en',
    managed: [],
  });
  assert.deepEqual(rows.map((r) => r.locale), ['es', 'fr', 'it']);
  assert.ok(rows.every((r) => r.status === 'missing'));
  assert.equal(summary.missing, 3);
});

test('manifest mode maps to staged (sandbox) vs live (locale-root)', () => {
  const { rows, summary } = buildPageReference({
    ref: 'capital-markets',
    locales: ['es', 'it', 'fr'],
    managed: [
      { ref: 'capital-markets', locale: 'es', mode: 'locale-root', at: 1 },
      { ref: 'capital-markets', locale: 'it', mode: 'sandbox', at: 2 },
    ],
  });
  const byLocale = Object.fromEntries(rows.map((r) => [r.locale, r]));
  assert.equal(byLocale.es.status, 'live');
  assert.equal(byLocale.it.status, 'staged');
  assert.equal(byLocale.fr.status, 'missing');
  assert.equal(summary.live, 1);
  assert.equal(summary.staged, 1);
  assert.equal(summary.missing, 1);
});

test('only entries for this ref count; other pages are ignored', () => {
  const { rows } = buildPageReference({
    ref: 'capital-markets',
    locales: ['es'],
    managed: [
      { ref: 'financing', locale: 'es', mode: 'live', at: 1 },
      { ref: 'capital-markets', locale: 'es', mode: 'sandbox', at: 2 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'staged');
});

test('the source language is never listed as a market', () => {
  const { rows } = buildPageReference({
    ref: 'x',
    locales: ['en', 'es'],
    sourceLocale: 'en',
    managed: [{ ref: 'x', locale: 'en', mode: 'locale-root', at: 1 }],
  });
  assert.deepEqual(rows.map((r) => r.locale), ['es']);
});

test('a managed market outside the catalog still appears', () => {
  const { rows } = buildPageReference({
    ref: 'x',
    locales: ['es'],
    managed: [{ ref: 'x', locale: 'de', mode: 'sandbox', at: 1 }],
  });
  assert.deepEqual(rows.map((r) => r.locale).sort(), ['de', 'es']);
});

test('stale decorates a live/staged row when its source changed since', () => {
  const { rows, summary } = buildPageReference({
    ref: 'x',
    locales: ['es', 'it', 'fr'],
    managed: [
      { ref: 'x', locale: 'es', mode: 'locale-root', at: 1 },
      { ref: 'x', locale: 'it', mode: 'sandbox', at: 2 },
    ],
    risk: { es: 'stale', it: 'current', fr: 'missing' },
  });
  const byLocale = Object.fromEntries(rows.map((r) => [r.locale, r]));
  assert.equal(byLocale.es.stale, true);
  assert.equal(byLocale.it.stale, false);
  // A missing market is never "stale" even if risk says so.
  assert.equal(byLocale.fr.stale, false);
  assert.equal(summary.stale, 1);
});

test('tolerates missing/garbage input', () => {
  const { rows, summary } = buildPageReference();
  assert.deepEqual(rows, []);
  assert.deepEqual(summary, {});
});

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
  canonPath, adaptPath, livePath, queuePath, rejectionPath, assertSiteRef,
  localePagePath, assertPageRef, tmPath, dntTerms, pageRiskState,
} from '../../tools/apps/meridian/core/store.js';

const ID = 'canon/offers/spring-refresh';

test('path builders scope under the base for valid inputs', () => {
  assert.equal(canonPath('/meridian', ID), '/meridian/canon/offers/spring-refresh.json');
  assert.equal(adaptPath('/meridian', 'es_mx', ID), '/meridian/adapt/es_mx/offers/spring-refresh.json');
  assert.equal(livePath('/meridian', 'es_mx', ID), '/meridian/live/es_mx/offers/spring-refresh.json');
  assert.equal(queuePath('/meridian', 'es_mx', ID), '/meridian/taste-queue/es_mx/offers/spring-refresh.json');
  assert.equal(rejectionPath('/meridian', 'es_mx', ID), '/meridian/rejections/es_mx/offers/spring-refresh.json');
});

test('path builders reject traversal and malformed segments', () => {
  assert.throws(() => canonPath('/meridian', 'canon/../../index'), /Unsafe canonicalId/);
  assert.throws(() => canonPath('/meridian', '/canon/x'), /Unsafe canonicalId/);
  assert.throws(() => canonPath('/meridian', 'offers/x'), /Unsafe canonicalId/, 'must start with canon/');
  assert.throws(() => adaptPath('/meridian', '../etc', ID), /Unsafe locale/);
  assert.throws(() => adaptPath('/meridian', 'es/mx', ID), /Unsafe locale/);
  assert.throws(() => livePath('/meridian', 'es_mx', 'canon/../secret'), /Unsafe canonicalId/);
  assert.throws(() => rejectionPath('/meridian', '../etc', ID), /Unsafe locale/);
  assert.throws(() => rejectionPath('/meridian', 'es_mx', 'canon/../secret'), /Unsafe canonicalId/);
});

test('localePagePath scopes a localized page under the locale folder', () => {
  assert.equal(
    localePagePath('/meridian', 'es', 'international-banking'),
    '/meridian/live/es/international-banking.html',
  );
  // Tolerates a leading slash and an explicit .html, and nested page paths.
  assert.equal(localePagePath('/meridian', 'it', '/international-banking.html'), '/meridian/live/it/international-banking.html');
  assert.equal(localePagePath('/meridian', 'es', 'student/checking'), '/meridian/live/es/student/checking.html');
});

test('tmPath scopes translation memory per locale under the base', () => {
  assert.equal(tmPath('/meridian', 'es'), '/meridian/tm/es.json');
  assert.throws(() => tmPath('/meridian', '../etc'), /Unsafe locale/);
});

test('pageRiskState flags missing / stale / current localized pages vs the source', () => {
  assert.equal(pageRiskState(1000, null), 'missing', 'never localized');
  assert.equal(pageRiskState(2000, 1000), 'stale', 'source changed after localization');
  assert.equal(pageRiskState(1000, 2000), 'current', 'localized after the source');
  assert.equal(pageRiskState(null, 1000), 'current', 'no source timestamp → not stale');
});

test('pageRiskState compares real Last-Modified date strings chronologically, not lexically', () => {
  // Source is chronologically NEWER (Jan 2026) but its weekday prefix ("Fri")
  // sorts BEFORE the localized page's ("Mon") — a naive string compare would
  // wrongly say "current". Chronologically it must be "stale".
  const sourceNewer = 'Fri, 02 Jan 2026 00:00:00 GMT';
  const localizedOlder = 'Mon, 01 Dec 2025 00:00:00 GMT';
  assert.equal(pageRiskState(sourceNewer, localizedOlder), 'stale');
  assert.equal(pageRiskState(localizedOlder, sourceNewer), 'current');
  assert.equal(pageRiskState(sourceNewer, null), 'missing');
});

test('dntTerms extracts do-not-translate terms from translate.json, tolerant of the column name', () => {
  assert.deepEqual(dntTerms(null), [], 'no config → no terms');
  const doc = {
    ':type': 'multi-sheet',
    ':names': ['languages', 'dnt-content-rules'],
    languages: { data: [{ locale: 'es' }] },
    'dnt-content-rules': {
      data: [
        { term: 'Citizens' },
        { content: 'Quest®' },
        { term: 'Quest®' },
        { note: 'ignored-empty', term: '' },
      ],
    },
  };
  assert.deepEqual(dntTerms(doc), ['Citizens', 'Quest®'], 'deduped, blank-skipped, column-tolerant');
});

test('assertPageRef rejects traversal and malformed refs', () => {
  assert.equal(assertPageRef('/international-banking.html'), 'international-banking');
  assert.throws(() => assertPageRef('../../etc/passwd'), /Unsafe page ref/);
  assert.throws(() => assertPageRef(''), /Unsafe page ref/);
  assert.throws(() => assertPageRef('a/../b'), /Unsafe page ref/);
  assert.throws(() => localePagePath('/meridian', 'es/mx', 'international-banking'), /Unsafe locale/);
});

test('assertSiteRef rejects org/site that could escape the site path', () => {
  assert.doesNotThrow(() => assertSiteRef('aemxsc', 'citizens'));
  assert.throws(() => assertSiteRef('../other', 'citizens'), /Unsafe org/);
  assert.throws(() => assertSiteRef('aemxsc', '../secret'), /Unsafe site/);
  assert.throws(() => assertSiteRef('aemxsc', 'a/b'), /Unsafe site/);
  assert.throws(() => assertSiteRef('', 'citizens'), /Unsafe org/);
});

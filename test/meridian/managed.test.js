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
  MANAGED_MARK, isManaged, markManaged, overwriteBlocked, publishRelPath, buildHreflangIndex,
} from '../../tools/apps/meridian/core/managed.js';

test('markManaged stamps the ownership marker once (idempotent)', () => {
  const html = '<body><main>Hola</main></body>';
  const once = markManaged(html);
  assert.ok(once.startsWith(MANAGED_MARK));
  assert.ok(isManaged(once));
  assert.equal(markManaged(once), once, 'does not double-stamp');
  assert.equal(isManaged(html), false, 'unmarked page is not managed');
});

test('overwriteBlocked protects hand-authored pages only in locale-root mode', () => {
  const theirs = '<body>hand authored</body>';
  const ours = markManaged('<body>ours</body>');
  // locale-root: block an existing page we do not own; allow ours or absent.
  assert.equal(overwriteBlocked(theirs, 'locale-root'), true);
  assert.equal(overwriteBlocked(ours, 'locale-root'), false);
  assert.equal(overwriteBlocked(null, 'locale-root'), false);
  // sandbox is namespaced → never blocked.
  assert.equal(overwriteBlocked(theirs, 'sandbox'), false);
});

test('publishRelPath routes market targets by mode (never the bare source path)', () => {
  // A market: clean locale root vs namespaced sandbox.
  assert.equal(publishRelPath('locale-root', 'fr', 'international-banking'), '/fr/international-banking');
  assert.equal(publishRelPath('sandbox', 'fr', 'international-banking'), '/meridian/live/fr/international-banking');
  assert.equal(publishRelPath('locale-root', 'fr-ca', 'a/b'), '/fr-ca/a/b');
  // Even a locale that looks like a source language is namespaced, never /{ref}
  // — the store refuses to write the source locale as a market anyway.
  assert.equal(publishRelPath('locale-root', 'en', 'x'), '/en/x');
  assert.equal(publishRelPath('sandbox', 'en', 'x'), '/meridian/live/en/x');
});

test('buildHreflangIndex clusters locale-root variants with source + x-default', () => {
  const entries = [
    { ref: 'international-banking', locale: 'fr', mode: 'locale-root' },
    { ref: 'international-banking', locale: 'it', mode: 'locale-root' },
    { ref: 'about-us', locale: 'es', mode: 'sandbox' }, // sandbox → excluded
  ];
  assert.deepEqual(buildHreflangIndex(entries), {
    'international-banking': {
      en: '/international-banking',
      'x-default': '/international-banking',
      fr: '/fr/international-banking',
      it: '/it/international-banking',
    },
  });
});

test('buildHreflangIndex tolerates empty/malformed input', () => {
  assert.deepEqual(buildHreflangIndex(null), {});
  assert.deepEqual(buildHreflangIndex([null, {}, { ref: 'x' }]), {});
});

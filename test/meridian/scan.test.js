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
import scanCanonical from '../../tools/apps/meridian/core/scan.js';
import buildFixture from '../../tools/apps/meridian/seed/informatica.js';

const NOW = '2026-09-08T00:00:00Z';

// In-memory store standing in for DaStore, so the orchestrator's read wiring
// is verified without a live DA project.
function fakeStore({ canonical, layers, stored }) {
  return {
    readCanonical: async (id) => {
      if (id !== canonical.id) throw new Error(`unexpected id ${id}`);
      return canonical;
    },
    readLayer: async (locale) => layers.get(locale) ?? null,
    readVariant: async (locale) => stored.get(locale) ?? null,
  };
}

test('scanCanonical assembles inputs from the store and reproduces the planted findings', async () => {
  const fixture = await buildFixture();
  const store = fakeStore(fixture);
  const findings = await scanCanonical(store, fixture.canonical.id, fixture.policies, { now: NOW });
  assert.equal(findings.length, 9);
  assert.equal(findings.filter((f) => f.kind === 'stale').length, 1);
  assert.equal(findings.filter((f) => f.kind === 'drift').length, 4);
});

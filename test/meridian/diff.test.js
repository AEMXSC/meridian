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
import { diffVariants, onlyChanges } from '../../tools/apps/meridian/core/diff.js';
import variantStatus from '../../tools/apps/meridian/core/variant-status.js';
import { materialize } from '../../tools/apps/meridian/core/materialize.js';
import buildFixture from '../../tools/apps/meridian/seed/informatica.js';

test('diffVariants reports only the drifted block as changed', async () => {
  const { canonical, layers, stored } = await buildFixture();
  const expected = materialize(canonical, layers.get('es_es'));
  const changes = diffVariants(expected, stored.get('es_es'));
  const changed = onlyChanges(changes);
  assert.equal(changed.length, 1, 'exactly one block differs');
  assert.equal(changed[0].blockId, 'hero');
  assert.equal(changed[0].status, 'changed');
});

test('diffVariants finds no changes for a clean market', async () => {
  const { canonical, layers, stored } = await buildFixture();
  const expected = materialize(canonical, layers.get('en_us'));
  assert.equal(onlyChanges(diffVariants(expected, stored.get('en_us'))).length, 0);
});

test('diffVariants flags an added block (present in expected, missing in stored)', () => {
  const expected = {
    locale: 'x',
    canonicalId: 'canon/x',
    blocks: [{
      id: 'legal', type: 'compliance', content: { text: 'req' }, derivedFrom: 'h',
    }],
  };
  const actual = { locale: 'x', canonicalId: 'canon/x', blocks: [] };
  const changes = diffVariants(expected, actual);
  assert.equal(changes[0].status, 'added');
  assert.equal(changes[0].blockId, 'legal');
});

test('variantStatus maps severity to the MSM icon vocabulary', () => {
  assert.equal(variantStatus([]).level, 'ok');
  assert.equal(variantStatus([{ severity: 'warning' }]).level, 'warning');
  assert.equal(variantStatus([{ severity: 'warning' }, { severity: 'critical' }]).level, 'critical');
});

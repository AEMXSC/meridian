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
import { planPropagation, applyPropagation } from '../../tools/apps/meridian/core/propagate.js';
import rollback from '../../tools/apps/meridian/core/rollback.js';
import { serializeVariant } from '../../tools/apps/meridian/core/materialize.js';
import buildFixture from '../../tools/apps/meridian/seed/informatica.js';

const NOW = '2026-09-08T00:00:00Z';

// In-memory store standing in for DaStore across the write path.
function fakeStore(seedVariants = new Map()) {
  const live = new Map(seedVariants);
  const queue = new Map();
  return {
    live,
    queue,
    readVariant: async (locale) => live.get(locale) ?? null,
    writeVariant: async (variant) => { live.set(variant.locale, variant); },
    deleteVariant: async (locale) => { live.delete(locale); },
    writeQueueItem: async (item) => { queue.set(item.locale, item); },
  };
}

test('planPropagation scopes to canonical blocks and affects all markets', async () => {
  const { canonical, policies } = await buildFixture();
  const plan = planPropagation(canonical, ['hero', 'nonexistent'], policies);
  assert.deepEqual(plan.changedBlockIds, ['hero']);
  assert.equal(plan.affectedLocales.length, policies.length);

  const noop = planPropagation(canonical, ['nonexistent'], policies);
  assert.equal(noop.affectedLocales.length, 0, 'no real change → nothing affected');
});

test('applyPropagation auto-applies clean markets and gates the rest', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const store = fakeStore();
  const plan = planPropagation(canonical, ['hero'], policies);
  const result = await applyPropagation(store, canonical, plan, { layers, policies, now: NOW });

  // 6 markets carry compliance + high-confidence hero → auto to /live.
  assert.equal(result.applied.length, 6);
  // de_de, fr_fr, en_ae (no compliance) + ja_jp (no layer) → blocked to queue.
  assert.equal(result.gated.length, 4);
  assert.ok(result.gated.every((g) => g.gate === 'blocked'));
  assert.equal(store.live.size, 6, 'only clean variants reached /live');
  assert.equal(store.queue.size, 4, 'gated variants went to the taste queue, not the edge');
});

test('a low-confidence language block is gated for review, not published', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const store = fakeStore();
  const plan = planPropagation(canonical, ['hero'], policies);
  // Scorer that flunks es_mx's hero only.
  const scorer = (entry) => (entry.reason.includes('es_mx') ? 0.4 : 0.95);
  const result = await applyPropagation(store, canonical, plan, {
    layers, policies, scorer, now: NOW,
  });

  const esmx = result.gated.find((g) => g.locale === 'es_mx');
  assert.ok(esmx && esmx.gate === 'review', 'es_mx routed to review');
  assert.ok(!store.live.has('es_mx'), 'es_mx did not reach the edge');
});

test('rollback restores prior /live and deletes variants that had none', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const priorEnUs = {
    locale: 'en_us',
    canonicalId: canonical.id,
    blocks: [{
      id: 'hero', type: 'hero', content: { heading: 'OLD' }, derivedFrom: 'x',
    }],
  };
  const store = fakeStore(new Map([['en_us', priorEnUs]]));
  const plan = planPropagation(canonical, ['hero'], policies);
  const opts = { layers, policies, now: NOW };
  const { snapshot } = await applyPropagation(store, canonical, plan, opts);

  const afterApply = serializeVariant(store.live.get('en_us'));
  assert.notEqual(afterApply, serializeVariant(priorEnUs), 'apply changed en_us');
  await rollback(store, canonical.id, snapshot);

  const afterRollback = serializeVariant(store.live.get('en_us'));
  assert.equal(afterRollback, serializeVariant(priorEnUs), 'en_us restored exactly');
  assert.ok(!store.live.has('es_mx'), 'es_mx (no prior) deleted on rollback');
});

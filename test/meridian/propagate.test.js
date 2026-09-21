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

test('a translation whose source changed is gated for review even at high confidence', async () => {
  const canonical = {
    id: 'canon/x',
    title: 'x',
    updated: NOW,
    blocks: [{
      id: 'hero', type: 'hero', content: { h: 'v2' }, hash: 'new',
    }],
  };
  const layer = {
    locale: 'de_de',
    canonicalId: 'canon/x',
    entries: [{
      blockId: 'hero', layer: 'language', operation: 'translate', value: { h: 'alt' }, reason: 'r', provenance: 'agent', confidence: 0.99, status: 'auto-applied', sourceHash: 'old',
    }],
  };
  const store = fakeStore();
  const policies = [{ locale: 'de_de', requiredLayers: [] }];
  const plan = planPropagation(canonical, ['hero'], policies);
  const result = await applyPropagation(store, canonical, plan, { layers: new Map([['de_de', layer]]), policies, now: NOW });
  const de = result.gated.find((g) => g.locale === 'de_de');
  assert.ok(de && de.gate === 'review', 'source-changed translation routed to review, not auto');
  assert.ok(!store.live.has('de_de'), 'the outdated translation was not auto-published');
});

test('a non-language override whose source changed is also gated for review', async () => {
  const canonical = {
    id: 'canon/x',
    title: 'x',
    updated: NOW,
    blocks: [{
      id: 'price', type: 'commercial', content: { amount: 'v2' }, hash: 'new',
    }],
  };
  const layer = {
    locale: 'de_de',
    canonicalId: 'canon/x',
    entries: [{
      blockId: 'price', layer: 'commercial', operation: 'override', value: { amount: 'DE' }, reason: 'r', provenance: 'human', confidence: null, status: 'human-owned', sourceHash: 'old',
    }],
  };
  const store = fakeStore();
  const policies = [{ locale: 'de_de', requiredLayers: [] }];
  const plan = planPropagation(canonical, ['price'], policies);
  const result = await applyPropagation(store, canonical, plan, { layers: new Map([['de_de', layer]]), policies, now: NOW });
  const de = result.gated.find((g) => g.locale === 'de_de');
  assert.ok(de && de.gate === 'review', 'commercial override with moved source routed to review');
  assert.ok(!store.live.has('de_de'), 'stale override not auto-published');
});

test('publish:true pushes auto-applied variants to the edge and flags published', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const store = fakeStore();
  const published = [];
  store.publishVariant = async (locale) => { published.push(locale); };
  const plan = planPropagation(canonical, ['hero'], policies);
  const result = await applyPropagation(store, canonical, plan, {
    layers, policies, now: NOW, publish: true,
  });
  assert.ok(result.applied.length > 0);
  assert.ok(result.applied.every((a) => a.published === true), 'all auto-applied flagged published');
  assert.equal(published.length, result.applied.length, 'each auto-applied market published once');
});

test('a publish failure is isolated: variant is written, recorded, not fatal', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const store = fakeStore();
  store.publishVariant = async () => { throw new Error('edge boom'); };
  const plan = planPropagation(canonical, ['hero'], policies);
  const result = await applyPropagation(store, canonical, plan, {
    layers, policies, now: NOW, publish: true,
  });
  assert.ok(result.applied.every((a) => a.published === false), 'not marked published');
  assert.ok(result.failed.some((f) => /not published/.test(f.error)), 'publish failure recorded');
  assert.ok(store.live.size > 0, 'variants still written to DA source');
});

test('applyPropagation without publish never calls the edge (default off)', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const store = fakeStore();
  let called = 0;
  store.publishVariant = async () => { called += 1; };
  const plan = planPropagation(canonical, ['hero'], policies);
  await applyPropagation(store, canonical, plan, { layers, policies, now: NOW });
  assert.equal(called, 0, 'publish is opt-in');
});

test('rollback with publish re-publishes restored and unpublishes deleted', async () => {
  const id = 'canon/offers/spring-refresh';
  const prior = { locale: 'en_us', canonicalId: id, blocks: [] };
  const store = fakeStore(new Map([['en_us', prior]]));
  const published = [];
  const unpublished = [];
  store.publishVariant = async (l) => { published.push(l); };
  store.unpublishVariant = async (l) => { unpublished.push(l); };
  await rollback(store, id, { en_us: prior, es_mx: null }, { publish: true });
  assert.deepEqual(published, ['en_us'], 'restored market re-published');
  assert.deepEqual(unpublished, ['es_mx'], 'deleted market unpublished');
});

test('a market with no layer + no compliance requirement stamps its real locale', async () => {
  const canonical = {
    id: 'canon/x',
    title: 'x',
    updated: NOW,
    blocks: [{
      id: 'hero', type: 'hero', content: { a: 1 }, hash: 'h1',
    }],
  };
  const store = fakeStore();
  const policies = [{ locale: 'zz', requiredLayers: [] }];
  const plan = planPropagation(canonical, ['hero'], policies);
  const opts = { layers: new Map(), policies, now: NOW };
  const result = await applyPropagation(store, canonical, plan, opts);
  assert.equal(result.applied.length, 1);
  assert.equal(store.live.get('zz')?.locale, 'zz', 'variant keyed by real locale, not canonical id');
});

test('applyPropagation rejects a plan that does not match the canonical', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const plan = planPropagation(canonical, ['hero'], policies);
  const other = { ...canonical, id: 'canon/other' };
  await assert.rejects(
    () => applyPropagation(fakeStore(), other, plan, { layers, policies, now: NOW }),
    /mismatch/,
  );
});

test('a per-market write failure is isolated; snapshot and other markets survive', async () => {
  const { canonical, policies, layers } = await buildFixture();
  const store = fakeStore();
  const realWrite = store.writeVariant;
  store.writeVariant = async (v) => {
    if (v.locale === 'en_us') throw new Error('boom');
    return realWrite(v);
  };
  const plan = planPropagation(canonical, ['hero'], policies);
  const result = await applyPropagation(store, canonical, plan, { layers, policies, now: NOW });
  assert.ok(result.failed.some((f) => f.locale === 'en_us'), 'en_us recorded as failed');
  assert.ok(!store.live.has('en_us'), 'failed market not on the edge');
  assert.ok(result.applied.length >= 1, 'other clean markets still applied');
  assert.ok('en_us' in result.snapshot, 'snapshot still captured for the failed market');
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

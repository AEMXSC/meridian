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
import ingestMsm from '../../tools/apps/meridian/core/migrate.js';
import { materialize } from '../../tools/apps/meridian/core/materialize.js';

const NOW = '2026-09-19T00:00:00Z';

function sampleSite() {
  return {
    canonicalId: 'canon/offers/spring',
    title: 'Spring Offer',
    source: {
      blocks: [
        { id: 'hero', type: 'hero', content: { heading: 'Spring savings' } },
        { id: 'price', type: 'commercial', content: { amount: '10 USD' } },
        { id: 'legal', type: 'compliance', content: { text: 'Standard terms.' } },
      ],
    },
    markets: [
      // de_de: translated hero, local price, its own legal, imported.
      {
        locale: 'de_de',
        blocks: [
          { id: 'hero', type: 'hero', content: { heading: 'Frühlingsangebot' } },
          { id: 'price', type: 'commercial', content: { amount: '10 EUR' } },
          { id: 'legal', type: 'compliance', content: { text: 'Pflichtangabe.' } },
        ],
      },
      // en_gb: only the hero differs; price + legal identical → inherited.
      {
        locale: 'en_gb',
        blocks: [
          { id: 'hero', type: 'hero', content: { heading: 'Spring savings, GB' } },
          { id: 'price', type: 'commercial', content: { amount: '10 USD' } },
          { id: 'legal', type: 'compliance', content: { text: 'Standard terms.' } },
        ],
      },
    ],
  };
}

test('ingests a source + N markets into one canonical plus N adaptation sets', async () => {
  const { canonical, layers, policies } = await ingestMsm(sampleSite(), { now: NOW });
  assert.equal(canonical.id, 'canon/offers/spring');
  assert.equal(canonical.blocks.length, 3);
  assert.ok(canonical.blocks.every((b) => typeof b.hash === 'string' && b.hash.length > 0));
  assert.equal(layers.size, 2);
  assert.equal(policies.length, 2);
});

test('an identical market block is inherited (no entry authored)', async () => {
  const { layers } = await ingestMsm(sampleSite(), { now: NOW });
  const gb = layers.get('en_gb');
  const blockIds = gb.entries.map((e) => e.blockId);
  assert.deepEqual(blockIds, ['hero'], 'only the differing hero becomes an entry');
});

test('differing blocks are classified into typed layers', async () => {
  const { layers } = await ingestMsm(sampleSite(), { now: NOW });
  const de = layers.get('de_de');
  const byBlock = Object.fromEntries(de.entries.map((e) => [e.blockId, e]));
  assert.equal(byBlock.price.layer, 'commercial');
  assert.equal(byBlock.legal.layer, 'compliance');
  assert.equal(byBlock.legal.status, 'human-owned-nonnegotiable', 'imported compliance stays human-owned');
});

test('migration is lossless: recompute reproduces each market block byte-for-byte', async () => {
  const { canonical, layers } = await ingestMsm(sampleSite(), { now: NOW });
  const site = sampleSite();
  site.markets.forEach((market) => {
    const variant = materialize(canonical, layers.get(market.locale));
    const derived = Object.fromEntries(variant.blocks.map((b) => [b.id, b.content]));
    market.blocks.forEach((mb) => {
      assert.deepEqual(derived[mb.id], mb.content, `${market.locale}/${mb.id} recomputes to the original`);
    });
  });
});

test('a market-only block becomes an insert that preserves its real type', async () => {
  const input = sampleSite();
  input.markets[0].blocks.push({ id: 'promo', type: 'hero', content: { text: 'DE-only promo' } });
  const { canonical, layers } = await ingestMsm(input, { now: NOW });
  const promo = layers.get('de_de').entries.find((e) => e.blockId === 'promo');
  assert.equal(promo.operation, 'insert');
  assert.equal(promo.type, 'hero');
  const variant = materialize(canonical, layers.get('de_de'));
  const derived = variant.blocks.find((b) => b.id === 'promo');
  assert.equal(derived.type, 'hero', 'renders as its real component, not the layer name');
  assert.deepEqual(derived.content, { text: 'DE-only promo' });
});

test('a source block the market dropped becomes a remove and recomputes losslessly', async () => {
  const input = sampleSite();
  input.markets[1].blocks = input.markets[1].blocks.filter((b) => b.id !== 'legal');
  const { canonical, layers } = await ingestMsm(input, { now: NOW });
  const gb = layers.get('en_gb');
  const removal = gb.entries.find((e) => e.blockId === 'legal');
  assert.equal(removal.operation, 'remove');
  const variant = materialize(canonical, gb);
  assert.ok(!variant.blocks.some((b) => b.id === 'legal'), 'legal is gone from the GB variant');
});

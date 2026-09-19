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
import { materialize, serializeVariant, isForked } from '../../tools/apps/meridian/core/materialize.js';
import { hashBlockContent } from '../../tools/apps/meridian/core/hash.js';
import buildFixture from '../../tools/apps/meridian/seed/informatica.js';

async function block(id, type, content) {
  return {
    id, type, content, hash: await hashBlockContent(type, content),
  };
}

async function fixtureCanon() {
  return {
    id: 'canon/test',
    title: 'Test',
    blocks: await Promise.all([
      block('hero', 'hero', { heading: 'Hello' }),
      block('price', 'commercial', { amount: '10 USD' }),
    ]),
    updated: '2026-01-01T00:00:00Z',
  };
}

test('materialize is deterministic (the /live artifact invariant)', async () => {
  const canon = await fixtureCanon();
  const layer = {
    locale: 'es_mx',
    canonicalId: canon.id,
    entries: [{
      blockId: 'hero',
      layer: 'language',
      operation: 'translate',
      value: { heading: 'Hola' },
      reason: 'r',
      provenance: 'agent',
      confidence: 0.9,
      status: 'auto-applied',
    }],
  };
  const a = serializeVariant(materialize(canon, layer));
  const b = serializeVariant(materialize(canon, layer));
  assert.equal(a, b);
});

test('delete-and-recompute reproduces stored clean variants byte-for-byte', async () => {
  const { canonical, layers, stored } = await buildFixture();
  const recomputed = materialize(canonical, layers.get('en_us'));
  assert.equal(serializeVariant(recomputed), serializeVariant(stored.get('en_us')));
});

test('materialize does not mutate its inputs', async () => {
  const canon = await fixtureCanon();
  const before = JSON.stringify(canon.blocks);
  const layer = {
    locale: 'x',
    canonicalId: canon.id,
    entries: [{
      blockId: 'hero',
      layer: 'language',
      operation: 'translate',
      value: { heading: 'changed' },
      reason: 'r',
      provenance: 'agent',
      confidence: 0.9,
      status: 'auto-applied',
    }],
  };
  materialize(canon, layer);
  const after = JSON.stringify(canon.blocks);
  assert.equal(before, after);
});

test('higher-precedence layer overwrites lower on the same block', async () => {
  const canon = await fixtureCanon();
  const layer = {
    locale: 'x',
    canonicalId: canon.id,
    entries: [
      {
        blockId: 'price',
        layer: 'commercial',
        operation: 'override',
        value: { amount: '20 EUR' },
        reason: 'r',
        provenance: 'human',
        confidence: null,
        status: 'human-owned',
      },
      {
        blockId: 'price',
        layer: 'language',
        operation: 'translate',
        value: { amount: 'diez dólares' },
        reason: 'r',
        provenance: 'agent',
        confidence: 0.9,
        status: 'auto-applied',
      },
    ],
  };
  const price = materialize(canon, layer).blocks.find((b) => b.id === 'price');
  assert.deepEqual(price.content, { amount: '20 EUR' });
});

test('insert onto an existing canonical block keeps derivedFrom = canonical hash', async () => {
  const canon = await fixtureCanon();
  const legal = await block('legal', 'compliance', { text: 'Standard terms.' });
  const withLegal = { ...canon, blocks: [...canon.blocks, legal] };
  const layer = {
    locale: 'de_de',
    canonicalId: withLegal.id,
    entries: [{
      blockId: 'legal',
      layer: 'compliance',
      operation: 'insert',
      value: { text: 'Pflichtangabe' },
      reason: 'r',
      provenance: 'human:legal',
      confidence: null,
      status: 'human-owned-nonnegotiable',
    }],
  };
  const derived = materialize(withLegal, layer).blocks.find((b) => b.id === 'legal');
  assert.equal(derived.derivedFrom, legal.hash, 'tracks canonical hash, not the insert sentinel');
  assert.deepEqual(derived.content, { text: 'Pflichtangabe' });
});

test('unknown adaptation layer throws rather than mis-sorting', async () => {
  const canon = await fixtureCanon();
  const layer = {
    locale: 'x',
    canonicalId: canon.id,
    entries: [{
      blockId: 'hero',
      layer: 'bogus',
      operation: 'override',
      value: {},
      reason: 'r',
      provenance: 'agent',
      confidence: null,
      status: 'human-owned',
    }],
  };
  assert.throws(() => materialize(canon, layer), /Unknown adaptation layer/);
});

test('fork replaces a block and detaches its provenance from canonical', async () => {
  const canon = await fixtureCanon();
  const layer = {
    locale: 'ja_jp',
    canonicalId: canon.id,
    entries: [{
      blockId: 'hero',
      layer: 'structural',
      operation: 'fork',
      value: { heading: 'Fully custom JP hero' },
      reason: 'Market runs a bespoke hero',
      provenance: 'human',
      confidence: null,
      status: 'human-owned',
    }],
  };
  const derived = materialize(canon, layer);
  const hero = derived.blocks.find((b) => b.id === 'hero');
  const price = derived.blocks.find((b) => b.id === 'price');
  assert.deepEqual(hero.content, { heading: 'Fully custom JP hero' });
  assert.ok(isForked(hero.derivedFrom), 'forked block is flagged as forked');
  assert.notEqual(hero.derivedFrom, canon.blocks[0].hash, 'no longer tracks canonical hash');
  // The unforked block still subscribes to canonical (PRD §12.3).
  assert.equal(price.derivedFrom, canon.blocks[1].hash);
});

test('fork on a non-structural layer throws (keeps compliance-drift detectable)', async () => {
  const canon = await fixtureCanon();
  const layer = {
    locale: 'de_de',
    canonicalId: canon.id,
    entries: [{
      blockId: 'price',
      layer: 'compliance',
      operation: 'fork',
      value: { amount: 'custom' },
      reason: 'r',
      provenance: 'human',
      confidence: null,
      status: 'human-owned-nonnegotiable',
    }],
  };
  assert.throws(() => materialize(canon, layer), /Fork requires the structural layer/);
});

test('insert appends a market-specific block after canonical blocks', async () => {
  const canon = await fixtureCanon();
  const layer = {
    locale: 'de_de',
    canonicalId: canon.id,
    entries: [{
      blockId: 'legal',
      layer: 'compliance',
      operation: 'insert',
      value: { text: 'Pflichtangabe' },
      reason: 'r',
      provenance: 'human:legal',
      confidence: null,
      status: 'human-owned-nonnegotiable',
    }],
  };
  const ids = materialize(canon, layer).blocks.map((b) => b.id);
  assert.deepEqual(ids, ['hero', 'price', 'legal']);
});

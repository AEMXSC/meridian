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
  emptyTm, lookup, record, size, createTmTranslator,
} from '../../tools/apps/meridian/core/tm.js';

test('lookup splits sources into TM hits and misses, deduped and blank-free', () => {
  const tm = record(emptyTm('es'), { Hello: 'Hola' }, { now: 'T' });
  const { hits, misses } = lookup(tm, ['Hello', 'World', 'Hello', '  ']);
  assert.equal(hits.get('Hello'), 'Hola');
  assert.deepEqual(misses, ['World']);
});

test('record is immutable and stamps origin/provider/updated', () => {
  const tm0 = emptyTm('es');
  const tm1 = record(tm0, { Hello: 'Hola' }, { origin: 'mt', provider: 'deepl', now: '2026-09-22T00:00:00Z' });
  assert.equal(size(tm0), 0, 'original untouched');
  assert.equal(size(tm1), 1);
  assert.deepEqual(tm1.entries.Hello, {
    target: 'Hola', origin: 'mt', provider: 'deepl', updated: '2026-09-22T00:00:00Z',
  });
});

test('record ignores blank targets and accepts a Map', () => {
  const tm = record(emptyTm('it'), new Map([['A', 'Aa'], ['B', '   '], ['C', null]]), { now: 'T' });
  assert.equal(size(tm), 1);
  assert.equal(tm.entries.A.target, 'Aa');
});

test('a human override overwrites an MT entry and keeps origin=human', () => {
  let tm = record(emptyTm('es'), { 'Terms apply.': 'Se aplican términos.' }, { origin: 'mt', now: 'T1' });
  tm = record(tm, { 'Terms apply.': 'Se aplican los términos legales.' }, { origin: 'human', now: 'T2' });
  assert.equal(tm.entries['Terms apply.'].origin, 'human');
  assert.equal(tm.entries['Terms apply.'].target, 'Se aplican los términos legales.');
});

test('createTmTranslator serves TM hits and only sends misses to the provider', async () => {
  const tm = record(emptyTm('es'), { Hello: 'Hola' }, { now: 'T' });
  let sentToProvider = null;
  const translate = async (strings) => {
    sentToProvider = strings;
    return new Map(strings.map((s) => [s, `MT:${s}`]));
  };
  const tmt = createTmTranslator({ tm, translate });
  const dict = await tmt.translate(['Hello', 'World'], { to: 'es' });

  assert.deepEqual(sentToProvider, ['World'], 'only the miss went to the provider');
  assert.equal(dict.get('Hello'), 'Hola', 'hit served from TM');
  assert.equal(dict.get('World'), 'MT:World', 'miss translated fresh');
  assert.deepEqual([...tmt.learned], [['World', 'MT:World']], 'only fresh translations are learned');
  assert.deepEqual(tmt.stats, { hits: 1, misses: 1 });
});

test('a human-origin entry is served by lookup — durable sign-off reuse', () => {
  // Prior run recorded a human-authored compliance override; a later run must
  // find it (this is what prefills the Localize override fields).
  const tm = record(emptyTm('es'), { 'SWIFT code CTZIUS33.': 'Código SWIFT CTZIUS33.' }, { origin: 'human', now: 'T' });
  const { hits } = lookup(tm, ['SWIFT code CTZIUS33.', 'New segment']);
  assert.equal(hits.get('SWIFT code CTZIUS33.'), 'Código SWIFT CTZIUS33.');
  assert.equal(hits.size, 1);
});

test('record prefers the caller locale over a stale document field', () => {
  const stale = { locale: 'WRONG', entries: {} };
  const next = record(stale, { A: 'Aa' }, { locale: 'es', now: 'T' });
  assert.equal(next.locale, 'es');
});

test('createTmTranslator does not call the provider when everything is a TM hit', async () => {
  const tm = record(emptyTm('es'), { Hello: 'Hola', World: 'Mundo' }, { now: 'T' });
  let called = false;
  const translate = async () => { called = true; return new Map(); };
  const tmt = createTmTranslator({ tm, translate });
  const dict = await tmt.translate(['Hello', 'World'], { to: 'es' });
  assert.equal(called, false, 'zero provider cost when fully leveraged');
  assert.equal(dict.size, 2);
  assert.equal(tmt.learned.size, 0);
});

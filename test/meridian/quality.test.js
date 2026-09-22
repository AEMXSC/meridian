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
import { scoreSegment, gateDict, MIN_SCORE } from '../../tools/apps/meridian/core/quality.js';

test('a clean translation scores well and passes the gate', () => {
  const r = scoreSegment('Bank without borders.', 'Banca sin fronteras.');
  assert.equal(r.ok, true);
  assert.ok(r.score >= MIN_SCORE);
  assert.deepEqual(r.issues, []);
});

test('an empty translation is an immediate fail', () => {
  const r = scoreSegment('Learn more', '   ');
  assert.equal(r.score, 0);
  assert.equal(r.ok, false);
});

test('an untranslated multi-word segment (identical to source) is flagged', () => {
  const r = scoreSegment('Send money internationally today', 'Send money internationally today');
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /untranslated/.test(i.detail)));
});

test('a dropped number is an accuracy failure', () => {
  const r = scoreSegment('Arrives in 1-3 business days', 'Llega en pocos días');
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.dimension === 'accuracy' && /number/.test(i.detail)));
});

test('a dropped SWIFT-style code is a terminology failure', () => {
  const r = scoreSegment('Use SWIFT code CTZIUS33 to receive.', 'Usa el código para recibir.');
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /CTZIUS33/.test(i.detail)));
});

test('an altered do-not-translate term is caught when dnt is supplied', () => {
  const clean = scoreSegment('Open a Quest account.', 'Abre una cuenta Quest.', { dnt: ['Quest'] });
  assert.equal(clean.ok, true);
  const bad = scoreSegment('Open a Quest account.', 'Abre una cuenta Búsqueda.', { dnt: ['Quest'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => /do-not-translate/.test(i.detail)));
});

test('a locale-reformatted number passes (US 1,234.56 -> DE 1.234,56)', () => {
  const r = scoreSegment('Transfer up to 1,234.56 EUR per day.', 'Überweisen Sie bis zu 1.234,56 EUR pro Tag.');
  assert.equal(r.ok, true);
  assert.ok(!r.issues.some((i) => /number/.test(i.detail)), 'reformatted number must not be flagged as dropped');
});

test('an all-caps marketing word translated is not treated as a dropped code', () => {
  const r = scoreSegment('FREE shipping on every order placed today.', 'Envío GRATIS en cada pedido realizado hoy.');
  assert.equal(r.ok, true);
  assert.ok(!r.issues.some((i) => /dropped code/.test(i.detail)), 'pure-alpha caps word is not a code');
});

test('a short microcopy segment expanding several-fold is not flagged on length', () => {
  const r = scoreSegment('Go', 'Comenzar ahora');
  assert.equal(r.ok, true);
  assert.ok(!r.issues.some((i) => /length ratio/.test(i.detail)), 'short strings are exempt from the ratio check');
});

test('a long segment left untranslated still fails (ratio check retained)', () => {
  const src = 'Open your account online in just a few minutes with no paperwork.';
  const r = scoreSegment(src, 'Yes');
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /length ratio/.test(i.detail)));
});

test('gateDict splits a dict into publishable pass and held-for-review flagged', () => {
  const { pass, flagged } = gateDict({
    'Bank without borders.': 'Banca sin fronteras.',
    'Arrives in 1-3 days': 'Llega pronto', // drops "1-3"
  });
  assert.equal(pass.get('Bank without borders.'), 'Banca sin fronteras.');
  assert.equal(pass.has('Arrives in 1-3 days'), false, 'the bad one is held, not published');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].source, 'Arrives in 1-3 days');
  assert.ok(flagged[0].issues.length);
});

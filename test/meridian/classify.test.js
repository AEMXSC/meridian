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
import createClassifier, { heuristicClassifier } from '../../tools/apps/meridian/core/classify.js';

test('classifies a legal/disclosure block as compliance', () => {
  const r = heuristicClassifier({ id: 'legal', type: 'compliance', content: 'Standard disclosure' });
  assert.equal(r.layer, 'compliance');
  assert.ok(r.confidence >= 0.9);
});

test('classifies a price/offer block as commercial', () => {
  assert.equal(heuristicClassifier({ id: 'price', type: 'block', content: { amount: '10' } }).layer, 'commercial');
  assert.equal(heuristicClassifier({ id: 'promo-cta', type: 'block', content: 'Buy now' }).layer, 'commercial');
});

test('classifies a hero/media block as creative', () => {
  assert.equal(heuristicClassifier({ id: 'hero', type: 'hero', content: {} }).layer, 'creative');
});

test('a plain text change with no signal defaults to language', () => {
  const r = heuristicClassifier({ id: 'intro', type: 'text', content: 'Welcome to our product' });
  assert.equal(r.layer, 'language');
  assert.ok(r.confidence > 0 && r.confidence < 0.9);
});

test('a non-text change with no signal defaults to creative', () => {
  assert.equal(heuristicClassifier({ id: 'widget', type: 'block', content: { a: 1 } }).layer, 'creative');
});

test('commercial signal wins over a generic text change', () => {
  // "discount" must not be mislabelled language just because the content is text.
  assert.equal(heuristicClassifier({ id: 'x', type: 'text', content: 'Save with our discount' }).layer, 'commercial');
});

test('createClassifier defaults to the heuristic and accepts an override', () => {
  const auto = createClassifier();
  assert.equal(auto({ id: 'legal', type: 't', content: 'x' }).layer, 'compliance');
  const stub = createClassifier(() => ({ layer: 'creative', confidence: 1, reason: 'stub' }));
  assert.equal(stub({ id: 'legal', type: 't', content: 'x' }).layer, 'creative');
});

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
import createArchitect, { heuristicArchitect } from '../../tools/apps/meridian/core/propose.js';

test('the walkthrough example: Quebec French, keep US pricing, needs a disclosure', () => {
  const p = heuristicArchitect('Add a Quebec French market: translate everything, keep US pricing, and it legally needs a French disclosure');
  assert.equal(p.locale, 'fr_ca');
  assert.ok(p.requiredLayers.includes('language'));
  assert.ok(p.requiredLayers.includes('compliance'));
  assert.ok(!p.requiredLayers.includes('commercial'), 'pricing inherited, no commercial layer');
  assert.ok(p.notes.some((n) => /inherit|ride/i.test(n)));
  assert.equal(p.confidence, 0.9);
});

test('recognizes an explicit locale code when no market name is used', () => {
  assert.equal(heuristicArchitect('stand up de_de with local pricing').locale, 'de_de');
});

test('local pricing implies a commercial layer', () => {
  assert.ok(heuristicArchitect('German market with local pricing').requiredLayers.includes('commercial'));
});

test('language is the default and can be opted out', () => {
  assert.ok(heuristicArchitect('a UK market').requiredLayers.includes('language'));
  const noLang = heuristicArchitect('a UK market, keep English, no translation');
  assert.ok(!noLang.requiredLayers.includes('language'));
});

test('an unrecognized market yields no locale, low confidence, and a prompt to set it', () => {
  const p = heuristicArchitect('a new market somewhere');
  assert.equal(p.locale, null);
  assert.equal(p.confidence, 0.3);
  assert.ok(p.notes.some((n) => /set the locale/i.test(n)));
});

test('compliance signal is flagged human-authored and non-publishable', () => {
  const p = heuristicArchitect('Japanese market that needs a legal disclaimer');
  assert.ok(p.requiredLayers.includes('compliance'));
  assert.ok(p.notes.some((n) => /human-authored|non-publishable/i.test(n)));
});

test('createArchitect defaults to the heuristic and accepts an override', () => {
  assert.equal(createArchitect()('French market').locale, 'fr_fr');
  const stub = createArchitect(() => ({
    locale: 'xx_yy', requiredLayers: [], confidence: 1, notes: [],
  }));
  assert.equal(stub('anything').locale, 'xx_yy');
});

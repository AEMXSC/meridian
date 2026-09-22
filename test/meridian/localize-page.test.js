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
  localizePage, classifySegment, applyLocalization, hasPendingOverrides,
} from '../../tools/apps/meridian/core/localize-page.js';

const PAGE = '<main><div><div class="hero-commercial"><div><div>'
  + '<h1>Bank without borders.</h1>'
  + '<p>Send money internationally and access your accounts abroad.</p>'
  + '<p>Order foreign currency with no hidden fees and competitive exchange rates.</p>'
  + '<p>Share Citizens SWIFT code (CTZIUS33) with the sender.</p>'
  + '</div></div></div></div></main>';

// Stub translator: prefixes each source with the target tag so assertions are
// deterministic and we never hit a network service in tests.
const stubTranslate = async (strings, { to }) => new Map(strings.map((s) => [s, `[${to}] ${s}`]));

test('classifySegment routes money -> commercial, legal -> compliance, else language', () => {
  assert.equal(classifySegment('Bank without borders.'), 'language');
  assert.equal(classifySegment('no hidden fees and competitive exchange rates'), 'commercial');
  assert.equal(classifySegment('Share the SWIFT code with the sender.'), 'compliance');
  assert.equal(classifySegment('Order foreign currency online.'), 'language');
});

test('localizePage translates the language layer and preserves page structure', async () => {
  const { html } = await localizePage(PAGE, stubTranslate, { to: 'es' });
  assert.ok(html.includes('<h1>[es] Bank without borders.</h1>'));
  assert.ok(html.includes('<div class="hero-commercial">'), 'block class preserved');
});

test('localizePage withholds commercial/compliance segments from the published page (PRD §11)', async () => {
  const { html } = await localizePage(PAGE, stubTranslate, { to: 'es' });
  // The machine never authors these — they stay in the source language.
  assert.ok(html.includes('no hidden fees and competitive exchange rates'), 'commercial not translated');
  assert.ok(html.includes('Citizens SWIFT code (CTZIUS33)'), 'compliance not translated');
  assert.ok(!html.includes('[es] Order foreign currency'), 'commercial was not machine-translated in');
  assert.ok(!html.includes('[es] Share Citizens SWIFT'), 'compliance was not machine-translated in');
});

test('localizePage lists only the commercial/compliance segments for human localization', async () => {
  const { review } = await localizePage(PAGE, stubTranslate, { to: 'es' });
  const layers = review.map((r) => r.layer).sort();
  assert.deepEqual(layers, ['commercial', 'compliance']);
  const compliance = review.find((r) => r.layer === 'compliance');
  assert.ok(compliance.source.includes('SWIFT'));
  // No machine translation is attached — the human authors these.
  assert.ok(!('translated' in compliance));
});

test('localizePage coverage is honest: only the translated language layer counts', async () => {
  const { coverage } = await localizePage(PAGE, stubTranslate, { to: 'es' });
  assert.equal(coverage.total, 4);
  assert.equal(coverage.translated, 2, 'two language segments translated; two withheld');
  assert.equal(coverage.ratio, 0.5);
});

test('localizePage requires a target locale', async () => {
  await assert.rejects(() => localizePage(PAGE, stubTranslate, {}), /target locale/);
});

test('localizePage returns the language dict so a Localize flow can add overrides', async () => {
  const { dict } = await localizePage(PAGE, stubTranslate, { to: 'es' });
  assert.equal(dict.get('Bank without borders.'), '[es] Bank without borders.');
  // Only language segments are in the dict; withheld ones are not.
  assert.ok(![...dict.keys()].some((k) => k.includes('SWIFT')));
});

test('applyLocalization merges human overrides over language and escapes them', async () => {
  const { dict } = await localizePage(PAGE, stubTranslate, { to: 'es' });
  const out = applyLocalization(PAGE, dict, {
    'Share Citizens SWIFT code (CTZIUS33) with the sender.': 'Comparta el código SWIFT de Citizens (CTZIUS33) & envíe.',
  });
  assert.ok(out.includes('<h1>[es] Bank without borders.</h1>'), 'language still applied');
  assert.ok(out.includes('código SWIFT de Citizens (CTZIUS33) &amp; envíe'), 'override applied + escaped');
});

test('applyLocalization ignores blank overrides (segment stays in source language)', () => {
  const html = '<p>Standard terms apply.</p>';
  const out = applyLocalization(html, {}, { 'Standard terms apply.': '   ' });
  assert.equal(out, html);
});

test('hasPendingOverrides detects any non-blank staged override (guards against data loss)', () => {
  assert.equal(hasPendingOverrides([]), false);
  assert.equal(hasPendingOverrides([{ overrides: {} }]), false);
  assert.equal(hasPendingOverrides([{ overrides: { x: '   ' } }]), false, 'blank does not count');
  assert.equal(hasPendingOverrides([{ overrides: { x: 'Comparta el código' } }]), true);
  assert.equal(hasPendingOverrides([{ ok: false }, { overrides: { a: 'b' } }]), true);
  assert.equal(hasPendingOverrides(new Map([['es', { overrides: { a: 'b' } }]]).values()), true);
});

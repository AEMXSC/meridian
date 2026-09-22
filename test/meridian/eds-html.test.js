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
  extractStrings, localizeHtml, coverage, scanText,
} from '../../tools/apps/meridian/core/eds-html.js';

// A faithful slice of the real citizens international-banking page: a
// hero-commercial block (picture + heading + body + CTA) inside a section.
const PAGE = '<main><div><div class="hero-commercial"><div><div>'
  + '<picture><img src="https://ex/x.png" alt="A traveler on their phone" loading="lazy"></picture>'
  + '</div><div></div><div><h1>Bank without borders.</h1>'
  + '<p>Send money internationally, access your accounts abroad, and manage foreign exchange.</p>'
  + '<p><a href="/international-banking#get-started"><strong>Explore International Services</strong></a></p>'
  + '</div></div></div></div></main>';

test('extractStrings returns text segments in document order, deduped, tags/whitespace excluded', () => {
  assert.deepEqual(extractStrings(PAGE), [
    'Bank without borders.',
    'Send money internationally, access your accounts abroad, and manage foreign exchange.',
    'Explore International Services',
  ]);
});

test('extractStrings does not pick up attribute values (only element text)', () => {
  // "A traveler on their phone" is an alt attribute, not text content.
  assert.ok(!extractStrings(PAGE).includes('A traveler on their phone'));
});

test('localizeHtml with an empty dict is the identity (byte-for-byte round-trip)', () => {
  assert.equal(localizeHtml(PAGE, {}), PAGE);
});

test('localizeHtml swaps only matched text and preserves every tag, attribute and block class', () => {
  const out = localizeHtml(PAGE, {
    'Bank without borders.': 'Banca sin fronteras.',
    'Explore International Services': 'Explorar servicios internacionales',
  });
  assert.ok(out.includes('<h1>Banca sin fronteras.</h1>'));
  assert.ok(out.includes('<strong>Explorar servicios internacionales</strong>'));
  // Untranslated body stays in source language.
  assert.ok(out.includes('Send money internationally, access your accounts abroad, and manage foreign exchange.'));
  // Structure preserved exactly.
  assert.ok(out.includes('<div class="hero-commercial">'));
  assert.ok(out.includes('<img src="https://ex/x.png" alt="A traveler on their phone" loading="lazy">'));
  assert.ok(out.includes('<a href="/international-banking#get-started">'));
});

test('localizeHtml accepts a Map as well as a plain object', () => {
  const out = localizeHtml(PAGE, new Map([['Bank without borders.', 'Banca sin fronteras.']]));
  assert.ok(out.includes('<h1>Banca sin fronteras.</h1>'));
});

test('scanText preserves leading/trailing whitespace around a replaced segment', () => {
  const frag = '<p>   Hello world   </p>';
  const out = scanText(frag, (t) => (t === 'Hello world' ? 'Hola mundo' : t));
  assert.equal(out, '<p>   Hola mundo   </p>');
});

test('coverage reports translated ratio and the missing source strings', () => {
  const cov = coverage(PAGE, { 'Bank without borders.': 'Banca sin fronteras.' });
  assert.equal(cov.total, 3);
  assert.equal(cov.translated, 1);
  assert.equal(cov.missing.length, 2);
  assert.ok(Math.abs(cov.ratio - 1 / 3) < 1e-9);
});

test('a full round-trip through extract then localize with identity mapping is stable', () => {
  const dict = Object.fromEntries(extractStrings(PAGE).map((s) => [s, s]));
  assert.equal(localizeHtml(PAGE, dict), PAGE);
});

test('localizeHtml escapes markup in a translation (no injection into a live page)', () => {
  const out = localizeHtml('<p>Hello</p>', { Hello: '<img src=x onerror=alert(1)>' });
  assert.equal(out, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  const amp = localizeHtml('<p>AT and T</p>', { 'AT and T': 'AT&T' });
  assert.equal(amp, '<p>AT&amp;T</p>');
});

test('extractStrings decodes entities so the translation unit is plain text', () => {
  assert.deepEqual(extractStrings('<p>Fish &amp; Chips</p>'), ['Fish & Chips']);
});

test('a source entity round-trips unchanged under identity, and re-encodes when translated', () => {
  assert.equal(localizeHtml('<p>Fish &amp; Chips</p>', {}), '<p>Fish &amp; Chips</p>');
  assert.equal(
    localizeHtml('<p>Fish &amp; Chips</p>', { 'Fish & Chips': 'Pescado & patatas' }),
    '<p>Pescado &amp; patatas</p>',
  );
});

test('comments and script/style are opaque: not extracted, not corrupted', () => {
  const withComment = '<div><!-- keep x > y intact --><p>Hello</p></div>';
  assert.deepEqual(extractStrings(withComment), ['Hello']);
  assert.equal(localizeHtml(withComment, { Hello: 'Hola' }), '<div><!-- keep x > y intact --><p>Hola</p></div>');
  const withScript = '<div><script>if (a > b) c()</script><p>Hi</p></div>';
  assert.deepEqual(extractStrings(withScript), ['Hi']);
  assert.equal(localizeHtml(withScript, {}), withScript);
});

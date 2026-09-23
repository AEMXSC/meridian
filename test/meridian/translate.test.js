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
import { createTranslator, localeToLang } from '../../tools/apps/meridian/core/translate.js';

const okJson = (body) => ({ ok: true, json: async () => body, headers: { get: () => null } });

test('localeToLang reduces a DA locale to a service language tag', () => {
  assert.equal(localeToLang('es_es'), 'es');
  assert.equal(localeToLang('it_it'), 'it');
  assert.equal(localeToLang('fr_ca'), 'fr');
  assert.equal(localeToLang('pt_br'), 'pt-BR');
  assert.equal(localeToLang('zh_cn'), 'zh-CN');
  assert.equal(localeToLang('es-ES'), 'es');
});

test('translate posts the target language + strings and maps an ordered array response', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return okJson({ translations: ['Hola', 'Mundo'] });
  };
  const translate = createTranslator(fetchImpl, { endpoint: 'https://w/translate' });
  const map = await translate(['Hello', 'World'], { to: 'es_es' });
  assert.equal(sent.url, 'https://w/translate');
  assert.equal(sent.body.to, 'es');
  assert.deepEqual(sent.body.strings, ['Hello', 'World']);
  assert.equal(map.get('Hello'), 'Hola');
  assert.equal(map.get('World'), 'Mundo');
});

test('translate passes provider + formality, and picks the glossary for the pair', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = JSON.parse(opts.body); return okJson({ translations: ['Hallo'] }); };
  const translate = createTranslator(fetchImpl, {
    endpoint: 'https://w/translate',
    provider: 'deepl',
    formality: 'more',
    glossaries: { 'en:de': 'gloss-en-de', 'en:fr': 'gloss-en-fr' },
  });
  await translate(['Hello'], { from: 'en', to: 'de' });
  assert.equal(sent.provider, 'deepl');
  assert.equal(sent.formality, 'more');
  assert.equal(sent.glossaryId, 'gloss-en-de', 'selects the glossary matching the from:to pair');
});

test('translate omits glossaryId when no glossary matches the pair', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = JSON.parse(opts.body); return okJson({ translations: ['Ciao'] }); };
  const translate = createTranslator(fetchImpl, {
    endpoint: 'https://w/translate', glossaries: { 'en:de': 'gloss-en-de' },
  });
  await translate(['Hi'], { from: 'en', to: 'it' });
  assert.equal('glossaryId' in sent, false);
  assert.equal('formality' in sent, false);
  assert.equal('provider' in sent, false);
});

test('translate de-duplicates the request and skips blank strings', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return okJson({ translations: ['Hola'] });
  };
  const translate = createTranslator(fetchImpl, { endpoint: 'https://w/translate' });
  await translate(['Hello', 'Hello', '   ', ''], { to: 'es' });
  assert.deepEqual(sent.strings, ['Hello']);
});

test('translate requires a target locale', async () => {
  const translate = createTranslator(async () => okJson({}), {});
  await assert.rejects(() => translate(['Hello'], {}), /target locale/);
});

test('translate returns an empty map for no strings without calling fetch', async () => {
  let called = false;
  const translate = createTranslator(async () => { called = true; return okJson({}); }, {});
  const map = await translate([], { to: 'es' });
  assert.equal(map.size, 0);
  assert.equal(called, false);
});

test('translate accepts an object-map response as well as an array', async () => {
  const translate = createTranslator(
    async () => okJson({ map: { Hello: 'Hola', World: 'Mundo' } }),
    {},
  );
  const map = await translate(['Hello', 'World'], { to: 'es' });
  assert.equal(map.get('Hello'), 'Hola');
  assert.equal(map.get('World'), 'Mundo');
});

test('translate throws on a non-ok response', async () => {
  const translate = createTranslator(
    async () => ({ ok: false, status: 502, headers: { get: () => 'upstream down' } }),
    {},
  );
  await assert.rejects(() => translate(['Hello'], { to: 'es' }), /translation failed: upstream down/);
});

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
import { readSheet, writeSheet, upsertRows } from '../../tools/apps/meridian/core/da-config.js';

test('readSheet tolerates multi-sheet, single-sheet, bare array, and null', () => {
  assert.deepEqual(readSheet(null, 'languages'), []);
  assert.deepEqual(readSheet([{ a: 1 }], 'languages'), [{ a: 1 }]);
  assert.deepEqual(readSheet({ ':type': 'sheet', data: [{ a: 1 }] }, 'languages'), [{ a: 1 }]);
  assert.deepEqual(
    readSheet({ ':type': 'multi-sheet', ':names': ['languages'], languages: { data: [{ locale: 'fr_ca' }] } }, 'languages'),
    [{ locale: 'fr_ca' }],
  );
});

test('writeSheet preserves sibling sheets and refreshes metadata', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['config', 'dnt-content-rules'],
    ':version': 3,
    config: {
      total: 1, limit: 1, offset: 0, data: [{ key: 'x' }],
    },
    'dnt-content-rules': {
      total: 1, limit: 1, offset: 0, data: [{ term: 'Acme' }],
    },
  };
  const next = writeSheet(existing, 'languages', [{ locale: 'fr_ca' }]);
  assert.deepEqual(readSheet(next, 'config'), [{ key: 'x' }], 'config sheet preserved');
  assert.deepEqual(readSheet(next, 'dnt-content-rules'), [{ term: 'Acme' }], 'DNT sheet preserved');
  assert.deepEqual(readSheet(next, 'languages'), [{ locale: 'fr_ca' }], 'languages sheet added');
  assert.equal(next[':type'], 'multi-sheet');
  assert.ok(next[':names'].includes('config') && next[':names'].includes('languages'));
  assert.notEqual(next, existing, 'returns a new object (no mutation)');
});

test('writeSheet normalizes an empty single-sheet doc to multi-sheet', () => {
  const empty = { ':type': 'sheet', ':sheetname': 'data', data: [] };
  const next = writeSheet(empty, 'languages', [{ locale: 'de_de' }]);
  assert.equal(next[':type'], 'multi-sheet');
  assert.deepEqual(readSheet(next, 'languages'), [{ locale: 'de_de' }]);
});

test('writeSheet on a POPULATED single-sheet doc preserves rows and keeps :names clean', () => {
  // The bug: a pre-existing single-sheet /.da/translate.json must not have its
  // total/limit/offset/data/:sheetname keys treated as sibling sheets.
  const populated = {
    ':type': 'sheet', ':sheetname': 'data', total: 2, limit: 2, offset: 0, data: [{ a: 1 }, { a: 2 }],
  };
  const next = writeSheet(populated, 'languages', [{ locale: 'fr_fr' }]);
  assert.equal(next[':type'], 'multi-sheet');
  assert.deepEqual(next[':names'].sort(), ['data', 'languages'], ':names has only real sheets');
  assert.ok(!next[':names'].includes('total') && !next[':names'].includes('offset'), 'no polluted names');
  assert.deepEqual(readSheet(next, 'data'), [{ a: 1 }, { a: 2 }], 'original rows preserved + readable');
  assert.deepEqual(readSheet(next, 'languages'), [{ locale: 'fr_fr' }]);
});

test('upsertRows throws on a falsy keyField (never collapse a sheet to one row)', () => {
  assert.throws(() => upsertRows(null, 'languages', [{ a: 1 }], undefined), /keyField/);
});

test('upsertRows replaces by key and appends new keys, preserving siblings', () => {
  const doc = {
    ':type': 'multi-sheet',
    ':names': ['languages', 'config'],
    languages: { data: [{ locale: 'de_de', language: 'German', action: 'translate' }] },
    config: { data: [{ key: 'translate.behavior', value: 'overwrite' }] },
  };
  const next = upsertRows(doc, 'languages', [
    { locale: 'de_de', action: 'copy' },
    { locale: 'fr_ca', language: 'French (Canada)', action: 'translate' },
  ], 'locale');
  const langs = readSheet(next, 'languages');
  assert.equal(langs.length, 2, 'de_de updated in place, fr_ca appended');
  assert.equal(langs.find((l) => l.locale === 'de_de').action, 'copy', 'existing row merged');
  assert.equal(langs.find((l) => l.locale === 'de_de').language, 'German', 'untouched field kept');
  assert.ok(langs.find((l) => l.locale === 'fr_ca'));
  assert.deepEqual(readSheet(next, 'config'), [{ key: 'translate.behavior', value: 'overwrite' }]);
});

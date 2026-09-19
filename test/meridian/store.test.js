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
  canonPath, adaptPath, livePath, queuePath, rejectionPath,
} from '../../tools/apps/meridian/core/store.js';

const ID = 'canon/offers/spring-refresh';

test('path builders scope under the base for valid inputs', () => {
  assert.equal(canonPath('/meridian', ID), '/meridian/canon/offers/spring-refresh.json');
  assert.equal(adaptPath('/meridian', 'es_mx', ID), '/meridian/adapt/es_mx/offers/spring-refresh.json');
  assert.equal(livePath('/meridian', 'es_mx', ID), '/meridian/live/es_mx/offers/spring-refresh.json');
  assert.equal(queuePath('/meridian', 'es_mx', ID), '/meridian/taste-queue/es_mx/offers/spring-refresh.json');
  assert.equal(rejectionPath('/meridian', 'es_mx', ID), '/meridian/rejections/es_mx/offers/spring-refresh.json');
});

test('path builders reject traversal and malformed segments', () => {
  assert.throws(() => canonPath('/meridian', 'canon/../../index'), /Unsafe canonicalId/);
  assert.throws(() => canonPath('/meridian', '/canon/x'), /Unsafe canonicalId/);
  assert.throws(() => canonPath('/meridian', 'offers/x'), /Unsafe canonicalId/, 'must start with canon/');
  assert.throws(() => adaptPath('/meridian', '../etc', ID), /Unsafe locale/);
  assert.throws(() => adaptPath('/meridian', 'es/mx', ID), /Unsafe locale/);
  assert.throws(() => livePath('/meridian', 'es_mx', 'canon/../secret'), /Unsafe canonicalId/);
  assert.throws(() => rejectionPath('/meridian', '../etc', ID), /Unsafe locale/);
  assert.throws(() => rejectionPath('/meridian', 'es_mx', 'canon/../secret'), /Unsafe canonicalId/);
});

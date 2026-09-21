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
import runWithConcurrency from '../../tools/apps/meridian/core/concurrency.js';

test('never exceeds the concurrency limit and runs every task', async () => {
  let inflight = 0;
  let peak = 0;
  let done = 0;
  const tasks = Array.from({ length: 12 }, () => async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((r) => { setTimeout(r, 5); });
    inflight -= 1;
    done += 1;
  });
  const results = await runWithConcurrency(tasks, 3);
  assert.equal(done, 12, 'all tasks ran');
  assert.ok(peak <= 3, `peak concurrency ${peak} stayed within the limit`);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 12);
});

test('isolates a failing task (settles, does not reject the batch)', async () => {
  const tasks = [
    async () => 'ok',
    async () => { throw new Error('boom'); },
    async () => 'ok2',
  ];
  const results = await runWithConcurrency(tasks, 2);
  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
});

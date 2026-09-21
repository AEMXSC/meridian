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

// Sliding-window concurrency limiter (ported from MSM's helpers/api.js, kept as
// a pure module with no DA/https imports so the engine stays node-testable).
// Bounds how many market recomputes hit DA at once during a propagation, instead
// of firing an unbounded Promise.all across every market.

export const DEFAULT_CONCURRENCY = 5;

/**
 * Run task factories with at most `limit` in flight at a time. Never rejects —
 * returns a settled result per task (like Promise.allSettled), so callers that
 * handle failures per item (e.g. applyPropagation) keep working.
 * @param {Array<() => Promise<unknown>>} tasks - each starts work when called
 * @param {number} [limit]
 * @returns {Promise<PromiseSettledResult<unknown>[]>}
 */
/* eslint-disable no-restricted-syntax, no-await-in-loop */
export default async function runWithConcurrency(tasks, limit = DEFAULT_CONCURRENCY) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(task);
    results.push(p);
    // Track a swallowed copy so a rejecting task can never reject the
    // Promise.race that paces the window (results still settle truthfully).
    const done = p.catch(() => {}).then(() => { executing.delete(done); });
    executing.add(done);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(results);
}
/* eslint-enable no-restricted-syntax, no-await-in-loop */

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

import { stableStringify } from './hash.js';

// Block-level diff behind the "view only the changes" review affordance that
// authors already rely on in the request-publish inbox. Given what canonical +
// layers would produce (expected) and what a market currently stores (actual),
// it reports what would change on recompute — so a drift/stale finding or a
// taste-queue item can show exactly the affected blocks, not a whole page.

/**
 * @typedef {Object} BlockChange
 * @property {string} blockId
 * @property {'added'|'removed'|'changed'|'unchanged'} status
 * @property {unknown} [expected] - content canonical + layers would produce
 * @property {unknown} [actual] - content currently stored
 */

/**
 * @param {import('./schemas.js').DerivedVariant} expected
 * @param {import('./schemas.js').DerivedVariant} actual
 * @returns {BlockChange[]} one entry per block, in expected order then extras
 */
export function diffVariants(expected, actual) {
  const expectedById = new Map(expected.blocks.map((b) => [b.id, b]));
  const actualById = new Map(actual.blocks.map((b) => [b.id, b]));
  const order = [
    ...expected.blocks.map((b) => b.id),
    ...actual.blocks.map((b) => b.id).filter((id) => !expectedById.has(id)),
  ];

  return order.map((blockId) => {
    const exp = expectedById.get(blockId);
    const act = actualById.get(blockId);
    if (exp && !act) return { blockId, status: 'added', expected: exp.content };
    if (!exp && act) return { blockId, status: 'removed', actual: act.content };
    const changed = stableStringify(exp.content) !== stableStringify(act.content);
    return changed
      ? {
        blockId, status: 'changed', expected: exp.content, actual: act.content,
      }
      : { blockId, status: 'unchanged' };
  });
}

/**
 * The subset an author cares about when reviewing — everything except
 * unchanged blocks ("view only the changes").
 * @param {BlockChange[]} changes
 * @returns {BlockChange[]}
 */
export function onlyChanges(changes) {
  return changes.filter((c) => c.status !== 'unchanged');
}

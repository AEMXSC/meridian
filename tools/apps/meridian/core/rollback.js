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

// Revert a propagation across every touched market in one action (PRD §8
// Phase 2). Restores each locale's prior /live variant from the snapshot the
// apply captured, or deletes it if there was no prior variant — returning the
// edge to its exact pre-propagation state.

/**
 * @param {{ writeVariant: Function, deleteVariant: Function }} store
 * @param {string} canonicalId
 * @param {Record<string, import('./schemas.js').DerivedVariant|null>} snapshot
 * @returns {Promise<{ restored: string[], deleted: string[] }>}
 */
export default async function rollback(store, canonicalId, snapshot) {
  const restored = [];
  const deleted = [];
  await Promise.all(Object.entries(snapshot).map(async ([locale, prior]) => {
    if (prior) {
      await store.writeVariant(prior);
      restored.push(locale);
    } else {
      await store.deleteVariant(locale, canonicalId);
      deleted.push(locale);
    }
  }));
  return { restored, deleted };
}

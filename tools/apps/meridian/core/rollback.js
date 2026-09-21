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
 * @param {object} store - writeVariant/deleteVariant, and optional
 *   publishVariant/unpublishVariant used when opts.publish is set
 * @param {string} canonicalId
 * @param {Record<string, import('./schemas.js').DerivedVariant|null>} snapshot
 * @param {{ publish?: boolean }} [opts] - when publish, also restore the edge:
 *   re-publish restored variants and unpublish deleted ones (best-effort).
 * @returns {Promise<{ restored: string[], deleted: string[] }>}
 */
export default async function rollback(store, canonicalId, snapshot, opts = {}) {
  const restored = [];
  const deleted = [];
  const { publish = false } = opts;
  await Promise.all(Object.entries(snapshot).map(async ([locale, prior]) => {
    if (prior) {
      await store.writeVariant(prior);
      if (publish && typeof store.publishVariant === 'function') {
        await store.publishVariant(locale, canonicalId).catch(() => {});
      }
      restored.push(locale);
    } else {
      await store.deleteVariant(locale, canonicalId);
      if (publish && typeof store.unpublishVariant === 'function') {
        await store.unpublishVariant(locale, canonicalId).catch(() => {});
      }
      deleted.push(locale);
    }
  }));
  return { restored, deleted };
}

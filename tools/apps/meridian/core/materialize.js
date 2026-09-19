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

import { LAYER_PRECEDENCE } from './schemas.js';

const INSERT_ORIGIN = 'insert';
const FORK_ORIGIN = 'fork';

/**
 * Compute a derived variant from canonical blocks plus a locale's adaptation
 * layer, applying entries in precedence order (PRD §3.3). Pure and
 * deterministic: same inputs always produce the same output, which is what the
 * "delete /live and recompute is byte-identical" invariant depends on. Inputs
 * are never mutated.
 * @param {import('./schemas.js').CanonicalContentObject} canonical
 * @param {import('./schemas.js').AdaptationLayer|null} layer
 * @param {string} [locale] - explicit locale; required when layer is null so the
 *   variant is never stamped with a non-locale value
 * @returns {import('./schemas.js').DerivedVariant}
 */
export function materialize(canonical, layer, locale) {
  // Seed from canonical, preserving canonical block order.
  const byId = new Map();
  const order = [];
  canonical.blocks.forEach((block) => {
    byId.set(block.id, {
      id: block.id,
      type: block.type,
      content: block.content,
      derivedFrom: block.hash,
    });
    order.push(block.id);
  });

  // Validate the layer type of every entry before sorting — an unknown type
  // would get indexOf === -1 and silently sort as most-junior rather than
  // fail. Entries can originate from external/agent-authored data, so this is
  // a real boundary check, not defensive noise.
  const rawEntries = layer ? layer.entries : [];
  rawEntries.forEach((entry) => {
    if (!LAYER_PRECEDENCE.includes(entry.layer)) {
      throw new Error(`Unknown adaptation layer "${entry.layer}" on block ${entry.blockId}`);
    }
  });

  // Stable sort entries low-to-high precedence: higher layers overwrite lower
  // ones on the same block. Array.prototype.sort is stable, so entries within
  // one layer keep their authored order.
  const entries = [...rawEntries].sort(
    (a, b) => LAYER_PRECEDENCE.indexOf(a.layer) - LAYER_PRECEDENCE.indexOf(b.layer),
  );

  entries.forEach((entry) => {
    const canonicalBlock = canonical.blocks.find((b) => b.id === entry.blockId);
    if (entry.operation === 'insert' && !canonicalBlock) {
      // A market-specific block with no canonical counterpart (e.g. a required
      // disclosure). Appended after canonical blocks, in entry order.
      if (!byId.has(entry.blockId)) order.push(entry.blockId);
      byId.set(entry.blockId, {
        id: entry.blockId,
        type: entry.layer,
        content: entry.value,
        derivedFrom: `${INSERT_ORIGIN}:${entry.blockId}`,
      });
      return;
    }
    if (entry.operation === 'fork') {
      // Structural fork escape hatch (PRD §12.3): the market takes full custody
      // of this block. Replace its content AND detach provenance so a later
      // canonical change never marks it stale — the variant keeps subscribing to
      // canonical on its *other* blocks. Only applies to an existing canonical
      // block; a fork with no counterpart is ignored (nothing to detach from).
      //
      // A fork is structural by definition. Forking under any other layer
      // (notably compliance) would exempt that block from the stale check while
      // still counting as "layer present" — silently blinding compliance-drift
      // detection (PRD §5). Reject that combination at the boundary, the same
      // way an unknown layer type throws above.
      if (entry.layer !== 'structural') {
        throw new Error(`Fork requires the structural layer, got "${entry.layer}" on block ${entry.blockId}`);
      }
      if (!canonicalBlock) return;
      byId.set(entry.blockId, {
        ...byId.get(entry.blockId),
        content: entry.value,
        derivedFrom: `${FORK_ORIGIN}:${entry.blockId}`,
      });
      return;
    }
    // translate / override (and insert onto an existing canonical block):
    // replace content, keep derivedFrom pointed at the canonical hash so
    // staleness stays detectable. An entry targeting a nonexistent canonical
    // block is ignored — the exposure engine reports that mismatch separately.
    if (!canonicalBlock) return;
    byId.set(entry.blockId, { ...byId.get(entry.blockId), content: entry.value });
  });

  return {
    locale: locale ?? layer?.locale ?? canonical.id,
    canonicalId: canonical.id,
    blocks: order.map((id) => byId.get(id)),
  };
}

/**
 * A derived block whose provenance is a structural fork has intentionally
 * detached from canonical (PRD §12.3), so staleness must never be reported for
 * it. Exposure uses this to exempt forked blocks from the stale check.
 * @param {string} [derivedFrom]
 * @returns {boolean}
 */
export function isForked(derivedFrom) {
  return typeof derivedFrom === 'string' && derivedFrom.startsWith(`${FORK_ORIGIN}:`);
}

/**
 * Canonical serialization of a derived variant for byte-comparison and for
 * writing to the /live artifact path. Stable and deterministic.
 * @param {import('./schemas.js').DerivedVariant} variant
 * @returns {string}
 */
export function serializeVariant(variant) {
  return `${JSON.stringify(variant, null, 2)}\n`;
}

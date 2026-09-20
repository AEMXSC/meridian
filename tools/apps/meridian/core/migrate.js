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

// EMA / MSM migration on-ramp (PRD §7.7, Phase 4): ingest an existing
// translate-then-rollout structure — one source/base document plus N per-market
// copies — into Meridian's model: ONE canonical object plus N typed adaptation
// sets, computed instead of hand-maintained. Pure and site-agnostic: it takes
// already-fetched block structures for any org/site, so the same transform works
// against every site in the org. Reuses the block classifier and content hashing.

import { hashBlockContent, stableStringify } from './hash.js';
import createClassifier from './classify.js';

function buildEntry(block, layer, operation) {
  const entry = {
    blockId: block.id,
    layer,
    operation,
    value: block.content,
    reason: 'Imported from an existing MSM market — differed from the source',
    provenance: 'migrate:msm',
    confidence: null,
    // Compliance stays human-owned even when imported (PRD §5/§11); a person
    // must own the legal copy going forward.
    status: layer === 'compliance' ? 'human-owned-nonnegotiable' : 'human-owned',
  };
  // Carry the real block type on an insert so the migrated market-only block
  // renders as its true component, not the layer name.
  if (operation === 'insert') entry.type = block.type;
  return entry;
}

function buildRemoval(blockId) {
  return {
    blockId,
    layer: 'structural',
    operation: 'remove',
    value: null,
    reason: 'Block dropped by this market in the source MSM structure',
    provenance: 'migrate:msm',
    confidence: null,
    status: 'human-owned',
  };
}

/**
 * Ingest a source doc + market copies into canonical + adaptation sets + policies.
 * A market block identical to the source is dropped (inherited from canonical);
 * a differing block becomes a typed adaptation entry (classified); a market-only
 * block becomes an insert (carrying its real type); a source block the market
 * omitted becomes a remove. The result recomputes back to each market's content
 * via materialize (verified by tests), so migration is lossless — with one
 * caveat: block *ordering* follows canonical (source) order plus appended
 * inserts, so a market that merely reordered otherwise-identical blocks is
 * normalized to source order.
 * @param {Object} input
 * @param {string} input.canonicalId - e.g. "canon/offers/spring-refresh"
 * @param {string} [input.title]
 * @param {{ blocks: {id:string,type:string,content:unknown}[] }} input.source
 * @param {{ locale:string, blocks: {id:string,type:string,content:unknown}[] }[]} input.markets
 * @param {Object} [opts]
 * @param {(block:object)=>{layer:string}} [opts.classifier] - defaults to the native heuristic
 * @param {string} [opts.now]
 * @returns {Promise<{canonical:object, layers:Map<string,object>, policies:object[]}>}
 */
export default async function ingestMsm(input, opts = {}) {
  const {
    canonicalId, title, source, markets,
  } = input;
  if (!canonicalId) throw new Error('ingest: canonicalId is required');
  if (!source || !Array.isArray(source.blocks)) throw new Error('ingest: source.blocks[] is required');
  if (!Array.isArray(markets)) throw new Error('ingest: markets[] is required');
  const classify = opts.classifier ?? createClassifier();

  const blocks = await Promise.all(source.blocks.map(async (b) => ({
    id: b.id,
    type: b.type,
    content: b.content,
    hash: await hashBlockContent(b.type, b.content),
  })));
  const canonical = {
    id: canonicalId,
    title: title ?? canonicalId,
    blocks,
    updated: opts.now ?? new Date().toISOString(),
  };

  const sourceById = new Map(source.blocks.map((b) => [b.id, b]));
  const layers = new Map();
  const policies = [];

  markets.forEach((market) => {
    const entries = [];
    const marketIds = new Set(market.blocks.map((b) => b.id));
    market.blocks.forEach((mb) => {
      const sb = sourceById.get(mb.id);
      if (!sb) {
        const { layer } = classify(mb);
        entries.push(buildEntry(mb, layer, 'insert'));
        return;
      }
      if (stableStringify(sb.content) !== stableStringify(mb.content)) {
        const { layer } = classify(mb);
        const operation = layer === 'language' ? 'translate' : 'override';
        entries.push(buildEntry(mb, layer, operation));
      }
      // identical → inherited from canonical, no entry authored
    });
    // A source block the market dropped becomes an explicit remove, so the
    // recompute reproduces the market exactly (no phantom canonical block).
    source.blocks.forEach((sb) => {
      if (!marketIds.has(sb.id)) entries.push(buildRemoval(sb.id));
    });
    layers.set(market.locale, { locale: market.locale, canonicalId, entries });
    policies.push({
      locale: market.locale,
      requiredLayers: [...new Set(entries.map((e) => e.layer))],
    });
  });

  return { canonical, layers, policies };
}

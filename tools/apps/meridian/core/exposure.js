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

import { materialize } from './materialize.js';
import { stableStringify } from './hash.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/**
 * @typedef {Object} MarketPolicy
 * @property {string} locale
 * @property {import('./schemas.js').LayerType[]} requiredLayers
 */

/**
 * Read-only diff of canonical against every market's current state (PRD §3.4,
 * Job 1). Writes nothing; returns the findings. Generalizes MSM's single
 * "behind source" signal (core/status.js) into the five typed finding kinds.
 * @param {Object} input
 * @param {import('./schemas.js').CanonicalContentObject} input.canonical
 * @param {MarketPolicy[]} input.policies
 * @param {Map<string, import('./schemas.js').AdaptationLayer>} input.layers
 * @param {Map<string, import('./schemas.js').DerivedVariant>} input.stored
 * @param {number} [input.confidenceThreshold]
 * @param {string} [input.now]
 * @returns {import('./schemas.js').ExposureFinding[]}
 */
export default function scanExposure(input) {
  const {
    canonical, policies, layers, stored,
  } = input;
  const threshold = input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const detectedAt = input.now ?? new Date().toISOString();
  const canonicalHash = new Map(canonical.blocks.map((b) => [b.id, b.hash]));
  const findings = [];

  policies.forEach((policy) => {
    const { locale } = policy;
    const layer = layers.get(locale) ?? null;

    // uncovered: a market exists in policy with no adaptation layer at all.
    if (!layer) {
      findings.push({
        locale,
        canonicalId: canonical.id,
        kind: 'uncovered',
        severity: 'warning',
        detail: `Market ${locale} has no adaptation layer for ${canonical.id}`,
        detectedAt,
      });
      return;
    }

    // missing-required: a required layer for this market has no entry.
    const presentLayers = new Set(layer.entries.map((e) => e.layer));
    policy.requiredLayers.forEach((required) => {
      if (!presentLayers.has(required)) {
        findings.push({
          locale,
          canonicalId: canonical.id,
          kind: 'missing-required',
          severity: required === 'compliance' ? 'critical' : 'warning',
          detail: `Required ${required} layer for ${locale} is absent`,
          detectedAt,
        });
      }
    });

    // low-confidence: an auto-applied block scored below threshold.
    layer.entries.forEach((entry) => {
      if (entry.status === 'auto-applied'
        && entry.confidence !== null
        && entry.confidence < threshold) {
        findings.push({
          locale,
          canonicalId: canonical.id,
          kind: 'low-confidence',
          severity: 'warning',
          detail: `Block ${entry.blockId} scored ${entry.confidence} below ${threshold}`,
          blockId: entry.blockId,
          detectedAt,
        });
      }
    });

    // stale / drift require a stored variant to compare against.
    const storedVariant = stored.get(locale);
    if (!storedVariant) return;

    // stale: a stored block was derived from an older canonical hash — it did
    // not recompute after canonical moved.
    const staleBlocks = storedVariant.blocks.filter((b) => {
      const currentHash = canonicalHash.get(b.id);
      return currentHash && b.derivedFrom !== currentHash;
    });
    staleBlocks.forEach((b) => {
      findings.push({
        locale,
        canonicalId: canonical.id,
        kind: 'stale',
        severity: 'critical',
        detail: `Block ${b.id} in ${locale} derived from an outdated canonical hash`,
        blockId: b.id,
        detectedAt,
      });
    });

    // drift: the stored variant diverges from what canonical + layers would
    // produce right now, even though it is not stale. Signals a hand-edited or
    // legacy copy. Skipped when stale, so the two kinds never double-report.
    // Compared structurally (stableStringify) so a DA JSON round-trip that
    // reorders keys is not mistaken for a content change.
    if (staleBlocks.length === 0) {
      const expected = stableStringify(materialize(canonical, layer));
      const actual = stableStringify(storedVariant);
      if (expected !== actual) {
        findings.push({
          locale,
          canonicalId: canonical.id,
          kind: 'drift',
          severity: 'warning',
          detail: `Stored variant for ${locale} diverges from canonical + layers`,
          detectedAt,
        });
      }
    }
  });

  return findings;
}

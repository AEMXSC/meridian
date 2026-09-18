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
import createScorer, { AUTO_APPLY_THRESHOLD } from './scoring.js';

/**
 * @typedef {'auto'|'review'|'blocked'} Gate
 * auto    — clean, safe to materialize to the edge
 * review  — a language block scored below threshold; route to the taste queue
 * blocked — a required compliance layer is absent; never publish (PRD §5/§6)
 */

// Decide the gate for one market's recompute. Scores only the language entries
// on blocks that actually changed ("only affected blocks"). Compliance is never
// scored — only checked present/absent.
function gate(layer, requiredLayers, changedBlockIds, scorer, threshold) {
  const present = new Set((layer?.entries ?? []).map((e) => e.layer));
  if (requiredLayers.includes('compliance') && !present.has('compliance')) {
    return { gate: 'blocked', reason: 'Required compliance layer is absent' };
  }
  const changed = new Set(changedBlockIds);
  const languageChanged = (layer?.entries ?? []).filter(
    (e) => e.layer === 'language' && changed.has(e.blockId),
  );
  const lowest = languageChanged.reduce(
    (min, e) => Math.min(min, scorer(e)),
    Number.POSITIVE_INFINITY,
  );
  if (lowest < threshold) {
    return { gate: 'review', reason: `Language block scored ${lowest} below ${threshold}` };
  }
  return { gate: 'auto', reason: null };
}

/**
 * Which markets must recompute when the given canonical blocks change. No
 * writes — a plan the human or policy approves must precede any apply (PRD §9).
 * @param {import('./schemas.js').CanonicalContentObject} canonical
 * @param {string[]} changedBlockIds
 * @param {import('./exposure.js').MarketPolicy[]} policies
 */
export function planPropagation(canonical, changedBlockIds, policies) {
  const canonicalBlockIds = new Set(canonical.blocks.map((b) => b.id));
  const changed = changedBlockIds.filter((id) => canonicalBlockIds.has(id));
  return {
    canonicalId: canonical.id,
    changedBlockIds: changed,
    // Every market derives from the canonical object, so a real block change
    // affects them all. Markets that fully fork a changed block are excluded in
    // Phase 3; for now nothing is forked.
    affectedLocales: changed.length ? policies.map((p) => p.locale) : [],
  };
}

/**
 * Execute an approved plan: recompute each affected variant, gate it, and
 * materialize only the clean ones to the store. Flagged/blocked variants go to
 * the taste queue instead of the edge. Captures a snapshot of prior /live state
 * for atomic rollback. This is the only routine write path (PRD §9).
 * @returns {Promise<object>} { propagationId, applied[], gated[], snapshot }
 */
export async function applyPropagation(store, canonical, plan, opts) {
  // Bind the approved plan to the object actually being applied (PRD §9) — a
  // stale plan against a refetched canonical must not silently apply.
  if (plan.canonicalId !== canonical.id) {
    throw new Error(`Plan/canonical mismatch: ${plan.canonicalId} vs ${canonical.id}`);
  }
  const {
    layers, policies, scorer = createScorer(), threshold = AUTO_APPLY_THRESHOLD, now,
  } = opts;
  const requiredByLocale = new Map(policies.map((p) => [p.locale, p.requiredLayers]));
  const detectedAt = now ?? new Date().toISOString();
  const propagationId = `${canonical.id}@${detectedAt}`;
  const applied = [];
  const gated = [];
  const failed = [];
  const snapshot = {};

  await Promise.all(plan.affectedLocales.map(async (locale) => {
    try {
      const layer = layers.get(locale) ?? null;
      // Pass locale explicitly so a market with no layer still produces a
      // variant stamped with its real locale, never the canonical id.
      const variant = materialize(canonical, layer, locale);
      const decision = gate(
        layer,
        requiredByLocale.get(locale) ?? [],
        plan.changedBlockIds,
        scorer,
        threshold,
      );
      // Snapshot before touching /live so rollback can restore (or delete) it.
      snapshot[locale] = (await store.readVariant(locale, canonical.id)) ?? null;

      if (decision.gate === 'auto') {
        await store.writeVariant(variant);
        applied.push({ locale, blocks: variant.blocks.length });
      } else {
        await store.writeQueueItem({
          propagationId,
          locale,
          canonicalId: canonical.id,
          gate: decision.gate,
          reason: decision.reason,
          variant,
          createdAt: detectedAt,
        });
        gated.push({ locale, gate: decision.gate, reason: decision.reason });
      }
    } catch (e) {
      // Isolate per-locale failures so one bad market cannot abort the batch
      // and strand already-written markets without a rollback snapshot.
      failed.push({ locale, error: e.message });
    }
  }));

  return {
    propagationId, applied, gated, failed, snapshot,
  };
}

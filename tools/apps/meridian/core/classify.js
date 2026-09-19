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

// The Adaptation Agent (PRD §12, Phase 3): given a block that differs between a
// market and canonical, suggest which typed layer the difference belongs to, so
// an author never starts from a blank field. Pluggable exactly like the scorer
// (core/scoring.js): the native default is a transparent keyword heuristic; a
// real LLM classifier swaps in behind the same signature without a rebuild.
//
// This only ever *suggests* a layer type for a human to confirm. It never
// authors content, and compliance is deliberately weighted toward a human's
// final call (PRD §11: no agent-authored commercial or compliance content).

// Signal words per layer, most specific first. Compliance and commercial are
// checked before creative/language because a legal or price change dressed up
// as prose must not be mislabelled as a mere wording tweak.
const SIGNALS = [
  ['compliance', ['legal', 'disclosure', 'disclaimer', 'compliance', 'gdpr', 'consent', 'terms', 'privacy', 'regulat']],
  ['commercial', ['price', 'pricing', 'offer', 'promo', 'discount', 'cta', 'plan', 'sku', 'currency', 'coupon']],
  ['creative', ['hero', 'image', 'media', 'banner', 'video', 'illustration', 'campaign', 'visual']],
];

const HIGH = 0.9;
const MEDIUM = 0.6;

function haystack(block) {
  const parts = [block?.id, block?.type];
  const { content } = block ?? {};
  if (typeof content === 'string') parts.push(content);
  else if (content && typeof content === 'object') parts.push(JSON.stringify(content));
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * Native heuristic classifier: match a block's id/type/content against known
 * layer signal words. Falls back to `language` for a plain text change (the
 * common localization case) and `creative` otherwise. Deterministic, so the
 * suggestion is testable and never surprises the author.
 * @param {import('./schemas.js').CanonicalBlock} block
 * @returns {{ layer: import('./schemas.js').LayerType, confidence: number, reason: string }}
 */
export function heuristicClassifier(block) {
  const text = haystack(block);
  const hit = SIGNALS.find(([, words]) => words.some((w) => text.includes(w)));
  if (hit) {
    const [layer, words] = hit;
    const matched = words.find((w) => text.includes(w));
    return {
      layer,
      confidence: HIGH,
      reason: `Matched ${layer} signal "${matched}"`,
    };
  }
  const isText = typeof block?.content === 'string';
  return isText
    ? { layer: 'language', confidence: MEDIUM, reason: 'Text change with no commercial/compliance signal — likely a translation' }
    : { layer: 'creative', confidence: MEDIUM, reason: 'Non-text change with no specific signal' };
}

/**
 * Wrap a classifier implementation. Defaults to the native heuristic.
 * @param {(block: import('./schemas.js').CanonicalBlock) => object} [impl]
 * @returns {(block: import('./schemas.js').CanonicalBlock) => object}
 */
export default function createClassifier(impl = heuristicClassifier) {
  return (block) => impl(block);
}

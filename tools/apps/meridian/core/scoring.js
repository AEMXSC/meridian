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

// Pluggable scoring (PRD §12.2): the posture is a config flag, not a rebuild.
// A scorer takes a language adaptation entry and returns a confidence in [0,1].
// The native default is a stub that trusts the agent's self-reported confidence;
// a real MQM/LLM scorer swaps in behind the same signature. Compliance is never
// scored (PRD §5) — callers skip non-language layers.

export const AUTO_APPLY_THRESHOLD = 0.85;

/**
 * Native stub scorer: passes through the entry's own confidence, defaulting to
 * a high value when absent. Deterministic, so gating is testable.
 * @param {import('./schemas.js').AdaptationEntry} entry
 * @returns {number} confidence in [0,1]
 */
export function nativeStubScorer(entry) {
  return entry.confidence ?? 0.95;
}

/**
 * Wrap a scoring implementation. Defaults to the native stub.
 * @param {(entry: import('./schemas.js').AdaptationEntry) => number} [impl]
 * @returns {(entry: import('./schemas.js').AdaptationEntry) => number}
 */
export default function createScorer(impl = nativeStubScorer) {
  return (entry) => impl(entry);
}

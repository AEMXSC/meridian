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

// The four Meridian objects (PRD §3), described as JSDoc typedefs. No build
// step: this is plain ES module data, consumed the same way in the browser
// (DA app) and in Node (tests).

/**
 * @typedef {'language'|'creative'|'commercial'|'compliance'|'structural'} LayerType
 * @typedef {'translate'|'override'|'insert'|'fork'|'remove'} LayerOperation
 * @typedef {'auto-applied'|'human-owned'|'human-owned-nonnegotiable'} LayerStatus
 * @typedef {'stale'|'missing-required'|'drift'|'low-confidence'|'uncovered'} FindingKind
 * @typedef {'critical'|'warning'|'info'} Severity
 */

/**
 * @typedef {Object} CanonicalBlock
 * @property {string} id
 * @property {string} type
 * @property {unknown} content
 * @property {string} hash
 */

/**
 * @typedef {Object} CanonicalContentObject
 * @property {string} id
 * @property {string} title
 * @property {CanonicalBlock[]} blocks
 * @property {string} updated
 * @property {string} [commit]
 */

/**
 * @typedef {Object} AdaptationEntry
 * @property {string} blockId
 * @property {LayerType} layer
 * @property {LayerOperation} operation
 * @property {unknown} value
 * @property {string} reason
 * @property {string} provenance
 * @property {number|null} confidence
 * @property {LayerStatus} status
 * @property {string} [type] - block type for an `insert` of a market-only block,
 *   so the derived block renders as its real component (not the layer name)
 * @property {string} [sourceHash] - the canonical block hash this entry was
 *   authored/translated against. When it differs from the current canonical
 *   hash, the localized value is of outdated source: exposure flags it and
 *   propagation routes it to review (needs re-doing). PRD §5 staleness.
 */

/**
 * @typedef {Object} AdaptationLayer
 * @property {string} locale
 * @property {string} canonicalId
 * @property {AdaptationEntry[]} entries
 */

/**
 * @typedef {Object} DerivedBlock
 * @property {string} id
 * @property {string} type
 * @property {unknown} content
 * @property {string} derivedFrom - canonical block hash this was computed against
 */

/**
 * @typedef {Object} DerivedVariant
 * @property {string} locale
 * @property {string} canonicalId
 * @property {DerivedBlock[]} blocks
 */

/**
 * @typedef {Object} ExposureFinding
 * @property {string} locale
 * @property {string} canonicalId
 * @property {FindingKind} kind
 * @property {Severity} severity
 * @property {string} detail
 * @property {string} [blockId]
 * @property {string} detectedAt
 */

// Precedence, lowest to highest (PRD §3.3). Compliance and structural sit
// highest so a market's legal and layout requirements can never be clobbered
// by a language or creative pass.
// eslint-disable-next-line import/prefer-default-export
export const LAYER_PRECEDENCE = ['language', 'creative', 'commercial', 'compliance', 'structural'];

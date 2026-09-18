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

// Block hashing runs at authoring/ingest time only. The runtime diff compares
// the stored hash strings, so materialize and exposure need no crypto. Uses
// the Web Crypto API, which is present in both the DA app (browser) and Node.

/**
 * Stable JSON: recursively sort object keys so semantically-equal content
 * hashes identically regardless of key order. A re-serialized-but-unchanged
 * block must not look like a change.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Content hash for a block. Hashes type + content together so a block that
 * keeps its content but changes semantic type still recomputes.
 * @param {string} type
 * @param {unknown} content
 * @returns {Promise<string>} lowercase hex sha-256
 */
export async function hashBlockContent(type, content) {
  const data = new TextEncoder().encode(stableStringify({ type, content }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

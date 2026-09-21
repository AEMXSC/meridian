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

// Pure helpers for DA multi-sheet JSON docs (config.json, .da/translate.json,
// etc.), kept free of DA/https imports so they are node-testable. The golden
// rule when writing a DA config is: re-read, change only your sheet, and
// preserve every sibling sheet plus the :names/:type/:version metadata — never
// blow away the whole document (the discipline aem-apps' config-console uses).

/**
 * Read a named sheet's rows from a DA doc, tolerant of single- or multi-sheet
 * shape and of a bare array. Returns [] when absent.
 * @param {object|Array|null} doc
 * @param {string} name
 * @returns {object[]}
 */
export function readSheet(doc, name) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (doc[':type'] === 'multi-sheet' || doc[name]) {
    return Array.isArray(doc[name]?.data) ? doc[name].data : [];
  }
  // single-sheet
  return Array.isArray(doc.data) ? doc.data : [];
}

function sheetBlock(rows) {
  return {
    total: rows.length, limit: rows.length, offset: 0, data: rows,
  };
}

/**
 * Return a NEW multi-sheet doc with one sheet's rows replaced, preserving all
 * other sheets and refreshing :names/:type/:version. Accepts a null/empty/
 * single-sheet existing doc and normalizes to multi-sheet. Never mutates input.
 * @param {object|null} doc - the existing config (from a fresh read)
 * @param {string} name
 * @param {object[]} rows
 * @returns {object}
 */
export function writeSheet(doc, name, rows) {
  const base = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
  const reserved = new Set([':type', ':names', ':version']);
  const next = {};
  // Copy existing sheet blocks (skip reserved meta and the sheet we're replacing).
  Object.keys(base).forEach((key) => {
    if (!reserved.has(key) && key !== name) next[key] = base[key];
  });
  next[name] = sheetBlock(rows);
  const names = Object.keys(next);
  next[':names'] = names;
  next[':type'] = 'multi-sheet';
  next[':version'] = base[':version'] ?? 3;
  return next;
}

/**
 * Upsert rows into a named sheet by a key field, preserving siblings. Existing
 * rows with a matching key are replaced; new keys are appended in order.
 * @param {object|null} doc
 * @param {string} name
 * @param {object[]} rows - rows to upsert
 * @param {string} keyField
 * @returns {object}
 */
export function upsertRows(doc, name, rows, keyField) {
  const existing = readSheet(doc, name);
  const byKey = new Map(existing.map((r) => [r[keyField], r]));
  rows.forEach((r) => byKey.set(r[keyField], { ...byKey.get(r[keyField]), ...r }));
  return writeSheet(doc, name, [...byKey.values()]);
}

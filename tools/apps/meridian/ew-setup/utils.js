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

// Pure config builders for Experience Workspace enablement, aligned with the
// adobe-rnd/ew-extensions `ew-setup` tool. EW = the DA canvas editor; a site is
// EW-enabled by an `editor.path` config row pointing pages at da.live/canvas,
// plus a sidekick editUrlPattern. Kept DA/https-free so they are node-testable.

const SIDEKICK_EDIT_URL = 'https://da.live/canvas#/{{org}}/{{site}}{{pathname}}';

// A single safe org/site segment: alnum start, then alnum/dot/dash/underscore.
// Rejects traversal (..), and the =, #, ?, / that would corrupt the config value
// or the admin URL.
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseOrgSite(raw) {
  const normalized = (raw || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  if (!SAFE_SEGMENT.test(parts[0]) || !SAFE_SEGMENT.test(parts[1])) return null;
  return { org: parts[0], site: parts[1] };
}

// Find the sheet that carries CONFIG rows (key/value columns). A DA org config is
// often multi-sheet with typed sibling sheets (permissions: path/groups/actions);
// we must never treat those as the config sheet, or we would corrupt them on the
// full-document POST. Prefer a sheet named config/data, else the first sheet whose
// rows actually have key/value columns. Returns { sheetKey: null, rows: [] } when
// there is no config sheet, so the caller adds one instead of polluting a sibling.
export function findEditorPathRows(json) {
  if (!json) return { sheetKey: null, rows: [] };
  if (Array.isArray(json.data)) return { sheetKey: null, rows: json.data };
  for (const key of ['config', 'data']) {
    if (Array.isArray(json[key]?.data)) return { sheetKey: key, rows: json[key].data };
  }
  for (const key of Object.keys(json)) {
    if (key.startsWith(':')) continue;
    const rows = json[key]?.data;
    if (Array.isArray(rows) && rows.some((r) => r && ('key' in r || 'value' in r))) {
      return { sheetKey: key, rows };
    }
  }
  return { sheetKey: null, rows: [] };
}

export function hasEditorPathForSite(rows, org, site) {
  if (!rows?.length) return false;
  const needle = `/${org}/${site}=`;
  return rows.some((r) => r?.key === 'editor.path'
    && typeof r.value === 'string' && r.value.includes(needle));
}

export function hasCorrectSidekickConfig(json) {
  return json?.editUrlPattern === SIDEKICK_EDIT_URL;
}

export function buildUpdatedSidekickConfig(existingJson) {
  if (!existingJson) return { project: 'Experience Workspace Project', editUrlPattern: SIDEKICK_EDIT_URL };
  return { ...existingJson, editUrlPattern: SIDEKICK_EDIT_URL };
}

// Add (or keep) the editor.path row that routes this site's pages into the DA
// canvas (Experience Workspace). Never mutates the input; preserves every sibling
// sheet AND every row (including rows it doesn't understand, so a full-document
// POST can't drop permissions). When a multi-sheet doc has no config sheet, it
// adds one rather than writing into a typed sibling.
export function buildUpdatedConfig(existingJson, org, site) {
  const newRow = { key: 'editor.path', value: `/${org}/${site}=https://da.live/canvas#` };
  if (!existingJson) return { data: [newRow] };
  const { sheetKey, rows } = findEditorPathRows(existingJson);
  if (hasEditorPathForSite(rows, org, site)) return existingJson;
  // Single-sheet { data: [...] } — append, keep existing rows.
  if (Array.isArray(existingJson.data) && !sheetKey) {
    return { ...existingJson, data: [...existingJson.data, newRow] };
  }
  // Multi-sheet with a real config sheet — append there, keep siblings + rows.
  if (sheetKey) {
    return { ...existingJson, [sheetKey]: { ...existingJson[sheetKey], data: [...rows, newRow] } };
  }
  // Multi-sheet with only typed sheets (e.g. permissions) — add a config sheet;
  // never touch the siblings.
  const names = Array.isArray(existingJson[':names'])
    ? [...new Set([...existingJson[':names'], 'config'])] : undefined;
  return {
    ...existingJson,
    ...(names ? { ':names': names } : {}),
    config: {
      total: 1, limit: 1, offset: 0, data: [newRow],
    },
  };
}

export { SIDEKICK_EDIT_URL };

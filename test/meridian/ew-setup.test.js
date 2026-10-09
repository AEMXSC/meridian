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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOrgSite, findEditorPathRows, hasEditorPathForSite,
  buildUpdatedConfig, hasCorrectSidekickConfig, buildUpdatedSidekickConfig, SIDEKICK_EDIT_URL,
} from '../../tools/apps/meridian/ew-setup/utils.js';

test('parseOrgSite accepts /org/site and rejects anything else', () => {
  assert.deepEqual(parseOrgSite('/aemxsc/citizens'), { org: 'aemxsc', site: 'citizens' });
  assert.deepEqual(parseOrgSite('aemxsc/citizens/'), { org: 'aemxsc', site: 'citizens' });
  assert.equal(parseOrgSite('aemxsc'), null);
  assert.equal(parseOrgSite('/a/b/c'), null);
  assert.equal(parseOrgSite(''), null);
});

test('buildUpdatedConfig creates the editor.path row from nothing', () => {
  const out = buildUpdatedConfig(null, 'aemxsc', 'citizens');
  assert.deepEqual(out, { data: [{ key: 'editor.path', value: '/aemxsc/citizens=https://da.live/canvas#' }] });
});

test('buildUpdatedConfig appends to an existing single-sheet doc, preserving rows', () => {
  const existing = { data: [{ key: 'other.setting', value: 'x' }] };
  const out = buildUpdatedConfig(existing, 'aemxsc', 'citizens');
  assert.equal(out.data.length, 2);
  assert.ok(out.data.some((r) => r.key === 'other.setting'));
  assert.ok(hasEditorPathForSite(out.data, 'aemxsc', 'citizens'));
  // input not mutated
  assert.equal(existing.data.length, 1);
});

test('buildUpdatedConfig is idempotent when the site is already enabled', () => {
  const existing = buildUpdatedConfig(null, 'aemxsc', 'citizens');
  const again = buildUpdatedConfig(existing, 'aemxsc', 'citizens');
  assert.equal(again, existing);
});

test('parseOrgSite rejects unsafe segments (traversal, =, #, ?)', () => {
  assert.equal(parseOrgSite('aemxsc/..'), null);
  assert.equal(parseOrgSite('org/site=evil'), null);
  assert.equal(parseOrgSite('org/site#x'), null);
  assert.equal(parseOrgSite('org/si?te'), null);
  assert.equal(parseOrgSite('.hidden/site'), null);
});

test('buildUpdatedConfig never writes into a typed sheet (adds a config sheet)', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['permissions'],
    permissions: { data: [{ path: '/**', groups: 'everyone', actions: 'read' }] },
  };
  const out = buildUpdatedConfig(existing, 'aemxsc', 'citizens');
  // permissions untouched (no editor.path row appended, no rows dropped)
  assert.deepEqual(out.permissions, existing.permissions);
  // a dedicated config sheet now holds the editor.path row
  assert.ok(hasEditorPathForSite(out.config.data, 'aemxsc', 'citizens'));
  assert.ok(out[':names'].includes('config') && out[':names'].includes('permissions'));
  // input not mutated
  assert.equal(existing[':names'].length, 1);
});

test('buildUpdatedConfig targets the config sheet, not permissions, when both exist', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['permissions', 'config'],
    permissions: { data: [{ path: '/**', groups: 'admins' }] },
    config: { data: [{ key: 'a', value: '1' }] },
  };
  const out = buildUpdatedConfig(existing, 'aemxsc', 'citizens');
  assert.deepEqual(out.permissions, existing.permissions);
  assert.ok(hasEditorPathForSite(out.config.data, 'aemxsc', 'citizens'));
  assert.ok(out.config.data.some((r) => r.key === 'a')); // original config row kept
});

test('buildUpdatedConfig preserves sibling sheets in a multi-sheet doc', () => {
  const existing = {
    ':type': 'multi-sheet',
    ':names': ['config', 'perms'],
    config: { data: [{ key: 'a', value: '1' }] },
    perms: { data: [{ email: 'x@y.com' }] },
  };
  const out = buildUpdatedConfig(existing, 'aemxsc', 'citizens');
  assert.deepEqual(out.perms, existing.perms);
  assert.ok(hasEditorPathForSite(out.config.data, 'aemxsc', 'citizens'));
});

test('findEditorPathRows handles bare array, single-sheet, and multi-sheet', () => {
  assert.deepEqual(findEditorPathRows(null), { sheetKey: null, rows: [] });
  assert.deepEqual(findEditorPathRows({ data: [{ key: 'a' }] }).rows, [{ key: 'a' }]);
  assert.equal(findEditorPathRows({ ':type': 'multi-sheet', config: { data: [{ key: 'a' }] } }).sheetKey, 'config');
});

test('sidekick config builder sets the canvas editUrlPattern and preserves siblings', () => {
  assert.equal(hasCorrectSidekickConfig(null), false);
  const fresh = buildUpdatedSidekickConfig(null);
  assert.equal(fresh.editUrlPattern, SIDEKICK_EDIT_URL);
  assert.ok(hasCorrectSidekickConfig(fresh));
  const merged = buildUpdatedSidekickConfig({ project: 'Keep me', other: 1 });
  assert.equal(merged.project, 'Keep me');
  assert.equal(merged.other, 1);
  assert.ok(hasCorrectSidekickConfig(merged));
});

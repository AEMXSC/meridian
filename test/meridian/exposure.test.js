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
import scanExposure from '../../tools/apps/meridian/core/exposure.js';
import { materialize } from '../../tools/apps/meridian/core/materialize.js';
import buildFixture from '../../tools/apps/meridian/seed/informatica.js';

const NOW = '2026-09-08T00:00:00Z';

function countByKind(findings) {
  return findings.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});
}

test('Phase 1 acceptance: the four planted exposures surface, and nothing else', async () => {
  const fixture = await buildFixture();
  const findings = scanExposure({ ...fixture, now: NOW });
  const counts = countByKind(findings);

  assert.equal(counts.stale, 1, 'one stale market (it_it)');
  assert.equal(counts['missing-required'], 3, 'three markets missing compliance');
  assert.equal(counts.drift, 4, 'four Spanish markets drift on the brand term');
  assert.equal(counts.uncovered, 1, 'one uncovered market (ja_jp)');
  assert.equal(counts['low-confidence'] ?? 0, 0, 'no low-confidence in the seed');
  assert.equal(findings.length, 9, 'exactly the planted findings, nothing else');
});

test('the exposure scan writes nothing (returns a plain array)', async () => {
  const fixture = await buildFixture();
  const canonicalBefore = JSON.stringify(fixture.canonical);
  const findings = scanExposure({ ...fixture, now: NOW });
  assert.ok(Array.isArray(findings));
  assert.equal(JSON.stringify(fixture.canonical), canonicalBefore, 'canonical untouched');
});

test('the clean baseline market produces no findings', async () => {
  const fixture = await buildFixture();
  const findings = scanExposure({ ...fixture, now: NOW });
  assert.equal(findings.filter((f) => f.locale === 'en_us').length, 0);
});

test('missing compliance is reported critical', async () => {
  const fixture = await buildFixture();
  const findings = scanExposure({ ...fixture, now: NOW });
  const compliance = findings.filter((f) => f.kind === 'missing-required');
  assert.ok(compliance.length > 0 && compliance.every((f) => f.severity === 'critical'));
});

test('a structurally forked block is not reported stale when canonical moves', () => {
  const canonical = {
    id: 'c',
    title: 't',
    updated: NOW,
    blocks: [
      {
        id: 'hero', type: 'hero', content: { h: 'v2' }, hash: 'hash-hero-v2',
      },
      {
        id: 'body', type: 'text', content: 'canonical body', hash: 'hash-body-v1',
      },
    ],
  };
  const layer = {
    locale: 'ja_jp',
    canonicalId: 'c',
    entries: [{
      blockId: 'hero',
      layer: 'structural',
      operation: 'fork',
      value: { h: 'bespoke JP hero' },
      reason: 'forked on purpose',
      provenance: 'human',
      confidence: null,
      status: 'human-owned',
    }],
  };
  // The stored variant is what materialize produces now: hero forked, body live.
  const stored = materialize(canonical, layer);
  const findings = scanExposure({
    canonical,
    policies: [{ locale: 'ja_jp', requiredLayers: [] }],
    layers: new Map([['ja_jp', layer]]),
    stored: new Map([['ja_jp', stored]]),
    now: NOW,
  });
  assert.equal(findings.filter((f) => f.kind === 'stale').length, 0, 'forked block never stale');
  assert.equal(findings.filter((f) => f.kind === 'drift').length, 0, 'and not drift either');
});

test('source-stale: a translation authored against an older canonical hash is flagged', () => {
  const canonical = {
    id: 'c',
    title: 't',
    updated: NOW,
    blocks: [{
      id: 'hero', type: 'hero', content: { h: 'v2' }, hash: 'hash-new',
    }],
  };
  const layer = {
    locale: 'de_de',
    canonicalId: 'c',
    entries: [{
      blockId: 'hero', layer: 'language', operation: 'translate', value: { h: 'alt' }, reason: 'r', provenance: 'agent', confidence: 0.95, status: 'auto-applied', sourceHash: 'hash-OLD',
    }],
  };
  const findings = scanExposure({
    canonical, policies: [{ locale: 'de_de', requiredLayers: [] }], layers: new Map([['de_de', layer]]), stored: new Map(), now: NOW,
  });
  const stale = findings.filter((f) => f.kind === 'stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].blockId, 'hero');
  assert.equal(stale[0].severity, 'warning', 'source-stale is a warning, not a hard critical');
});

test('source-stale on a compliance override is reported critical', () => {
  const canonical = {
    id: 'c',
    title: 't',
    updated: NOW,
    blocks: [{
      id: 'legal', type: 'compliance', content: { text: 'v2' }, hash: 'hash-new',
    }],
  };
  const layer = {
    locale: 'de_de',
    canonicalId: 'c',
    entries: [{
      blockId: 'legal', layer: 'compliance', operation: 'override', value: { text: 'DE' }, reason: 'r', provenance: 'human:legal', confidence: null, status: 'human-owned-nonnegotiable', sourceHash: 'hash-OLD',
    }],
  };
  const findings = scanExposure({
    canonical, policies: [{ locale: 'de_de', requiredLayers: ['compliance'] }], layers: new Map([['de_de', layer]]), stored: new Map(), now: NOW,
  });
  const stale = findings.find((f) => f.kind === 'stale' && f.blockId === 'legal');
  assert.ok(stale, 'compliance source-stale flagged');
  assert.equal(stale.severity, 'critical', 'outdated compliance is critical, not a warning');
});

test('source-stale does not double-report a block already stale in the stored variant', () => {
  const canonical = {
    id: 'c',
    title: 't',
    updated: NOW,
    blocks: [{
      id: 'hero', type: 'hero', content: {}, hash: 'new',
    }],
  };
  const layer = {
    locale: 'de_de',
    canonicalId: 'c',
    entries: [{
      blockId: 'hero', layer: 'language', operation: 'translate', value: {}, reason: 'r', provenance: 'a', confidence: 0.95, status: 'auto-applied', sourceHash: 'old',
    }],
  };
  const stored = new Map([['de_de', {
    locale: 'de_de',
    canonicalId: 'c',
    blocks: [{
      id: 'hero', type: 'hero', content: {}, derivedFrom: 'old',
    }],
  }]]);
  const findings = scanExposure({
    canonical, policies: [{ locale: 'de_de', requiredLayers: [] }], layers: new Map([['de_de', layer]]), stored, now: NOW,
  });
  const stale = findings.filter((f) => f.kind === 'stale');
  assert.equal(stale.length, 1, 'exactly one stale finding, not two');
  assert.equal(stale[0].severity, 'critical', 'the stored-variant stale wins');
});

test('low-confidence: an auto-applied block below threshold is flagged', () => {
  const canonical = {
    id: 'c', title: 't', updated: NOW, blocks: [],
  };
  const layer = {
    locale: 'es_mx',
    canonicalId: 'c',
    entries: [{
      blockId: 'hero',
      layer: 'language',
      operation: 'translate',
      value: {},
      reason: 'r',
      provenance: 'agent',
      confidence: 0.5,
      status: 'auto-applied',
    }],
  };
  const findings = scanExposure({
    canonical,
    policies: [{ locale: 'es_mx', requiredLayers: [] }],
    layers: new Map([['es_mx', layer]]),
    stored: new Map(),
    now: NOW,
  });
  assert.equal(findings.filter((f) => f.kind === 'low-confidence').length, 1);
});

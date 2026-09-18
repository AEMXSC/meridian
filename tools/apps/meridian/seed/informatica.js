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

// Informatica-shaped seed with the four planted exposures (PRD §10.2), so the
// Phase 1 exposure demo is verifiable on real content, not a wow trick.

import { hashBlockContent } from '../core/hash.js';
import { materialize } from '../core/materialize.js';

const CANONICAL_ID = 'canon/offers/spring-refresh';
const REQUIRE_COMPLIANCE = ['compliance'];

async function canonicalBlock(id, type, content) {
  return {
    id, type, content, hash: await hashBlockContent(type, content),
  };
}

async function buildCanonical() {
  const blocks = await Promise.all([
    canonicalBlock('hero', 'hero', { heading: 'Spring Refresh', cta: 'Learn more' }),
    canonicalBlock('price', 'commercial', { amount: '499 USD' }),
    canonicalBlock('legal', 'compliance', { text: 'Standard terms apply.' }),
  ]);
  return {
    id: CANONICAL_ID,
    title: 'Spring Refresh Offer',
    blocks,
    updated: '2026-09-08T00:00:00Z',
    commit: '9f2c',
  };
}

// A clean language + compliance layer. `brandTerm` lets the Spanish markets
// each render the hero differently (the planted drift). Compliance overrides
// the canonical legal block, so it tracks the canonical hash (not stale).
function cleanLayer(locale, brandTerm) {
  return {
    locale,
    canonicalId: CANONICAL_ID,
    entries: [
      {
        blockId: 'hero',
        layer: 'language',
        operation: 'translate',
        value: { heading: brandTerm, cta: 'Más información' },
        reason: `${locale} rendering of canonical hero`,
        provenance: 'agent',
        confidence: 0.94,
        status: 'auto-applied',
      },
      {
        blockId: 'legal',
        layer: 'compliance',
        operation: 'override',
        value: { text: `${locale} regulatory disclosure` },
        reason: 'Locally required disclosure',
        provenance: 'human:legal',
        confidence: null,
        status: 'human-owned-nonnegotiable',
      },
    ],
  };
}

// Language only — no compliance entry (feeds missing-required).
function noComplianceLayer(locale) {
  return {
    locale,
    canonicalId: CANONICAL_ID,
    entries: [{
      blockId: 'hero',
      layer: 'language',
      operation: 'translate',
      value: { heading: 'Spring Refresh', cta: 'Learn more' },
      reason: `${locale} rendering of canonical hero`,
      provenance: 'agent',
      confidence: 0.94,
      status: 'auto-applied',
    }],
  };
}

/**
 * Build the in-memory fixture: canonical, market policies, present adaptation
 * layers, and stored /live variants (some deliberately broken).
 * @returns {Promise<{canonical, policies, layers: Map, stored: Map}>}
 */
export default async function buildFixture() {
  const canonical = await buildCanonical();
  const layers = new Map();
  const stored = new Map();
  const policies = [];

  // Clean baseline — must produce zero findings.
  layers.set('en_us', cleanLayer('en_us', 'Spring Refresh'));
  stored.set('en_us', materialize(canonical, layers.get('en_us')));
  policies.push({ locale: 'en_us', requiredLayers: REQUIRE_COMPLIANCE });

  // Planted #1 — stale: it_it did not recompute after canonical moved.
  layers.set('it_it', cleanLayer('it_it', 'Rinnovo di Primavera'));
  const itVariant = materialize(canonical, layers.get('it_it'));
  stored.set('it_it', {
    ...itVariant,
    blocks: itVariant.blocks.map((b) => (b.id === 'hero'
      ? { ...b, derivedFrom: 'stale00old00hash' }
      : b)),
  });
  policies.push({ locale: 'it_it', requiredLayers: REQUIRE_COMPLIANCE });

  // Planted #2 — missing-required (compliance) absent in three markets.
  ['de_de', 'fr_fr', 'en_ae'].forEach((locale) => {
    layers.set(locale, noComplianceLayer(locale));
    policies.push({ locale, requiredLayers: REQUIRE_COMPLIANCE });
  });

  // Planted #3 — drift: a brand term rendered four ways across Spanish markets.
  // Each stored variant drifted to a different rendering; none matches the
  // canonical rendering the layer would produce.
  const spanishTerms = {
    es_mx: 'Renovación de la Primavera',
    es_es: 'Renovacion Primaveral',
    es_ar: 'Refresco de Primavera',
    es_cl: 'Renovar en Primavera',
  };
  Object.entries(spanishTerms).forEach(([locale, term]) => {
    layers.set(locale, cleanLayer(locale, 'Renovación de Primavera'));
    const clean = materialize(canonical, layers.get(locale));
    stored.set(locale, {
      ...clean,
      blocks: clean.blocks.map((b) => (b.id === 'hero'
        ? { ...b, content: { heading: term, cta: 'Más información' } }
        : b)),
    });
    policies.push({ locale, requiredLayers: REQUIRE_COMPLIANCE });
  });

  // Planted #4 — uncovered: ja_jp is in policy with no adaptation layer.
  policies.push({ locale: 'ja_jp', requiredLayers: REQUIRE_COMPLIANCE });

  return {
    canonical, policies, layers, stored,
  };
}

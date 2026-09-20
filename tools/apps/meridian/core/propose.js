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

// Locale Architect Agent (PRD §12, Phase 4 setup surface): turn a one-sentence
// intent into a proposed adaptation POLICY for a new market — the locale and the
// layers it requires — with a plain-language rationale. Pluggable exactly like
// the scorer (scoring.js) and classifier (classify.js); the native default is a
// transparent keyword heuristic. It only PROPOSES: a human reviews, edits, and
// activates. It never authors content, and it flags compliance as human-owned
// (PRD §11), never writing legal copy itself.

// Common market phrases → locale code. First match wins; order most-specific
// first so "canadian french" resolves before a bare "french".
const MARKET_LOCALES = [
  [['quebec', 'québec', 'canadian french', 'french canad'], 'fr_ca'],
  [['france', 'french'], 'fr_fr'],
  [['german', 'germany', 'deutschland'], 'de_de'],
  [['japan', 'japanese'], 'ja_jp'],
  [['mexic'], 'es_mx'],
  [['spain', 'spanish', 'castil'], 'es_es'],
  [['argentin'], 'es_ar'],
  [['chile', 'chilean'], 'es_cl'],
  [['ital'], 'it_it'],
  [['brazil', 'brazilian', 'portuguese'], 'pt_br'],
  [['uae', 'emirat', 'arabic', 'dubai'], 'ar_ae'],
  [['united kingdom', 'britain', 'british', 'england', 'uk english'], 'en_gb'],
  [['united states', 'american english', 'us english'], 'en_us'],
];

const LOCALE_CODE = /\b([a-z]{2}_[a-z]{2})\b/;

const HIGH = 0.9;
const MEDIUM = 0.6;
const LOW = 0.3;

function detectLocale(text) {
  const hit = MARKET_LOCALES.find(([phrases]) => phrases.some((p) => text.includes(p)));
  if (hit) return hit[1];
  const explicit = text.match(LOCALE_CODE);
  return explicit ? explicit[1] : null;
}

/**
 * Native heuristic architect: read the intent for a market and layer signals and
 * propose a policy. Deterministic and explainable — every decision lands in
 * `notes` so the reviewer sees why.
 * @param {string} intent - a natural-language sentence describing the market
 * @returns {{ locale: string|null, requiredLayers: string[], confidence: number, notes: string[] }}
 */
export function heuristicArchitect(intent) {
  const text = String(intent || '').toLowerCase();
  const locale = detectLocale(text);
  const required = new Set();
  const notes = [];

  // Language: the default for a new market unless the intent opts out.
  const optOutLanguage = /keep english|no translation|do not translate|english only/.test(text);
  if (!optOutLanguage) {
    required.add('language');
    notes.push('Language layer required — content will be translated for this market.');
  } else {
    notes.push('Language layer skipped — content stays in English per the intent.');
  }

  // Commercial: local pricing/offers imply an override; "keep/same/inherit"
  // pricing means the market rides canonical commercial content.
  if (/local pric|local offer|own price|different price|currency|local promo/.test(text)) {
    required.add('commercial');
    notes.push('Commercial layer required — market sets its own pricing/offers.');
  } else if (/keep .*pric|same pric|inherit pric|us pric|keep .*offer/.test(text)) {
    notes.push('Commercial inherited — pricing/offers ride canonical (no commercial layer).');
  }

  // Compliance: legal/disclosure signals. Always human-owned (PRD §5/§11).
  if (/legal|disclosure|disclaimer|complian|gdpr|consent|regulat|privacy/.test(text)) {
    required.add('compliance');
    notes.push('Compliance layer required (human-authored) — market is non-publishable until it is filled.');
  }

  // Creative: local campaign/imagery.
  if (/campaign|imagery|creative|local hero|local visual|local image/.test(text)) {
    required.add('creative');
    notes.push('Creative layer required — market runs its own campaign/imagery.');
  }

  // Structural: custom layout / forking a block.
  if (/custom layout|different layout|structural|fork/.test(text)) {
    required.add('structural');
    notes.push('Structural layer noted — market may fork specific blocks to fully custom.');
  }

  let confidence = LOW;
  if (locale && required.size > 1) confidence = HIGH;
  else if (locale) confidence = MEDIUM;
  if (!locale) notes.unshift('No market recognized — set the locale (e.g. "fr_ca") before activating.');

  return {
    locale,
    requiredLayers: [...required],
    confidence,
    notes,
  };
}

/**
 * Wrap an architect implementation. Defaults to the native heuristic.
 * @param {(intent: string) => object} [impl]
 * @returns {(intent: string) => object}
 */
export default function createArchitect(impl = heuristicArchitect) {
  return (intent) => impl(intent);
}

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

/*
 * Real-page localization pipeline: take a live Edge Delivery page, machine-
 * translate its language content, and hand back the localized page plus the
 * list of segments a human must sign off on.
 *
 * This is the whole-page analogue of the block engine's typed layers: MSM would
 * copy the English page verbatim; Meridian translates it AND tells you which
 * segments are commercial/compliance so those never ship on a machine's say-so
 * (PRD §11 — no agent-authored commercial/compliance content). It does not
 * *block* the demo, it flags: the localized page is produced, and the review
 * list drives the human sign-off (and the taste queue) for those segments.
 */

import { extractStrings, localizeHtml, coverage } from './eds-html.js';
import { gateDict } from './quality.js';

function toMap(m) {
  if (m instanceof Map) return new Map(m);
  return new Map(Object.entries(m || {}));
}

// Signals that a text segment is commercial (money/pricing) or compliance
// (legal/regulatory) — those layers are human-owned, not machine-authored.
const COMMERCIAL = /[$€£¥]|\bUSD\b|\bEUR\b|\bGBP\b|\bAPR\b|\bAPY\b|%|\bfees?\b|\brates?\b|\bprice/i;
const COMPLIANCE = /\bSWIFT\b|\bBIC\b|\bIBAN\b|\bFDIC\b|\bterms\b|disclosure|©|\bregulat|\blegal\b|member/i;

export function classifySegment(text) {
  if (COMPLIANCE.test(text)) return 'compliance';
  if (COMMERCIAL.test(text)) return 'commercial';
  return 'language';
}

// Build a localized page from source HTML.
//   translate: async (strings, { from, to }) => Map<source, translated>
// Only the LANGUAGE layer is machine-translated and published. Commercial and
// compliance segments are withheld from the published page entirely (left in the
// source language) and returned in `review` for a human to localize and sign off
// — the machine never authors that content, even as a suggestion (PRD §11).
// Machine translations are then QUALITY-GATED (MQM-lite): only segments that
// pass are published; segments that fail are HELD and added to `review` as
// low-confidence language (with the machine attempt as a suggestion + issues),
// so the fast Translate path never ships a bad translation unseen.
// Returns { html, dict (published pass dict), coverage, review }. `coverage` is
// honest: withheld commercial/compliance AND flagged language count as untranslated.
export async function localizePage(html, translate, {
  to, from = 'en', dnt = [], minScore,
} = {}) {
  if (!to) throw new Error('localizePage requires a target locale');
  const strings = extractStrings(html);
  const layerOf = new Map(strings.map((s) => [s, classifySegment(s)]));
  const languageStrings = strings.filter((s) => layerOf.get(s) === 'language');
  const translated = await translate(languageStrings, { from, to });
  const { pass, flagged } = gateDict(translated, { dnt, minScore });
  const localized = localizeHtml(html, pass);
  const review = [
    ...strings
      .filter((s) => layerOf.get(s) !== 'language')
      .map((source) => ({ source, layer: layerOf.get(source) })),
    ...flagged.map((f) => ({
      source: f.source, layer: 'language', suggested: f.target, score: f.score, issues: f.issues,
    })),
  ];
  // `dict` (the PUBLISHED language translations) is returned so a fuller Localize
  // flow can merge human overrides/fixes on top before publish.
  return {
    html: localized, dict: pass, coverage: coverage(html, pass), review,
  };
}

// Complete a localization: language translations plus human-authored overrides
// for the withheld commercial/compliance segments. Overrides are keyed by the
// source string; empty values are ignored (that segment stays in source
// language). Returns the fully localized HTML.
export function applyLocalization(html, languageDict, overrides = {}) {
  const merged = toMap(languageDict);
  toMap(overrides).forEach((value, source) => {
    if (value != null && String(value).trim() !== '') merged.set(source, value);
  });
  return localizeHtml(html, merged);
}

// True if any staged Localize draft holds a non-blank human override — used to
// warn before discarding unpublished, hand-authored sign-off work.
export function hasPendingOverrides(drafts) {
  return [...(drafts || [])].some((draft) => draft && draft.overrides
    && Object.values(draft.overrides).some((v) => v != null && String(v).trim() !== ''));
}

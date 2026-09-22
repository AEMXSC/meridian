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
// Returns { html, coverage, review }. `coverage` is honest: commercial/compliance
// segments count as untranslated until a human completes them.
export async function localizePage(html, translate, { to, from = 'en' } = {}) {
  if (!to) throw new Error('localizePage requires a target locale');
  const strings = extractStrings(html);
  const layerOf = new Map(strings.map((s) => [s, classifySegment(s)]));
  const languageStrings = strings.filter((s) => layerOf.get(s) === 'language');
  const dict = await translate(languageStrings, { from, to });
  const localized = localizeHtml(html, dict);
  const review = strings
    .filter((s) => layerOf.get(s) !== 'language')
    .map((source) => ({ source, layer: layerOf.get(source) }));
  return { html: localized, coverage: coverage(html, dict), review };
}

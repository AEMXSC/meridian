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
 * MQM-lite translation quality scoring — a real gate for machine output, no ML
 * dependency. Every serious TMS scores quality (MQM/LQA); ours computes it from
 * signals that survive in the string itself — untranslated leakage, length
 * anomalies, dropped numbers/codes, altered do-not-translate terms — and turns
 * that into an accept/hold decision. Segments that fail are HELD for human
 * verification rather than auto-published, so the Translate fast-path never
 * ships a bad translation unseen. Pure + deterministic → fully tested.
 *
 * Score is 1.0 (clean) down to 0.0 (unusable); `ok` = score >= minScore.
 */

export const MIN_SCORE = 0.6;

export function scoreSegment(source, target, opts = {}) {
  const s = String(source ?? '').trim();
  const t = String(target ?? '').trim();
  const issues = [];

  if (!t) {
    return { score: 0, ok: false, issues: [{ dimension: 'accuracy', detail: 'empty translation' }] };
  }

  let penalty = 0;

  // Untranslated: identical to source for a non-trivial (3+ word) segment.
  if (t === s && s.split(/\s+/).length >= 3) {
    penalty += 0.5;
    issues.push({ dimension: 'accuracy', detail: 'appears untranslated (identical to source)' });
  }

  // Length ratio — a rough omission/over-expansion (fluency) signal. Very short
  // microcopy (buttons/labels) legitimately expands several-fold, so only apply
  // the ratio check to longer segments. Graduated: a severe mismatch (near-empty
  // or runaway output) is a strong signal; a mild over/under-run is minor, so a
  // legitimately-expanding language (German/Finnish) isn't held for it alone.
  const ratio = t.length / (s.length || 1);
  if (s.length >= 20) {
    if (ratio < 0.25 || ratio > 4) {
      penalty += 0.5;
      issues.push({ dimension: 'fluency', detail: `severe length ratio ${ratio.toFixed(2)}` });
    } else if (ratio < 0.4 || ratio > 2.5) {
      penalty += 0.25;
      issues.push({ dimension: 'fluency', detail: `length ratio ${ratio.toFixed(2)} out of range` });
    }
  }

  // Number integrity — every number in the source must survive in the target.
  // Compare digit sequences with locale punctuation (`.`, `,`, spaces) stripped
  // so reformatting (US "1,234.56" -> DE "1.234,56") passes; only a genuinely
  // missing digit-run is flagged.
  const stripSep = (n) => n.replace(/[.,\s]/g, '');
  const tDigits = stripSep(t);
  const missingNums = (s.match(/\d[\d.,]*/g) || []).filter((n) => !tDigits.includes(stripSep(n)));
  if (missingNums.length) {
    penalty += 0.5;
    issues.push({ dimension: 'accuracy', detail: `dropped number(s): ${missingNums.join(', ')}` });
  }

  // Code integrity — SWIFT/BIC and product codes (uppercase alphanumerics that
  // contain at least one digit) must survive. Pure-alpha all-caps marketing
  // words (FREE/SAVE/SHOP) are not codes and are ignored.
  const missingCodes = (s.match(/\b[A-Z0-9]{4,}\b/g) || [])
    .filter((c) => /\d/.test(c))
    .filter((c) => !t.includes(c));
  if (missingCodes.length) {
    penalty += 0.3;
    issues.push({ dimension: 'terminology', detail: `dropped code(s): ${missingCodes.join(', ')}` });
  }

  // Do-not-translate adherence — configured brand/legal terms kept verbatim.
  const droppedDnt = (opts.dnt || [])
    .filter((term) => term && s.includes(term) && !t.includes(term));
  if (droppedDnt.length) {
    penalty += 0.5;
    issues.push({ dimension: 'terminology', detail: `do-not-translate term altered: ${droppedDnt.join(', ')}` });
  }

  const score = Math.max(0, Number((1 - penalty).toFixed(2)));
  return { score, ok: score >= (opts.minScore ?? MIN_SCORE), issues };
}

// Split a source->target dict into publishable (`pass`) and held-for-review
// (`flagged`, with score + issues) by scoring each segment.
export function gateDict(dict, opts = {}) {
  const list = dict instanceof Map ? [...dict.entries()] : Object.entries(dict || {});
  const pass = new Map();
  const flagged = [];
  list.forEach(([source, target]) => {
    const { score, ok, issues } = scoreSegment(source, target, opts);
    if (ok) pass.set(source, target);
    else {
      flagged.push({
        source, target, score, issues,
      });
    }
  });
  return { pass, flagged };
}

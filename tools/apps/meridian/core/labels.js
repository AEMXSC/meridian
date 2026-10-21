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

// The product's status vocabulary in one place, so the app and the editor plugin
// say the same thing. It follows what customers already know: Adobe's DA
// localization tool says "Locales", "Publish" and "Not published"; AEM and the TMS
// tools flag a changed source on its own ("Source changed").
//
// Three questions are kept SEPARATE, because mixing them is what confuses people:
//   - where is the page?        -> publish state (Not localized / In review / Published)
//   - is it current?            -> freshness     (Up to date / Source changed)
//   - how far along is the work -> progress      (Translated 82%, held segments resolved)
// Pure + node-testable: no DA/https imports.

/** Publish state of a localized page, by stage. */
export const STAGE_LABEL = { live: 'Published', staged: 'In review', none: 'Not localized' };

/** Freshness against the source (internal tokens stay current/stale/missing). */
export const RISK_LABEL = {
  current: 'Up to date', stale: 'Source changed', missing: 'Not localized',
};
export const RISK_TIP = {
  current: 'Localized page is up to date with the source.',
  stale: 'Source changed after this locale was localized — re-localize to refresh.',
  missing: 'This locale has no localized page yet.',
};

/**
 * One coverage cell, along both axes. `label`/`cls` name the PUBLISH state; `changed`
 * is the separate freshness flag (the caller renders a "Source changed" chip).
 * @param {{stage: string, fresh: string}} c - stage live|staged|none, fresh stale|current|missing
 * @param {string} [when] - a preformatted " (date)" suffix for the tooltip
 */
export function describeCell(c, when = '') {
  if (c.stage === 'none') {
    return {
      label: '—', cls: 'missing', changed: false, tip: STAGE_LABEL.none,
    };
  }
  const changed = c.fresh === 'stale';
  const note = changed ? ' The source changed after this was localized — re-localize to refresh.' : '';
  if (c.stage === 'staged') {
    return {
      label: STAGE_LABEL.staged,
      cls: 'staged',
      changed,
      tip: `In review in the sandbox — awaiting publish${when}.${note}`,
    };
  }
  return {
    label: STAGE_LABEL.live, cls: 'current', changed, tip: `${STAGE_LABEL.live}${when}.${note}`,
  };
}

/**
 * The status line for a page result in the Pages canvas: publish state for a
 * staged/live page, otherwise translation progress. "Held" segments are the ones
 * withheld for a person (market copy and low-confidence translations); the count
 * is how many of them a person has EDITED — not how many are "resolved", since a
 * held segment can be accepted as-is and published without being edited.
 */
export function resultBadge(r) {
  // A staged page that has since been published is simply Published.
  if (r.promoted || r.kind === 'live') return STAGE_LABEL.live;
  if (r.kind === 'staged') return 'In review — publish when ready';
  const pct = Math.round((r.coverage?.ratio ?? 0) * 100);
  const mem = r.memory ? ` · ${r.memory}% from memory` : '';
  if (r.kind === 'localize') {
    return `Translated ${pct}% · ${r.heldDone} of ${r.heldTotal} held segments edited${mem}`;
  }
  return `Translated ${pct}%${mem}`;
}

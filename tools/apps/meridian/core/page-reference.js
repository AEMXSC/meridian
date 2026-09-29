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

// Pure "where does this page live in every market" model for the editor plugin's
// reference/status panel. Merges the three things Meridian already knows about a
// page — the configured markets (catalog), the pages Meridian has materialized
// (managed manifest), and the source-vs-localized freshness (risk) — into one
// per-locale row list an author can scan without leaving the editor. No network
// here, so the merge/decision is unit-testable; the store gathers the inputs.

// One market's relationship to the current source page:
//   live    — published to its clean locale root (managed mode 'locale-root')
//   staged  — materialized in the sandbox, awaiting review (managed mode 'sandbox')
//   missing — configured market with no Meridian copy yet
// `stale` decorates a live/staged row whose source has changed since (update due).
const STATUS_FOR_MODE = { 'locale-root': 'live', sandbox: 'staged' };

export function buildPageReference({
  ref,
  locales = [],
  sourceLocale = 'en',
  managed = [],
  risk = {},
} = {}) {
  const byLocale = new Map();
  (Array.isArray(managed) ? managed : []).forEach((entry) => {
    if (!entry || entry.ref !== ref || !entry.locale) return;
    // Last write wins if a locale somehow appears twice — a page has one state
    // per market, and the manifest records the most recent.
    byLocale.set(entry.locale, entry);
  });

  // Every configured target market, plus any market Meridian has a copy for even
  // if it is not (or no longer) in the catalog — never the source language.
  const configured = (Array.isArray(locales) ? locales : []).filter(Boolean);
  const all = [...new Set([...configured, ...byLocale.keys()])]
    .filter((locale) => locale && locale !== sourceLocale)
    .sort((a, b) => a.localeCompare(b));

  const rows = all.map((locale) => {
    const entry = byLocale.get(locale);
    const status = entry ? (STATUS_FOR_MODE[entry.mode] || 'staged') : 'missing';
    return {
      locale,
      status,
      stale: status !== 'missing' && risk[locale] === 'stale',
      mode: entry ? entry.mode : null,
      // The localized ref this market published under — a translated slug when
      // slug translation is on, otherwise the source ref. Callers build the
      // localized URL from this.
      slug: (entry && entry.slug) || ref,
      at: entry ? entry.at ?? null : null,
    };
  });

  const summary = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    if (row.stale) acc.stale = (acc.stale ?? 0) + 1;
    return acc;
  }, {});

  return { ref, rows, summary };
}

export default buildPageReference;

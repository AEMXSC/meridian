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

// Read DA's native localization config (/.da/translate-v2.json) so Meridian's
// target markets come from the SAME sheet the official DA localization app
// (da.live/apps/loc, adobe-rnd/da-locale-tools) reads — a site already set up
// for DA localization drops into Meridian with no reconfiguration, and Meridian
// layers MT + quality gating + exposure on top.
//
// The DA schema (from da-locale-tools tools/locales/index.js):
//   `languages` sheet: { name, location, site? } — the base languages. A
//     language's folder token is its `location` ("/de" → "de"); the root
//     language (empty location, i.e. the English source) is not a target.
//   `locales`   sheet: { name, location, site? } — regional GROUPS. Each group
//     combines with every language to a region-suffixed variant, exactly as DA
//     derives it: variantLocation = `${lang.location}-${region}` ("/de" + "ca"
//     → "de-ca"). One group therefore contains one variant per language.
//
// Pure + node-testable: no DA/https imports. Cross-site `site` overrides are
// captured by DA but intentionally ignored here — Meridian scopes every write
// to the current site's /meridian tree (single-site by design).

import { readSheet } from './da-config.js';

// A locale token Meridian can safely use as a path segment (letters, digits,
// underscore, hyphen) — matches store.js's SAFE_SEGMENT so anything the catalog
// offers is a legal /meridian/live/{locale} folder.
const SAFE = /^[a-zA-Z0-9_-]+$/;

/** A DA `location` ("/de", "/es/mx") → a Meridian locale token ("de", "es-mx"). */
export function localeCode(location) {
  return String(location ?? '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '-');
}

// Compose a language token with a region token the way DA does: "de" + "ca" →
// "de-ca"; either side empty falls back to the other (a root-language regional
// variant is just the region, e.g. English-Canada → "ca").
function combine(base, region) {
  if (base && region) return `${base}-${region}`;
  return base || region;
}

// A DA `site` cell → a safe repo name, or undefined (meaning "the base site").
// DA allows a leading slash; repo names are single safe segments.
function siteOf(raw) {
  const s = String(raw ?? '').replace(/^\/+/, '').trim();
  return s && SAFE.test(s) ? s : undefined;
}

/**
 * Normalize /.da/translate-v2.json into Meridian's locale catalog.
 * @param {object|Array|null} doc - the parsed translate-v2.json (or null)
 * @returns {{languages: object[], groups: object[], all: string[], siteByCode: object}} catalog
 */
export function parseLocaleConfig(doc) {
  // readSheet guarantees an array but not that its elements are objects; a
  // manually-edited or partially-cleared sheet can carry a null/scalar row.
  // Drop those up front so the parser upholds its "never throws" contract.
  const isObj = (row) => row && typeof row === 'object';
  const langRows = readSheet(doc, 'languages').filter(isObj);
  const localeRows = readSheet(doc, 'locales').filter(isObj);

  const languages = langRows
    .map((row) => {
      const site = siteOf(row.site);
      return {
        code: localeCode(row.location),
        name: String(row.name ?? '').trim(),
        ...(site ? { site } : {}),
      };
    })
    // Drop the root/source language (empty token) and any unsafe token.
    .filter((lang) => lang.code && SAFE.test(lang.code));

  const groups = localeRows
    .map((row) => {
      const region = localeCode(row.location);
      // A group (region) can target its own repo; that overrides a per-language
      // site, matching DA's loc app (it keys a locale variant's site off the
      // locale/region row).
      const groupSite = siteOf(row.site);
      const locales = langRows
        .map((lang) => {
          const site = groupSite ?? siteOf(lang.site);
          return {
            code: combine(localeCode(lang.location), region),
            name: String(lang.name ?? '').trim(),
            ...(site ? { site } : {}),
          };
        })
        .filter((loc) => loc.code && SAFE.test(loc.code));
      return { name: String(row.name ?? '').trim() || region, region, locales };
    })
    .filter((group) => group.locales.length);

  const all = [...new Set([
    ...languages.map((lang) => lang.code),
    ...groups.flatMap((group) => group.locales.map((loc) => loc.code)),
  ])];

  // A quick locale-token -> target repo lookup for callers that publish per
  // market into a different site. Only codes with an explicit site appear; all
  // others default to the base site at the call site.
  const siteByCode = {};
  languages.forEach((lang) => { if (lang.site) siteByCode[lang.code] = lang.site; });
  groups.forEach((group) => group.locales.forEach((loc) => {
    if (loc.site && !siteByCode[loc.code]) siteByCode[loc.code] = loc.site;
  }));

  return {
    languages, groups, all, siteByCode,
  };
}

// The EDS localization convention: a localized page lives under a /{locale}/
// folder whose token is a 2-letter language, optionally with a 2–4 char region
// ("pt", "es-mx", "zh-hans"). Used only as a fallback when the site declares no
// markets (empty catalog), so a localized page isn't mistaken for the source.
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2,4})?$/i;

/**
 * Split a page ref into an optional leading locale folder and the canonical tail.
 * "pt/international-banking" -> { locale: 'pt', tail: 'international-banking' }.
 *
 * Detection prefers the authoritative list: when `knownLocales` is non-empty, a
 * head segment is a locale IFF it's in that list. A PARTIAL catalog therefore
 * gets NO convention fallback — an undeclared `pt/` under a site that declares
 * only `es`/`fr` is intentionally treated as a source path, since a declared-
 * market site is assumed to list all its markets (avoids false positives there).
 *
 * Only when the list is EMPTY (a site that declares no markets at all — e.g. no
 * /.da/translate-v2.json) do we fall back to the EDS /{locale}/ folder shape.
 * That fallback is a heuristic: it will also match a 2-letter top-level English
 * section (`eu/pricing` -> locale `eu`). Accepted limitation — an empty-catalog
 * site gives us no authoritative signal to distinguish the two, and the earlier
 * behavior (mislabeling every localized page as the source) was strictly worse.
 *
 * Single-segment refs never carry a locale.
 * @param {string} ref - the page ref (no leading slash)
 * @param {string[]} [knownLocales] - authoritative locale tokens, when available
 * @returns {{locale: string|null, tail: string}}
 */
export function splitLocalePrefix(ref, knownLocales = []) {
  const segs = String(ref ?? '').split('/');
  if (segs.length < 2) return { locale: null, tail: ref ?? '' };
  const [head, ...rest] = segs;
  const isLocale = knownLocales.length
    ? knownLocales.includes(head)
    : LOCALE_SEGMENT.test(head);
  return isLocale ? { locale: head, tail: rest.join('/') } : { locale: null, tail: ref };
}

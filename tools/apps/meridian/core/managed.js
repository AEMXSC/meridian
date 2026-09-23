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

// Where a materialized localized page is published, and how Meridian proves it
// owns that page. Two publish modes:
//   - 'sandbox'     -> /meridian/live/{locale}/{ref}  (namespaced artifact; the
//                      safe default — never collides with the host site's tree)
//   - 'locale-root' -> /{locale}/{ref}                (clean, SEO-correct URL,
//                      e.g. /fr/international-banking — production)
// Canonical + adaptation layers always stay internal under /meridian; only the
// rendered page moves. Pure + node-testable (no DA/https imports).

// A self-describing marker embedded in every Meridian-written page. It lets the
// collision guard (locale-root only) tell a Meridian-managed page apart from a
// hand-authored one so we never silently overwrite the site's own content.
export const MANAGED_MARK = '<!-- meridian:managed -->';

export function isManaged(html) {
  return typeof html === 'string' && html.includes(MANAGED_MARK);
}

export function markManaged(html) {
  if (typeof html !== 'string' || html.includes(MANAGED_MARK)) return html;
  return `${MANAGED_MARK}\n${html}`;
}

// In locale-root mode, refuse to overwrite a target that already exists and is
// NOT a Meridian page (no marker). Absent target (null) → writable. Sandbox mode
// is namespaced, so it is always writable.
export function overwriteBlocked(existing, mode) {
  return mode === 'locale-root' && existing != null && !isManaged(existing);
}

// The site-relative published path (no extension) for a materialized MARKET
// page: /{locale}/{ref} in locale-root mode, or under the /meridian/live sandbox
// otherwise. Caller has already validated locale + ref. This never returns the
// bare source path (/{ref}) — the source page is not a market and is never
// written by Meridian (the store refuses locale === sourceLocale).
export function publishRelPath(mode, locale, ref, base = '/meridian') {
  return mode === 'locale-root' ? `/${locale}/${ref}` : `${base}/live/${locale}/${ref}`;
}

// Build the hreflang cluster index from manifest entries. Only locale-root
// entries get reciprocal alternates (sandbox URLs are not canonical). Shape:
//   { [sourceRef]: { en: '/ref', 'x-default': '/ref', fr: '/fr/ref', ... } }
// The runtime snippet reads this to inject <link rel="alternate" hreflang> on
// both the source page and every localized page.
export function buildHreflangIndex(entries, sourceLocale = 'en') {
  const clusters = {};
  (entries || [])
    .filter((e) => e && e.mode === 'locale-root' && e.ref && e.locale && e.locale !== sourceLocale)
    .forEach((e) => {
      if (!clusters[e.ref]) {
        clusters[e.ref] = { [sourceLocale]: `/${e.ref}`, 'x-default': `/${e.ref}` };
      }
      clusters[e.ref][e.locale] = `/${e.locale}/${e.ref}`;
    });
  return clusters;
}

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

// Slug (page-name) translation for SEO-correct localized URLs: /es/financiacion
// instead of /es/financing. Pure + node-testable — the store/app supply the
// machine translation; this module only shapes text into a safe path segment.
//
// DA/EDS refs are one or more segments of [A-Za-z0-9_-] (see store.js
// SAFE_SEGMENT), so a slug MUST be ASCII: accents are folded, everything else
// becomes a hyphen. A translated name that folds to nothing falls back to the
// original segment, so a bad translation can never produce an empty or unsafe ref.

// "Mercados de Capitales" -> "mercados-de-capitales"
export function slugify(text) {
  if (typeof text !== 'string') return '';
  // NFKD splits accented letters into base + combining mark; drop the marks.
  const ascii = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A ref segment -> human words to send to the translator: "capital-markets" ->
// "capital markets".
export function humanizeSlug(segment) {
  return String(segment == null ? '' : segment).replace(/[-_]+/g, ' ').trim();
}

// Replace the LAST segment of a ref with a translated, slugified name, keeping
// any parent path. "corporate/capital-markets" + "Mercados de Capitales" ->
// "corporate/mercados-de-capitales". Empty/garbage translation keeps the
// original last segment so the result is always a valid ref.
export function localizeRef(ref, translatedName) {
  const clean = String(ref == null ? '' : ref).replace(/^\/+|\/+$/g, '');
  if (!clean) return clean;
  const parts = clean.split('/');
  const last = parts[parts.length - 1] || '';
  parts[parts.length - 1] = slugify(translatedName) || last;
  return parts.join('/');
}

// The localized ref to publish under, de-duplicated against slugs already taken
// by OTHER source pages in the same locale, so two source pages that translate
// to the same word can't clobber each other's published page. On collision the
// last segment gets a deterministic -2, -3, … suffix.
export function chooseSlug(source, translatedName, takenSlugs = new Set()) {
  const base = localizeRef(source, translatedName);
  if (!base || !takenSlugs.has(base)) return base;
  const parts = base.split('/');
  const last = parts[parts.length - 1];
  for (let i = 2; i < 1000; i += 1) {
    parts[parts.length - 1] = `${last}-${i}`;
    const candidate = parts.join('/');
    if (!takenSlugs.has(candidate)) return candidate;
  }
  return base;
}

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
 * Edge Delivery HTML <-> translatable-string bridge.
 *
 * This is what lets Meridian operate on REAL EDS pages (block-table HTML in the
 * DA source bus) instead of a synthetic model, and beat MSM's whole-page copy:
 * MSM copies the English page verbatim to each locale and leaves you to
 * translate by hand; Meridian extracts every visible text segment, lets typed
 * layers (language / commercial / compliance) rewrite them, and re-emits the
 * page with EVERY tag, attribute, image and block class preserved byte-for-byte.
 *
 * Pure string scanner — no DOM dependency, so it runs identically in the DA app
 * (browser) and under `node --test`. EDS source HTML is clean, well-formed block
 * markup (no inline <script>/<style>, no `<` inside text), which is exactly the
 * shape this scanner assumes.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

// Decode the handful of entities EDS text carries, so the translation unit (and
// dict key) is plain text — never a mix of literal and encoded characters.
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X')
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const key = e.toLowerCase();
    return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : m;
  });
}

// Escape a replacement value before it is spliced back into the page. Machine
// translations can contain &, <, > (or provider quirks / echoed markup); without
// this, output could corrupt page structure or inject markup on a LIVE URL.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

function transformSegment(seg, onText) {
  const raw = seg.trim();
  if (!raw) return seg;
  const key = decodeEntities(raw);
  const next = onText(key);
  // Unchanged (identity / no translation) → keep the original bytes verbatim so
  // an untranslated page round-trips exactly, entities and all.
  if (next == null || next === key) return seg;
  const lead = seg.match(/^\s*/)[0];
  const tail = seg.match(/\s*$/)[0];
  return lead + escapeHtml(next) + tail;
}

// A comment or raw-text element (<script>/<style>) starting at `lt`; returns the
// index just past its terminator so it can be copied through opaquely. -1 if the
// tag at `lt` is an ordinary element.
function opaqueSpanEnd(html, lt) {
  if (html.startsWith('<!--', lt)) {
    const end = html.indexOf('-->', lt + 4);
    return end === -1 ? html.length : end + 3;
  }
  const raw = /^<(script|style)\b/i.exec(html.slice(lt, lt + 8));
  if (raw) {
    const close = new RegExp(`</${raw[1]}\\s*>`, 'i').exec(html.slice(lt));
    return close ? lt + close.index + close[0].length : html.length;
  }
  return -1;
}

// Walk `html`, calling `onText(decodedText)` for every non-whitespace text
// segment between tags, and rebuild the string from the (possibly rewritten)
// segments. Tags — and comments / script / style spans — are copied through
// verbatim; leading/trailing whitespace of each text segment is preserved so an
// identity `onText` round-trips the input exactly.
export function scanText(html, onText) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += transformSegment(html.slice(i), onText);
      break;
    }
    if (lt > i) out += transformSegment(html.slice(i, lt), onText);
    const opaque = opaqueSpanEnd(html, lt);
    if (opaque !== -1) {
      out += html.slice(lt, opaque);
      i = opaque;
    } else {
      const gt = html.indexOf('>', lt);
      if (gt === -1) {
        out += html.slice(lt);
        break;
      }
      out += html.slice(lt, gt + 1);
      i = gt + 1;
    }
  }
  return out;
}

// Every translatable text segment in document order, de-duplicated (a repeated
// string is one translation unit). This is the source-language string table a
// language layer is authored against.
export function extractStrings(html) {
  const seen = new Set();
  const strings = [];
  scanText(html, (core) => {
    if (!seen.has(core)) {
      seen.add(core);
      strings.push(core);
    }
    return core;
  });
  return strings;
}

// Re-emit `html` with each text segment replaced by `dict[segment]` when present
// (otherwise left as-is). Segments with no entry stay in the source language,
// so an empty dict returns the input unchanged.
export function localizeHtml(html, dict) {
  const map = dict instanceof Map ? dict : new Map(Object.entries(dict || {}));
  return scanText(html, (core) => (map.has(core) ? map.get(core) : core));
}

// How much of a page a locale's string table actually covers — the real,
// per-page version of Meridian's "uncovered" exposure, computed against the
// live page rather than a seeded model.
export function coverage(html, dict) {
  const map = dict instanceof Map ? dict : new Map(Object.entries(dict || {}));
  const strings = extractStrings(html);
  const translated = strings.filter((s) => map.has(s));
  return {
    total: strings.length,
    translated: translated.length,
    missing: strings.filter((s) => !map.has(s)),
    ratio: strings.length ? translated.length / strings.length : 1,
  };
}

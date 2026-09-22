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
 * Translation Memory (TM) — a git-backed, content-addressed store of approved
 * translations. Every localization platform has a TM; Meridian's is native to
 * the model: entries are keyed by the exact source segment, so an identical
 * string anywhere (across pages, across markets) is translated once and reused —
 * cheaper, more consistent, and human overrides (commercial/compliance) become
 * durable assets rather than one-off edits. The artifact is plain JSON per
 * locale (diffs cleanly in git), and this module is pure so it is fully tested.
 *
 * Shape: { locale, entries: { <sourceText>: { target, origin, provider, updated } } }
 *   origin: 'mt' (machine) | 'human' (authored/approved sign-off)
 */

export function emptyTm(locale) {
  return { locale: locale ?? null, entries: {} };
}

const has = (tm, source) => {
  const hit = tm?.entries?.[source];
  return !!(hit && hit.target != null && hit.target !== '');
};

// Split a list of source strings into TM hits (source -> target) and misses
// (strings still needing translation). De-duplicates and drops blanks.
export function lookup(tm, sources) {
  const hits = new Map();
  const misses = [];
  [...new Set((sources || []).filter((s) => s && s.trim()))].forEach((source) => {
    if (has(tm, source)) hits.set(source, tm.entries[source].target);
    else misses.push(source);
  });
  return { hits, misses };
}

// Return a NEW TM with `updates` (Map or object of source->target) recorded.
// Blank targets are ignored. `meta`: { origin, provider, now, locale }.
export function record(tm, updates, meta = {}) {
  const list = updates instanceof Map ? [...updates.entries()] : Object.entries(updates || {});
  const entries = { ...(tm?.entries || {}) };
  const updated = meta.now || new Date().toISOString();
  list.forEach(([source, target]) => {
    if (!source || target == null || String(target).trim() === '') return;
    entries[source] = {
      target,
      origin: meta.origin || 'mt',
      provider: meta.provider ?? null,
      updated,
    };
  });
  // Prefer the caller's stated locale over the document's own field, so a doc
  // with a stale/wrong embedded locale can't misdirect a later write.
  return { locale: meta.locale ?? tm?.locale ?? null, entries };
}

export function size(tm) {
  return Object.keys(tm?.entries || {}).length;
}

// Wrap a translate(strings, opts) provider so it serves from TM first and only
// sends MISSES to the underlying provider. Newly translated pairs accumulate on
// `.learned` (a Map) so the caller can persist them back to the TM after the
// run. `.stats` reports leverage (TM hits vs provider misses).
export function createTmTranslator({ tm, translate }) {
  const learned = new Map();
  let hits = 0;
  let misses = 0;
  return {
    learned,
    get stats() {
      return { hits, misses };
    },
    async translate(strings, opts) {
      const { hits: fromTm, misses: toTranslate } = lookup(tm, strings);
      hits += fromTm.size;
      misses += toTranslate.length;
      const result = new Map(fromTm);
      if (toTranslate.length) {
        const fresh = await translate(toTranslate, opts);
        fresh.forEach((target, source) => {
          result.set(source, target);
          learned.set(source, target);
        });
      }
      return result;
    },
  };
}

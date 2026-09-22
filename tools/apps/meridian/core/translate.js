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
 * Pluggable machine-translation provider for the language layer.
 *
 * Like MSM (which uses Google Translate), Meridian's language layer is produced
 * by a real translation service — never hand-authored. The provider is injected
 * so any 3rd-party engine (Google, DeepL, Microsoft, a private MT) can back it
 * without touching callers; the default posts to the Meridian worker's
 * `/translate` proxy so provider API keys stay server-side and the browser app
 * is not blocked by CORS. Only the LANGUAGE layer is machine-translated — the
 * caller must withhold commercial/compliance segments, which stay human-owned.
 */

const DEFAULT_ENDPOINT = 'https://meridian-worker.compass-xsc.workers.dev/translate';

// A DA locale ("es_es", "fr_ca", "pt_br") -> a translation-service language tag.
// Most services want the language subtag; a few are region-sensitive.
const REGION_TAGS = {
  pt_br: 'pt-BR', pt_pt: 'pt-PT', zh_cn: 'zh-CN', zh_tw: 'zh-TW', zh_hk: 'zh-TW',
};

export function localeToLang(locale) {
  if (!locale) return '';
  const key = String(locale).toLowerCase().replace('-', '_');
  if (REGION_TAGS[key]) return REGION_TAGS[key];
  return key.split('_')[0];
}

// Accept either an ordered array (aligned to the request) or an explicit
// { source: target } map, so a 3rd-party proxy has latitude in its response.
function toMap(sources, data) {
  const map = new Map();
  const list = Array.isArray(data) ? data : data?.translations;
  if (Array.isArray(list)) {
    sources.forEach((src, i) => {
      const t = list[i];
      const value = typeof t === 'string' ? t : t?.target ?? t?.translation;
      if (value != null && value !== '') map.set(src, value);
    });
    return map;
  }
  const obj = data?.map && typeof data.map === 'object' ? data.map : null;
  if (obj) {
    sources.forEach((src) => {
      if (obj[src] != null && obj[src] !== '') map.set(src, obj[src]);
    });
  }
  return map;
}

// createTranslator(fetchImpl, { endpoint }) -> translate(strings, { from, to })
//   -> Promise<Map<sourceString, translatedString>>
// `fetchImpl` is injectable for tests; in the browser it defaults to global fetch.
export function createTranslator(fetchImpl, opts = {}) {
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const { org, site } = opts;
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);

  return async function translate(strings, { from = 'en', to } = {}) {
    const target = localeToLang(to);
    if (!target) throw new Error('translate requires a target locale');
    const unique = [...new Set((strings || []).filter((s) => s && s.trim()))];
    if (!unique.length) return new Map();
    if (!doFetch) throw new Error('no fetch implementation available for translation');

    const resp = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // org/site let the worker verify the caller has DA access (it does not
      // forward the token to DA itself for translation).
      body: JSON.stringify({
        from: localeToLang(from) || 'en', to: target, strings: unique, org, site,
      }),
    });
    if (!resp.ok) {
      const detail = resp.headers?.get?.('x-error') || `HTTP ${resp.status}`;
      throw new Error(`translation failed: ${detail}`);
    }
    const data = await resp.json();
    return toMap(unique, data);
  };
}

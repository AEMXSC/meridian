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

// Pure draft logic for the Setup tab (declare / edit a site's markets). Kept out
// of the component so the rules are node-testable; every function returns a new
// value and never mutates its input.

// Same token rule as the store/locale-config: a single safe path segment.
const SAFE = /^[a-zA-Z0-9_-]+$/;

export const PUBLISH_MODES = ['sandbox', 'locale-root'];

/**
 * Add a market to the draft list. Returns { markets, error }: on a bad or duplicate
 * code the ORIGINAL list is returned untouched alongside a message to show.
 */
export function addDraftMarket(markets, code, name) {
  const token = String(code ?? '').trim();
  if (!token || !SAFE.test(token)) {
    return { markets, error: `"${token}" isn't a valid locale code (letters, digits, - or _).` };
  }
  if (markets.some((m) => m.code === token)) {
    return { markets, error: `${token} is already a market.` };
  }
  return {
    markets: [...markets, { code: token, name: String(name ?? '').trim() || token }],
    error: '',
  };
}

export function removeDraftMarket(markets, code) {
  return markets.filter((m) => m.code !== code);
}

/** The first problem with a setup draft as a message, or '' when it can be saved. */
export function validateSetup({ sourceLocale, markets, publishMode }) {
  const source = String(sourceLocale ?? '').trim();
  if (!source || !SAFE.test(source)) return 'Set the source language code (e.g. en).';
  if (markets.some((m) => m.code.toLowerCase() === source.toLowerCase())) {
    return `${source} is the source language — remove it from the markets.`;
  }
  if (!PUBLISH_MODES.includes(publishMode)) return 'Choose a publish mode.';
  return '';
}

/**
 * What the author changed: markets added and codes removed, relative to the codes
 * that were loaded when Setup opened. Saving applies THIS delta to a fresh read
 * of the config, so an edit someone else made in between (the DA localization
 * app, another tab) isn't silently overwritten by a stale full list.
 */
export function diffMarkets(loadedCodes, draftMarkets) {
  const loaded = new Set(loadedCodes);
  const draft = new Set(draftMarkets.map((m) => m.code));
  return {
    add: draftMarkets.filter((m) => !loaded.has(m.code)),
    remove: loadedCodes.filter((code) => !draft.has(code)),
  };
}

/**
 * True when config.json carries a half-authored exposure model (one of
 * canonicalId / policies[] without the other). A Setup-only config — just
 * sourceLocale / publishMode — is complete as written and is NOT partial.
 */
export function isPartialModelConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const hasId = config.canonicalId !== undefined;
  const hasPolicies = config.policies !== undefined;
  if (!hasId && !hasPolicies) return false;
  return !(config.canonicalId && Array.isArray(config.policies));
}

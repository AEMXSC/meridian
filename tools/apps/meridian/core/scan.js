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

import scanExposure from './exposure.js';

// Orchestrates a read-only exposure scan (Job 1) against a store: reads the
// canonical, then every market's adaptation layer and stored /live variant,
// and hands them to the pure diff. Reads only — never writes.

/**
 * @param {{ readCanonical: Function, readLayer: Function, readVariant: Function }} store
 * @param {string} canonicalId
 * @param {import('./exposure.js').MarketPolicy[]} policies - markets that should exist
 * @param {{ confidenceThreshold?: number, now?: string }} [opts]
 * @returns {Promise<import('./schemas.js').ExposureFinding[]>}
 */
export default async function scanCanonical(store, canonicalId, policies, opts = {}) {
  const canonical = await store.readCanonical(canonicalId);
  const layers = new Map();
  const stored = new Map();

  await Promise.all(policies.map(async (policy) => {
    const [layer, variant] = await Promise.all([
      store.readLayer(policy.locale, canonicalId),
      store.readVariant(policy.locale, canonicalId),
    ]);
    if (layer) layers.set(policy.locale, layer);
    if (variant) stored.set(policy.locale, variant);
  }));

  return scanExposure({
    canonical,
    policies,
    layers,
    stored,
    confidenceThreshold: opts.confidenceThreshold,
    now: opts.now,
  });
}

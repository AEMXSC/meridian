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
/* eslint-disable import/no-unresolved, import/no-relative-packages */
// The engine lives in the sibling app package by design; agents/ reuses it.

// Meridian MCP server (PRD §9): the localization engine as agent tools, so it
// composes inside Experience Workspace and Agent Orchestrator. Each tool reuses
// the same pure engine the DA app runs, over a Node DA store. Read-only tools
// (exposure.scan, propagation.plan, locale.propose) write nothing. Write paths:
// propagation.apply (requires an approved plan — no silent apply) and
// migrate.ingest with apply:true (bootstraps a site from an MSM import; refuses
// to overwrite a site that already tracks a different canonical).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import scanCanonical from '../../tools/apps/meridian/core/scan.js';
import { planPropagation, applyPropagation } from '../../tools/apps/meridian/core/propagate.js';
import rollback from '../../tools/apps/meridian/core/rollback.js';
import createArchitect from '../../tools/apps/meridian/core/propose.js';
import ingestMsm from '../../tools/apps/meridian/core/migrate.js';
import nodeStore from './da-client.js';

const architect = createArchitect();

const orgSite = {
  org: { type: 'string', description: 'DA organization (e.g. aemxsc)' },
  site: { type: 'string', description: 'DA site / repo (e.g. citizens)' },
};

const TOOLS = [
  {
    name: 'meridian_exposure_scan',
    description: 'Read-only: diff canonical against every market and return exposure findings (stale, missing-required, drift, low-confidence, uncovered). Writes nothing.',
    inputSchema: { type: 'object', properties: { ...orgSite }, required: ['org', 'site'] },
  },
  {
    name: 'meridian_propagation_plan',
    description: 'Read-only: given the canonical block ids that changed, return which markets and blocks must recompute (a cost preview). Writes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgSite,
        changedBlockIds: { type: 'array', items: { type: 'string' }, description: 'Canonical block ids that changed' },
      },
      required: ['org', 'site', 'changedBlockIds'],
    },
  },
  {
    name: 'meridian_propagation_apply',
    description: 'Execute an approved plan: recompute affected variants, gate them, materialize clean output to /live and route flagged/blocked to the taste queue. Returns applied/gated/failed and a rollback snapshot. Requires a plan (no silent apply).',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgSite,
        plan: { type: 'object', description: 'A plan from meridian_propagation_plan' },
        publish: { type: 'boolean', description: 'When true, also preview+publish auto-applied variants to the edge (default false = write to DA source only)' },
      },
      required: ['org', 'site', 'plan'],
    },
  },
  {
    name: 'meridian_propagation_rollback',
    description: 'Revert a propagation across every touched market, restoring /live from the snapshot returned by apply (or deleting where there was none).',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgSite,
        canonicalId: { type: 'string' },
        snapshot: { type: 'object', description: 'The snapshot object returned by meridian_propagation_apply' },
        publish: { type: 'boolean', description: 'When true, also restore the edge (re-publish restored variants, unpublish deleted ones)' },
      },
      required: ['org', 'site', 'canonicalId', 'snapshot'],
    },
  },
  {
    name: 'meridian_locale_propose',
    description: 'Setup surface (Locale Architect): turn a natural-language intent (one sentence describing a market) into a proposed adaptation policy — locale, required layers, rationale. Writes nothing; a human reviews and activates.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'e.g. "Add a Quebec French market: translate everything, keep US pricing, and it legally needs a French disclosure"' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'meridian_migrate_ingest',
    description: 'Migration on-ramp: ingest an existing MSM structure (a source doc + per-market copies) into one canonical object plus N typed adaptation sets. Returns canonical, layers, and policies. Writes nothing unless apply:true, which persists them under /meridian for the given site (works for any org/site).',
    inputSchema: {
      type: 'object',
      properties: {
        ...orgSite,
        canonicalId: { type: 'string', description: 'Target canonical id, e.g. "canon/offers/spring"' },
        title: { type: 'string' },
        source: { type: 'object', description: 'The base/source doc: { blocks: [{ id, type, content }] }' },
        markets: { type: 'array', description: 'Per-market copies: [{ locale, blocks: [{ id, type, content }] }]', items: { type: 'object' } },
        apply: { type: 'boolean', description: 'When true, persist canonical + layers + config under /meridian (default false = preview only)' },
      },
      required: ['org', 'site', 'canonicalId', 'source', 'markets'],
    },
  },
];

async function loadLayers(store, canonicalId, policies) {
  const layers = new Map();
  await Promise.all(policies.map(async (p) => {
    const layer = await store.readLayer(p.locale, canonicalId);
    if (layer) layers.set(p.locale, layer);
  }));
  return layers;
}

async function requireConfig(store) {
  const config = await store.readConfig();
  if (!config || !config.canonicalId || !Array.isArray(config.policies)) {
    throw new Error('Missing or malformed /meridian/config.json (needs canonicalId + policies[])');
  }
  return config;
}

async function dispatch(name, args) {
  const store = nodeStore(args.org, args.site);
  if (name === 'meridian_exposure_scan') {
    const config = await requireConfig(store);
    return scanCanonical(store, config.canonicalId, config.policies);
  }
  if (name === 'meridian_propagation_plan') {
    const config = await requireConfig(store);
    const canonical = await store.readCanonical(config.canonicalId);
    return planPropagation(canonical, args.changedBlockIds, config.policies);
  }
  if (name === 'meridian_propagation_apply') {
    const config = await requireConfig(store);
    const canonical = await store.readCanonical(config.canonicalId);
    const layers = await loadLayers(store, config.canonicalId, config.policies);
    return applyPropagation(store, canonical, args.plan, {
      layers, policies: config.policies, publish: Boolean(args.publish),
    });
  }
  if (name === 'meridian_propagation_rollback') {
    return rollback(store, args.canonicalId, args.snapshot, { publish: Boolean(args.publish) });
  }
  if (name === 'meridian_locale_propose') {
    return architect(args.intent);
  }
  if (name === 'meridian_migrate_ingest') {
    const result = await ingestMsm({
      canonicalId: args.canonicalId,
      title: args.title,
      source: args.source,
      markets: args.markets,
    });
    if (args.apply) {
      const current = await store.readConfig();
      // Never clobber a site that already tracks a different canonical.
      if (current && current.canonicalId && current.canonicalId !== result.canonical.id) {
        throw new Error(`Site already tracks ${current.canonicalId}; refusing to overwrite with ${result.canonical.id}.`);
      }
      await store.writeCanonical(result.canonical);
      // Write layers sequentially so a failure is deterministic (which locale)
      // rather than a concurrent half-applied batch; config is written last so a
      // partial layer failure never leaves config pointing at missing layers.
      await [...result.layers.values()].reduce(
        (chain, layer) => chain.then(() => store.writeLayer(layer)),
        Promise.resolve(),
      );
      // Merge policies by locale into any existing config, preserving other fields.
      const byLocale = new Map((current?.policies ?? []).map((p) => [p.locale, p]));
      result.policies.forEach((p) => byLocale.set(p.locale, p));
      await store.writeConfig({
        ...current,
        canonicalId: result.canonical.id,
        policies: [...byLocale.values()],
      });
    }
    // Serialize the layers Map for JSON output.
    return {
      canonical: result.canonical,
      layers: Object.fromEntries(result.layers),
      policies: result.policies,
      applied: Boolean(args.apply),
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const server = new Server({ name: 'meridian', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await dispatch(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

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
 * Meridian smoke test — the common multi-site management jobs, run end-to-end
 * through the real engine over an in-memory store. Not a unit test: this checks
 * that the whole thing does the MSM jobs an author actually performs.
 *   node scripts/smoke.mjs
 *
 * Model reminder (what the jobs below verify):
 *  - A block with NO adaptation entry is INHERITED — it tracks the master and
 *    updates automatically on rollout. This is how "keep the rest in sync" works.
 *  - A block with an override/translate/fork entry holds the market's own value.
 *  - Compliance-absent markets never publish; low-confidence translations queue.
 */

import { hashBlockContent } from '../tools/apps/meridian/core/hash.js';
import { materialize } from '../tools/apps/meridian/core/materialize.js';
import { planPropagation, applyPropagation } from '../tools/apps/meridian/core/propagate.js';
import rollback from '../tools/apps/meridian/core/rollback.js';
import scanExposure from '../tools/apps/meridian/core/exposure.js';
import ingestMsm from '../tools/apps/meridian/core/migrate.js';
import { heuristicArchitect } from '../tools/apps/meridian/core/propose.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; process.stdout.write(`  ✓ ${label}\n`); } else {
    fail += 1; failures.push(label);
    process.stdout.write(`  ✗ ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}
const heading = (t) => process.stdout.write(`\n${t}\n`);

function memStore(canonicalRef, layers) {
  const live = new Map();
  const queue = new Map();
  return {
    readCanonical: async () => canonicalRef.value,
    readLayer: async (loc) => layers.get(loc) ?? null,
    readVariant: async (loc) => live.get(loc) ?? null,
    writeVariant: async (v) => { live.set(v.locale, v); },
    deleteVariant: async (loc) => { live.delete(loc); },
    writeQueueItem: async (it) => { queue.set(it.locale, it); },
    live,
    queue,
  };
}

const block = async (id, type, content) => ({
  id, type, content, hash: await hashBlockContent(type, content),
});
const translate = (blockId, value, confidence, sourceHash) => ({
  blockId, layer: 'language', operation: 'translate', value, reason: 'localized', provenance: 'agent', confidence, status: 'auto-applied', sourceHash,
});
// status + sourceHash are always passed explicitly by callers below.
const override = (blockId, layer, value, status, sourceHash) => ({
  blockId, layer, operation: 'override', value, reason: 'market override', provenance: 'human', confidence: null, status, sourceHash,
});

async function run() {
  const canonV1 = {
    id: 'canon/offers/spring',
    title: 'Spring Offer',
    updated: '2026-09-01T00:00:00Z',
    blocks: [
      await block('hero', 'hero', { heading: 'Spring savings' }),
      await block('price', 'commercial', { amount: '10 USD' }),
      await block('legal', 'compliance', { text: 'Standard terms.' }),
    ],
  };

  const heroHash = canonV1.blocks[0].hash;
  const priceHash = canonV1.blocks[1].hash;
  const legalHash = canonV1.blocks[2].hash;
  const layers = new Map([
    // en_us: inherits everything → pure mirror of the master.
    ['en_us', { locale: 'en_us', canonicalId: canonV1.id, entries: [] }],
    // en_gb: INHERITS hero (syncs), OVERRIDES price. The "edit one part, keep
    // the rest in sync" market.
    ['en_gb', { locale: 'en_gb', canonicalId: canonV1.id, entries: [override('price', 'commercial', { amount: '10 GBP' }, 'human-owned', priceHash)] }],
    // de_de: translates hero, keeps EUR price + DE legal. Compliance present.
    ['de_de', {
      locale: 'de_de',
      canonicalId: canonV1.id,
      entries: [
        translate('hero', { heading: 'Frühlingsangebot' }, 0.95, heroHash),
        override('price', 'commercial', { amount: '10 EUR' }, 'human-owned', priceHash),
        override('legal', 'compliance', { text: 'Pflichtangabe.' }, 'human-owned-nonnegotiable', legalHash),
      ],
    }],
    // fr_fr: requires compliance, has none → must be blocked.
    ['fr_fr', { locale: 'fr_fr', canonicalId: canonV1.id, entries: [translate('hero', { heading: 'Offre de printemps' }, 0.95, heroHash)] }],
    // es_mx: low-confidence hero translation → taste queue on a hero change.
    ['es_mx', { locale: 'es_mx', canonicalId: canonV1.id, entries: [translate('hero', { heading: 'Ofertas de primavera' }, 0.5, heroHash)] }],
    // ja_jp: forks hero (bespoke), inherits the rest.
    ['ja_jp', {
      locale: 'ja_jp',
      canonicalId: canonV1.id,
      entries: [{
        blockId: 'hero', layer: 'structural', operation: 'fork', value: { heading: 'JP bespoke hero' }, reason: 'own hero', provenance: 'human', confidence: null, status: 'human-owned',
      }],
    }],
  ]);

  const policies = [
    { locale: 'en_us', requiredLayers: [] },
    { locale: 'en_gb', requiredLayers: [] },
    { locale: 'de_de', requiredLayers: ['compliance'] },
    { locale: 'fr_fr', requiredLayers: ['compliance'] },
    { locale: 'es_mx', requiredLayers: [] },
    { locale: 'ja_jp', requiredLayers: [] },
  ];

  const canonicalRef = { value: canonV1 };
  const store = memStore(canonicalRef, layers);
  await Promise.all(policies.map(async (p) => {
    store.live.set(p.locale, materialize(canonV1, layers.get(p.locale), p.locale));
  }));

  // ==== Roll out a launch ===================================================
  heading('JOB 1  Roll out a launch — change the master hero, propagate to every market');
  const canonV2 = {
    ...canonV1,
    updated: '2026-09-20T00:00:00Z',
    blocks: [await block('hero', 'hero', { heading: 'Spring savings — now 20% off' }), canonV1.blocks[1], canonV1.blocks[2]],
  };
  canonicalRef.value = canonV2;

  const plan = planPropagation(canonV2, ['hero'], policies);
  check('plan targets only the changed block', plan.changedBlockIds.join() === 'hero');
  check('plan marks every market affected', plan.affectedLocales.length === 6);

  const res = await applyPropagation(store, canonV2, plan, { layers, policies, now: '2026-09-20T00:00:00Z' });
  const applied = res.applied.map((a) => a.locale).sort();
  const gated = Object.fromEntries(res.gated.map((g) => [g.locale, g.gate]));
  const heroOf = (loc) => store.live.get(loc)?.blocks.find((b) => b.id === 'hero')?.content.heading;

  check('no per-market failures', res.failed.length === 0, JSON.stringify(res.failed));
  check(
    'inheriting markets took the master change (en_us, en_gb show 20%)',
    heroOf('en_us').includes('20%') && heroOf('en_gb').includes('20%'),
    `en_us="${heroOf('en_us')}" en_gb="${heroOf('en_gb')}"`,
  );

  // ==== Edit one part, keep the rest in sync ================================
  heading('JOB 2  Edit one part, keep the rest in sync — en_gb: hero synced, GBP price preserved');
  const gb = store.live.get('en_gb');
  check('en_gb hero synced to the master', gb.blocks.find((b) => b.id === 'hero').content.heading.includes('20%'));
  check('en_gb kept its own GBP price', gb.blocks.find((b) => b.id === 'price').content.amount === '10 GBP');

  // ==== Fork stays divergent while the rest sync ===========================
  heading('JOB 3  A market runs one block its own way (ja_jp forked hero), still syncs the rest');
  const jpHero = store.live.get('ja_jp').blocks.find((b) => b.id === 'hero');
  const jpPrice = store.live.get('ja_jp').blocks.find((b) => b.id === 'price');
  check('ja_jp hero kept its fork (ignored the master change)', jpHero.content.heading === 'JP bespoke hero');
  check('ja_jp forked hero is detached (never flagged stale)', String(jpHero.derivedFrom).startsWith('fork:'));
  check('ja_jp still inherits the master price', jpPrice.derivedFrom === canonV2.blocks[1].hash);

  // ==== Compliance + low-confidence gates ==================================
  heading('JOB 4  Compliance gate — fr_fr has no disclosure, so it must NOT publish');
  check('fr_fr blocked', gated.fr_fr === 'blocked');
  check('fr_fr did NOT get the change on the edge', !String(heroOf('fr_fr')).includes('20%'));

  heading('JOB 5  Low-confidence gate — es_mx shaky translation lands in the taste queue');
  check('es_mx routed to review', gated.es_mx === 'review');
  check('es_mx is in the taste queue, not auto-published', store.queue.has('es_mx'));

  check('inheriting + forked markets auto-publish (en_us, en_gb, ja_jp)', applied.join() === 'en_gb,en_us,ja_jp', applied.join());

  heading('JOB 5b  Source-change re-translation — de_de translated the hero, so a text launch routes it to review');
  check('de_de routed to review (not auto-publishing the outdated German)', gated.de_de === 'review', JSON.stringify(res.gated));
  check('de_de did NOT auto-publish stale German to the edge', store.live.get('de_de').blocks.find((b) => b.id === 'hero').content.heading === 'Frühlingsangebot' && store.queue.has('de_de'));

  // ==== Rollback ===========================================================
  heading('JOB 6  Roll back the launch — one action restores the edge');
  const rb = await rollback(store, canonV2.id, res.snapshot);
  check('rollback restored the touched markets', rb.restored.includes('en_us') && rb.restored.includes('en_gb'));
  check('en_us hero is back to pre-launch text', !String(heroOf('en_us')).includes('20%'));

  // ==== Exposure ===========================================================
  heading('JOB 7  See where I am exposed before launching');
  const stale = new Map([['de_de', {
    locale: 'de_de',
    canonicalId: canonV2.id,
    blocks: [{
      id: 'hero', type: 'hero', content: { heading: 'old' }, derivedFrom: canonV1.blocks[0].hash,
    }],
  }]]);
  const findings = scanExposure({
    canonical: canonV2, policies: [{ locale: 'de_de', requiredLayers: [] }], layers, stored: stale, now: '2026-09-20T00:00:00Z',
  });
  check('exposure flags the stale market', findings.some((f) => f.kind === 'stale' && f.locale === 'de_de'));

  // ==== Migration ==========================================================
  heading('JOB 8  Migrate a legacy MSM site — source + market copies → 1 canonical + N sets, lossless');
  const ingest = await ingestMsm({
    canonicalId: 'canon/legacy/home',
    source: { blocks: [{ id: 'hero', type: 'hero', content: { h: 'Welcome' } }, { id: 'price', type: 'commercial', content: { amt: '5' } }] },
    markets: [
      { locale: 'de_de', blocks: [{ id: 'hero', type: 'hero', content: { h: 'Willkommen' } }, { id: 'price', type: 'commercial', content: { amt: '5' } }] },
      { locale: 'fr_fr', blocks: [{ id: 'hero', type: 'hero', content: { h: 'Bienvenue' } }, { id: 'price', type: 'commercial', content: { amt: '4' } }] },
    ],
  }, { now: '2026-09-20T00:00:00Z' });
  check('one canonical + N adaptation sets', ingest.canonical.blocks.length === 2 && ingest.layers.size === 2);
  const deMig = materialize(ingest.canonical, ingest.layers.get('de_de'));
  check('lossless (de_de recomputes to its original hero)', deMig.blocks.find((b) => b.id === 'hero').content.h === 'Willkommen');
  check('identical block inherited, not re-authored (de_de price)', !ingest.layers.get('de_de').entries.some((e) => e.blockId === 'price'));

  // ==== Setup surface ======================================================
  heading('JOB 9  Stand up a market from one sentence');
  const proposal = heuristicArchitect('Add a Quebec French market: translate everything, keep US pricing, and it legally needs a French disclosure');
  check('proposed the right locale (fr_ca)', proposal.locale === 'fr_ca');
  check(
    'required language + compliance, pricing inherited (no commercial)',
    proposal.requiredLayers.includes('language') && proposal.requiredLayers.includes('compliance') && !proposal.requiredLayers.includes('commercial'),
  );

  // ==== Source-staleness (the earlier gap, now fixed both ways) =============
  heading('JOB 10  Stale-source translation is caught — exposure flags it AND a launch never auto-ships it');
  // Even if de_de's old translation were somehow re-stamped onto /live, a scan
  // against the new master flags it via the entry's sourceHash.
  const dePostFindings = scanExposure({
    canonical: canonV2,
    policies: [{ locale: 'de_de', requiredLayers: ['compliance'] }],
    layers,
    stored: new Map([['de_de', materialize(canonV2, layers.get('de_de'), 'de_de')]]),
    now: '2026-09-20T00:00:00Z',
  });
  const heroStale = dePostFindings.find((f) => f.kind === 'stale' && f.blockId === 'hero');
  check('exposure flags de_de hero as source-stale (needs re-translation)', Boolean(heroStale), JSON.stringify(dePostFindings.map((f) => `${f.kind}:${f.blockId ?? ''}`)));
  check('the de_de legal override (source unchanged) is NOT flagged', !dePostFindings.some((f) => f.kind === 'stale' && f.blockId === 'legal'));

  heading('════════════════════════════════════════════');
  process.stdout.write(`RESULT: ${pass} passed, ${fail} failed\n`);
  if (fail) process.stdout.write(`FAILING: ${failures.join(' | ')}\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  process.stdout.write(`\nSMOKE HARNESS CRASHED: ${e.stack}\n`);
  process.exit(2);
});

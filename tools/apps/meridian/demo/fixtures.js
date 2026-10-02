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

// DEMO ONLY. Seeds an in-memory DA source tree so the GitHub Pages prototype is
// populated on first load — real source pages to localize, a market catalog, a
// managed manifest (some live, some staged, one stale), pending approvals, and
// the Phase-1 exposure model. Shapes come straight from the app's own helpers so
// the seed is exactly what the store would read back.

import buildFixture from '../seed/informatica.js';
import { writeSheet } from '../core/da-config.js';
import { extractStrings, localizeHtml } from '../core/eds-html.js';
import {
  canonPath, adaptPath, livePath, localePagePath,
} from '../core/store.js';
import { markManaged } from '../core/managed.js';
import fakeTranslate from './translate-dict.js';

export const DEMO_ORG = 'meridian';
export const DEMO_SITE = 'bank';
const BASE = '/meridian';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// A source page as EDS-style authored HTML. Commercial (money/%) and compliance
// (FDIC/terms) lines are deliberately present so the live Translate flow shows
// them withheld for human sign-off.
function pageHtml(sections) {
  const body = sections.map((s) => `    <div>\n${s.map((p) => `      ${p}`).join('\n')}\n    </div>`).join('\n');
  return `<body>\n  <main>\n${body}\n  </main>\n</body>\n`;
}

const PAGES = {
  '/index.html': pageHtml([
    ['<h1>Welcome to Meridian Bank</h1>', '<p>Bank with confidence.</p>'],
    ['<h2>Personal Banking</h2>', '<p>Everyday banking made simple.</p>', '<p><a href="/personal-banking">Learn more</a></p>'],
    ['<h2>Business Banking</h2>', '<p>Manage your money with confidence.</p>', '<p><a href="/business-banking">Learn more</a></p>'],
  ]),
  '/personal-banking.html': pageHtml([
    ['<h1>Personal Banking</h1>', '<p>Everyday banking made simple.</p>'],
    ['<h2>Checking Accounts</h2>', '<p>Access your money anywhere.</p>', '<p><a href="/personal-banking/checking">Open an account</a></p>'],
    ['<h2>Savings Accounts</h2>', '<p>Save for what matters.</p>', '<p><a href="/personal-banking/savings">Learn more</a></p>'],
  ]),
  '/personal-banking/checking.html': pageHtml([
    ['<h1>Checking Accounts</h1>', '<p>Everyday banking made simple.</p>'],
    ['<p>No monthly fees with direct deposit.</p>', '<p>Member FDIC. Terms and conditions apply.</p>', '<p><a href="/open">Open an account</a></p>'],
  ]),
  '/personal-banking/savings.html': pageHtml([
    ['<h1>Savings Accounts</h1>', '<p>Save for what matters.</p>'],
    ['<p>Earn 4.5% APY on balances over 10,000 USD.</p>', '<p>Member FDIC.</p>', '<p><a href="/open">Apply now</a></p>'],
  ]),
  '/business-banking.html': pageHtml([
    ['<h1>Business Banking</h1>', '<p>Manage your money with confidence.</p>', '<p><a href="/open">Learn more</a></p>'],
  ]),
  '/mortgages.html': pageHtml([
    ['<h1>Home Mortgages</h1>', '<p>Own your home.</p>'],
    ['<p>Rates from 5.9% APR.</p>', '<p>Terms and conditions apply.</p>', '<p><a href="/open">Apply now</a></p>'],
  ]),
  '/about.html': pageHtml([
    ['<h1>Welcome to Meridian Bank</h1>', '<p>A trusted, secure bank.</p>'],
  ]),
};

// A page already localized for a market: translate every extracted string (the
// seed is "already done" content; the live flow demonstrates proper withholding)
// and stamp it as Meridian-managed, same as a real publish would.
function localizedHtmlFor(sourceHtml, locale) {
  const strings = extractStrings(sourceHtml);
  const targets = fakeTranslate(strings, locale);
  const dict = new Map(strings.map((s, i) => [s, targets[i]]));
  return markManaged(localizeHtml(sourceHtml, dict));
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Build the exposure model (config + canon/adapt/live) from the shared seed, so
// the Issues tab surfaces the four planted exposures through the real scanner.
async function seedExposure(set) {
  const {
    canonical, policies, layers, stored,
  } = await buildFixture();
  set(`${BASE}/config.json`, serialize({ canonicalId: canonical.id, policies, sourceLocale: 'en' }));
  set(canonPath(BASE, canonical.id), serialize(canonical));
  const { id } = canonical;
  layers.forEach((layer, locale) => set(adaptPath(BASE, locale, id), serialize(layer)));
  stored.forEach((variant, locale) => set(livePath(BASE, locale, id), serialize(variant)));
}

// The managed manifest + the localized page files it points at. Mix of live
// (promoted), staged (awaiting approval), and one stale market, with two slug
// translations so the SEO-slug story is visible.
const MANAGED = [
  {
    ref: 'personal-banking', locale: 'es', mode: 'locale-root', slug: 'banca-personal', age: 2 * DAY,
  },
  {
    ref: 'personal-banking', locale: 'de', mode: 'locale-root', age: 2 * DAY,
  },
  {
    ref: 'personal-banking', locale: 'fr', mode: 'sandbox', age: 1 * DAY,
  },
  {
    ref: 'mortgages', locale: 'es', mode: 'sandbox', slug: 'hipotecas', age: 1 * DAY,
  },
  // Stale: localized 6 days ago, but its English source was just edited (below).
  {
    ref: 'personal-banking/checking', locale: 'es', mode: 'locale-root', slug: 'personal-banking/cuentas-corrientes', age: 6 * DAY,
  },
];

export default async function buildFs() {
  const fs = new Map();
  const now = Date.now();
  const set = (path, body, lastModified = now - 10 * DAY) => fs.set(path, { body, lastModified });

  // Source pages. Most are old; checking was "just edited" to make its Spanish
  // localization show as stale on the dashboard and in the editor panel.
  Object.entries(PAGES).forEach(([path, html]) => set(path, html));
  fs.get('/personal-banking/checking.html').lastModified = now - 1 * HOUR;

  // Market catalog (same sheet the DA localization app reads) + DA loc config.
  set('/.da/translate-v2.json', serialize(writeSheet(null, 'languages', [
    { name: 'Spanish', location: '/es' },
    { name: 'French', location: '/fr' },
    { name: 'German', location: '/de' },
    { name: 'Italian', location: '/it' },
    { name: 'Portuguese', location: '/pt' },
  ])));
  let loc = writeSheet(null, 'languages', [
    { locale: 'es', language: 'Spanish', action: 'translate' },
    { locale: 'fr', language: 'French', action: 'translate' },
  ]);
  loc = writeSheet(loc, 'dnt-content-rules', [{ term: 'Meridian' }, { term: 'Meridian Bank' }]);
  set('/.da/translate.json', serialize(loc));

  await seedExposure(set);

  // Managed pages + their localized files + pending approvals for staged ones.
  const entries = [];
  const promotions = [];
  MANAGED.forEach(({
    ref, locale, mode, slug, age,
  }) => {
    const source = fs.get(`/${ref}.html`);
    const html = localizedHtmlFor(source.body, locale);
    const lastModified = now - age;
    // Write at the ref path (dashboard/promote read here) and, when slugged, at
    // the slug path too (the live/View URL resolves through the slug).
    set(localePagePath(BASE, locale, ref, mode), html, lastModified);
    if (slug && slug !== ref) set(localePagePath(BASE, locale, slug, mode), html, lastModified);
    entries.push({
      ref, locale, mode, ...(slug && slug !== ref ? { slug } : {}), at: lastModified,
    });
    if (mode === 'sandbox') {
      const rec = {
        ref,
        locale,
        ...(slug && slug !== ref ? { slug } : {}),
        site: DEMO_SITE,
        requestedBy: 'author@meridian.demo',
        at: lastModified,
      };
      promotions.push(rec);
      set(`${BASE}/promotions/${locale}/${ref}.json`, serialize(rec));
    }
  });
  set(`${BASE}/managed.json`, serialize({ entries }));

  return { fs, org: DEMO_ORG, site: DEMO_SITE };
}

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

// Site integration for Meridian's locale-root (production) publish mode.
//
// EDS composes <head> itself, so hreflang can't be baked into page content.
// Instead Meridian publishes a small data file (/meridian/hreflang.json) mapping
// each page to its locale cluster, and this drop-in injects the reciprocal
// <link rel="alternate" hreflang> tags at runtime on BOTH the source page and
// every localized page — no host content is ever mutated.
//
// Integrate once in the host site's scripts.js (e.g. inside loadLazy):
//
//   import injectHreflang from '/tools/apps/meridian/integration/hreflang.js';
//   injectHreflang();
//
// It is safe to call unconditionally: it no-ops when the current page isn't in a
// cluster, when the index is absent, or if called more than once.

function currentPath() {
  return window.location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
}

// The cluster whose members include the current path (source or a localized
// variant), so a visitor on any page in the set gets the full alternate list.
function findCluster(clusters, path) {
  return Object.values(clusters || {}).find(
    (locales) => Object.values(locales).some((href) => href === path),
  );
}

export default async function injectHreflang(indexUrl = '/meridian/hreflang.json') {
  try {
    // Idempotent: never inject twice (e.g. eager + lazy both calling it).
    if (document.head.querySelector('link[data-meridian-hreflang]')) return;
    const resp = await fetch(indexUrl);
    if (!resp.ok) return;
    const { clusters } = await resp.json();
    const cluster = findCluster(clusters, currentPath());
    if (!cluster) return;
    const frag = document.createDocumentFragment();
    Object.entries(cluster).forEach(([hreflang, href]) => {
      const link = document.createElement('link');
      link.setAttribute('rel', 'alternate');
      link.setAttribute('hreflang', hreflang);
      link.setAttribute('href', new URL(href, window.location.origin).href);
      link.setAttribute('data-meridian-hreflang', '');
      frag.appendChild(link);
    });
    document.head.appendChild(frag);
  } catch (e) {
    // Non-fatal: hreflang is an enhancement and must never block the page.
    // eslint-disable-next-line no-console
    console.warn('Meridian hreflang injection skipped:', e.message);
  }
}

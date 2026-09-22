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

// meridian-worker — taste-queue bookkeeping for gated propagations (PRD §6),
// mirroring the publish-requests-worker shape. Identity is the caller's IMS
// token (forwarded to DA); DA stays the single source of truth — the queue and
// /live variants are DA files, so there is no parallel content store (PRD §11).
//
//   GET  /api/queue?org=&site=            list pending taste-queue items
//   POST /api/queue/approve  {org,site,locale,canonicalId}          publish + dequeue
//   POST /api/queue/reject   {org,site,locale,canonicalId,reason}   dequeue with reason
//
// The gated publish runs under the approver's forwarded session, exactly like
// publish-requests-inbox — the worker never holds a service credential.

const DA_ORIGIN = 'https://admin.da.live';
const BASE = '/meridian';
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

const ALLOWED_ORIGINS = new Set(['https://da.live', 'http://localhost:3000']);
// The app also runs from its own edge iframe (…--meridian--<org>.aem.live/.page),
// so allow any Meridian app origin in addition to the static allow-list.
const MERIDIAN_ORIGIN = /^https:\/\/[a-z0-9-]+--meridian--[a-z0-9-]+\.aem\.(live|page)$/;

function allowOrigin(origin) {
  return origin && (ALLOWED_ORIGINS.has(origin) || MERIDIAN_ORIGIN.test(origin));
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': allowOrigin(origin) ? origin : 'https://da.live',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

function assertLocale(locale) {
  if (typeof locale !== 'string' || !SAFE_SEGMENT.test(locale)) throw new Error('Unsafe locale');
}

function assertCanonicalId(id) {
  if (typeof id !== 'string' || !id.startsWith('canon/')
    || id.split('/').some((s) => !SAFE_SEGMENT.test(s))) throw new Error('Unsafe canonicalId');
}

const rel = (id) => id.replace(/^canon\//, '');
const queuePath = (locale, id) => `${BASE}/taste-queue/${locale}/${rel(id)}.json`;
const livePath = (locale, id) => `${BASE}/live/${locale}/${rel(id)}.json`;

function daUrl(org, site, path) {
  return `${DA_ORIGIN}/source/${org}/${site}${path}`;
}

async function daGet(org, site, path, token) {
  const res = await fetch(daUrl(org, site, path), {
    headers: { Authorization: token },
    cf: { cacheTtl: 0 },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DA read ${path} failed (${res.status})`);
  return res.json();
}

async function daPut(org, site, path, value, token) {
  const body = new FormData();
  body.append('data', new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const res = await fetch(daUrl(org, site, path), { method: 'PUT', headers: { Authorization: token }, body });
  if (!res.ok) throw new Error(`DA write ${path} failed (${res.status})`);
}

async function daDelete(org, site, path, token) {
  const res = await fetch(daUrl(org, site, path), { method: 'DELETE', headers: { Authorization: token } });
  if (!res.ok && res.status !== 404) throw new Error(`DA delete ${path} failed (${res.status})`);
}

// Walk /meridian/taste-queue via the DA list API and return every queued item.
async function listQueue(org, site, token) {
  const items = [];
  const walk = async (path) => {
    const res = await fetch(`${DA_ORIGIN}/list/${org}/${site}${path}`, { headers: { Authorization: token } });
    if (!res.ok) return;
    const entries = await res.json();
    await Promise.all(entries.map(async (entry) => {
      const child = `${path}/${entry.name}`;
      const isFolder = !entry.ext && !entry.name.includes('.');
      if (isFolder) {
        await walk(child);
      } else if (entry.name.endsWith('.json')) {
        const item = await daGet(org, site, child, token).catch(() => null);
        if (item) items.push(item);
      }
    }));
  };
  await walk(`${BASE}/taste-queue`);
  return items;
}

async function handleList(url, token, request) {
  const org = url.searchParams.get('org');
  const site = url.searchParams.get('site');
  if (!org || !site) return json({ error: 'org and site are required' }, 400, request);
  const items = await listQueue(org, site, token);
  return json({ items }, 200, request);
}

async function handleApprove(payload, token, request) {
  const {
    org, site, locale, canonicalId,
  } = payload;
  assertLocale(locale);
  assertCanonicalId(canonicalId);
  const item = await daGet(org, site, queuePath(locale, canonicalId), token);
  if (!item) return json({ error: 'No pending item' }, 404, request);
  // Materialized variant was computed at gate time and stored on the item;
  // approving promotes it to /live and clears the queue entry.
  await daPut(org, site, livePath(locale, canonicalId), item.variant, token);
  await daDelete(org, site, queuePath(locale, canonicalId), token);
  return json({ approved: true, locale, canonicalId }, 200, request);
}

async function handleReject(payload, token, request) {
  const {
    org, site, locale, canonicalId, reason,
  } = payload;
  assertLocale(locale);
  assertCanonicalId(canonicalId);
  if (!reason) return json({ error: 'A reason is required' }, 400, request);
  const item = await daGet(org, site, queuePath(locale, canonicalId), token);
  if (!item) return json({ error: 'No pending item' }, 404, request);
  await daDelete(org, site, queuePath(locale, canonicalId), token);
  // Rejection reason is returned for the client to surface / notify on.
  return json({
    rejected: true, locale, canonicalId, reason,
  }, 200, request);
}

// ---- Translation proxy (language layer) -------------------------------------
// Keeps provider API keys server-side and avoids browser CORS. Provider order:
// DeepL (DEEPL_KEY) -> Google Cloud v2 (GOOGLE_API_KEY) -> Google's keyless
// endpoint. Any 3rd-party MT can be dropped in the same way. Per-string failures
// fall back to the source text (partial coverage), never crashing the batch.
async function runLimited(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx;
      idx += 1;
      // eslint-disable-next-line no-await-in-loop -- sequential worker = the concurrency gate
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Keyless default. Google's gtx endpoint 429s Cloudflare egress IPs, so we use
// MyMemory (free, no key, server-side friendly). For production volume set
// DEEPL_KEY or GOOGLE_API_KEY; a per-string failure falls back to source text.
async function translateFree(strings, from, to) {
  return runLimited(strings, 3, async (text) => {
    try {
      const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`;
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return text;
      const data = await r.json();
      const t = data?.responseData?.translatedText;
      if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) return text;
      return t;
    } catch {
      return text;
    }
  });
}

async function translateGoogleV2(strings, from, to, key) {
  const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      q: strings, source: from, target: to, format: 'text',
    }),
  });
  if (!r.ok) throw new Error(`Google Translate v2 failed (${r.status})`);
  const data = await r.json();
  return (data?.data?.translations || []).map((t, i) => t?.translatedText ?? strings[i]);
}

async function translateDeepL(strings, to, key) {
  const params = new URLSearchParams();
  strings.forEach((s) => params.append('text', s));
  params.set('target_lang', to.split('-')[0].toUpperCase());
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const r = await fetch(`${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!r.ok) throw new Error(`DeepL failed (${r.status})`);
  const data = await r.json();
  return (data?.translations || []).map((t, i) => t?.text ?? strings[i]);
}

// The /translate route does not forward the token to DA (it calls an MT
// provider), so — unlike the queue routes — an invalid token would otherwise go
// unnoticed, turning the endpoint into an open relay that burns the configured
// provider's paid quota. Require the caller to actually have DA access to the
// named site before honoring it.
async function daAuthorized(token, org, site) {
  if (!token || !SAFE_SEGMENT.test(org || '') || !SAFE_SEGMENT.test(site || '')) return false;
  try {
    const r = await fetch(`${DA_ORIGIN}/list/${org}/${site}/`, { headers: { Authorization: token } });
    return r.ok;
  } catch {
    return false;
  }
}

async function handleTranslate(payload, request, env) {
  const {
    strings, from = 'en', to, org, site, provider = 'auto',
  } = payload || {};
  if (!Array.isArray(strings) || !strings.length) return json({ error: 'strings[] required' }, 400, request);
  if (!to || typeof to !== 'string') return json({ error: 'target locale (to) required' }, 400, request);
  if (strings.length > 200) return json({ error: 'too many strings (max 200 per call)' }, 400, request);
  const totalLen = strings.reduce((n, s) => n + (typeof s === 'string' ? s.length : 0), 0);
  if (totalLen > 20000) return json({ error: 'payload too large (max 20k chars)' }, 400, request);
  if (!(await daAuthorized(request.headers.get('Authorization'), org, site))) {
    return json({ error: 'Unauthorized: a valid DA token with access to org/site is required' }, 401, request);
  }
  // Explicit provider overrides the fallback chain; 'auto' (or omitted/unknown)
  // keeps the existing DeepL -> Google -> free order. `used` reports what ran.
  let translations;
  let used;
  if (provider === 'deepl') {
    if (!env?.DEEPL_KEY) {
      return json({ error: 'deepl provider requires DEEPL_KEY' }, 400, request);
    }
    translations = await translateDeepL(strings, to, env.DEEPL_KEY);
    used = 'deepl';
  } else if (provider === 'google') {
    if (!env?.GOOGLE_API_KEY) {
      return json({ error: 'google provider requires GOOGLE_API_KEY' }, 400, request);
    }
    translations = await translateGoogleV2(strings, from, to, env.GOOGLE_API_KEY);
    used = 'google';
  } else if (provider === 'free') {
    translations = await translateFree(strings, from, to);
    used = 'free';
  } else if (env?.DEEPL_KEY) {
    translations = await translateDeepL(strings, to, env.DEEPL_KEY);
    used = 'deepl';
  } else if (env?.GOOGLE_API_KEY) {
    translations = await translateGoogleV2(strings, from, to, env.GOOGLE_API_KEY);
    used = 'google';
  } else {
    translations = await translateFree(strings, from, to);
    used = 'free';
  }
  return json({
    from, to, provider: used, translations,
  }, 200, request);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const token = request.headers.get('Authorization');
    if (!token) return json({ error: 'Authorization required' }, 401, request);

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/api/queue') {
        return await handleList(url, token, request);
      }
      if (request.method === 'POST' && url.pathname === '/api/queue/approve') {
        return await handleApprove(await request.json(), token, request);
      }
      if (request.method === 'POST' && url.pathname === '/api/queue/reject') {
        return await handleReject(await request.json(), token, request);
      }
      if (request.method === 'POST' && url.pathname === '/translate') {
        return await handleTranslate(await request.json(), request, env);
      }
      return json({ error: 'Not found' }, 404, request);
    } catch (e) {
      return json({ error: e.message }, 500, request);
    }
  },
};

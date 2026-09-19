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

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://da.live',
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

export default {
  async fetch(request) {
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
      return json({ error: 'Not found' }, 404, request);
    } catch (e) {
      return json({ error: e.message }, 500, request);
    }
  },
};

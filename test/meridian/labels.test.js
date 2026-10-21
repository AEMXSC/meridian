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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_LABEL, RISK_LABEL, RISK_TIP, describeCell, resultBadge,
} from '../../tools/apps/meridian/core/labels.js';

const PAGE = { coverage: { ratio: 0.82 } };

test('resultBadge names the publish state in plain words', () => {
  assert.equal(resultBadge({ ...PAGE, kind: 'staged' }), 'In review — publish when ready');
  assert.equal(resultBadge({ ...PAGE, kind: 'live' }), 'Published');
});

test('resultBadge says Published once a staged page has been published (no contradiction)', () => {
  assert.equal(resultBadge({ ...PAGE, kind: 'staged', promoted: true }), 'Published');
  assert.equal(resultBadge({ ...PAGE, kind: 'staged', promoted: false }), 'In review — publish when ready');
});

test('resultBadge shows translation coverage, and translation-memory share when present', () => {
  assert.equal(resultBadge({ ...PAGE, kind: 'translate' }), 'Translated 82%');
  assert.equal(
    resultBadge({ ...PAGE, kind: 'translate', memory: 40 }),
    'Translated 82% · 40% from memory',
  );
});

test('resultBadge reports localize progress as held segments EDITED (a count of authored segments), not "market 2/3"', () => {
  assert.equal(
    resultBadge({
      ...PAGE, kind: 'localize', heldDone: 2, heldTotal: 3,
    }),
    'Translated 82% · 2 of 3 held segments edited',
  );
  assert.equal(
    resultBadge({
      ...PAGE, kind: 'localize', heldDone: 0, heldTotal: 3, memory: 10,
    }),
    'Translated 82% · 0 of 3 held segments edited · 10% from memory',
  );
});

test('resultBadge copes with a result that has no coverage yet', () => {
  assert.equal(resultBadge({ kind: 'translate' }), 'Translated 0%');
});

test('describeCell: the chip is the PUBLISH state and freshness is a separate flag', () => {
  assert.deepEqual(
    (({ label, cls, changed }) => ({ label, cls, changed }))(describeCell({ stage: 'live', fresh: 'current' })),
    { label: 'Published', cls: 'current', changed: false },
  );
  assert.deepEqual(
    (({ label, cls, changed }) => ({ label, cls, changed }))(describeCell({ stage: 'staged', fresh: 'current' })),
    { label: 'In review', cls: 'staged', changed: false },
  );
  // Stale does not change the publish chip; it only raises the flag.
  const live = describeCell({ stage: 'live', fresh: 'stale' });
  assert.equal(live.label, 'Published');
  assert.equal(live.changed, true);
  const staged = describeCell({ stage: 'staged', fresh: 'stale' });
  assert.equal(staged.label, 'In review');
  assert.equal(staged.changed, true);
});

test('describeCell: an unlocalized cell is an empty placeholder with no freshness flag', () => {
  const d = describeCell({ stage: 'none', fresh: 'missing' });
  assert.equal(d.label, '—');
  assert.equal(d.cls, 'missing');
  assert.equal(d.changed, false);
  assert.equal(d.tip, 'Not localized');
});

test('describeCell tooltips carry the date when known and explain a changed source', () => {
  const d = describeCell({ stage: 'live', fresh: 'stale' }, ' (Oct 5, 2026)');
  assert.match(d.tip, /^Published \(Oct 5, 2026\)\./);
  assert.match(d.tip, /source changed after this was localized/i);
  assert.doesNotMatch(describeCell({ stage: 'live', fresh: 'current' }).tip, /source changed/i);
});

test('freshness labels use "source changed" wording and never publish-state words', () => {
  assert.deepEqual(RISK_LABEL, {
    current: 'Up to date', stale: 'Source changed', missing: 'Not localized',
  });
  assert.equal(RISK_TIP.stale.includes('locale'), true);
  assert.equal(RISK_TIP.missing, 'This locale has no localized page yet.');
});

test('stage labels match the publish vocabulary', () => {
  assert.deepEqual(STAGE_LABEL, { live: 'Published', staged: 'In review', none: 'Not localized' });
});

test('vocabulary guard: no retired wording anywhere in the label set', () => {
  const retired = /promot|\bstaged\b|update due|\bmarkets?\b/i;
  const cells = [
    { stage: 'none', fresh: 'missing' },
    { stage: 'staged', fresh: 'current' },
    { stage: 'staged', fresh: 'stale' },
    { stage: 'live', fresh: 'current' },
    { stage: 'live', fresh: 'stale' },
  ].flatMap((c) => {
    const d = describeCell(c, ' (Oct 5, 2026)');
    return [d.label, d.tip];
  });
  const badges = ['translate', 'staged', 'live', 'localize'].map((kind) => resultBadge({
    ...PAGE, kind, heldDone: 1, heldTotal: 2, memory: 5,
  }));
  [
    ...cells, ...badges, ...Object.values(RISK_LABEL), ...Object.values(RISK_TIP),
    ...Object.values(STAGE_LABEL),
  ].forEach((text) => assert.doesNotMatch(text, retired, `retired wording in: ${text}`));
});

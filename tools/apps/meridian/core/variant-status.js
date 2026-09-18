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

// Per-market status cue for the queue and the editor plugin — the visual
// indicator authors asked for ("scheduled / in review" today shows nothing).
// Reuses MSM's status-icon vocabulary (core/status.js getStatusConfig) so
// Meridian reads as visually consistent with the rest of Experience Workspace.
// Derived purely from a market's exposure findings.

const GREEN = { name: 'S2_Icon_CheckmarkCircle_20_N', color: 'var(--s2-green-700,#0ba45d)' };
const AMBER = { name: 'S2_Icon_AlertTriangle_20_N', color: 'var(--s2-yellow-700,#e68619)' };
const RED = { name: 'S2_Icon_AlertDiamond_20_N', color: 'var(--s2-red-700,#ff513d)' };

/**
 * Roll a market's findings up to a single status chip.
 * @param {import('./schemas.js').ExposureFinding[]} findings - findings for one locale
 * @returns {{ level: 'critical'|'warning'|'ok', name: string, color: string, tip: string }}
 */
export default function variantStatus(findings) {
  if (findings.some((f) => f.severity === 'critical')) {
    return { level: 'critical', ...RED, tip: 'Publish gated — needs attention' };
  }
  if (findings.some((f) => f.severity === 'warning')) {
    return { level: 'warning', ...AMBER, tip: 'Review recommended' };
  }
  return { level: 'ok', ...GREEN, tip: 'Current' };
}

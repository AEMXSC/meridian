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

// DEMO ONLY. Boots the real in-editor reference panel against the shared mock
// DA, scoped to one page, so the concept is viewable on GitHub Pages without a
// live editor session. Reuses the app demo's in-memory DA (same fetch seam).
/* eslint-disable no-underscore-dangle */
import installDemo from '../../../apps/meridian/demo/mock-da.js';

const demo = await installDemo();
demo.details = { path: '/personal-banking' };
window.__MERIDIAN_DEMO__ = demo;
await import('../meridian.js');

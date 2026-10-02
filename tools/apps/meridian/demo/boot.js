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

// DEMO ONLY. Installs the in-memory DA + fake context, then loads the real app.
// Order matters: the global and the fetch seam must be set BEFORE meridian.js's
// init() runs on import, so the app boots straight into the seeded project.
/* eslint-disable no-underscore-dangle */
import installDemo from './mock-da.js';

window.__MERIDIAN_DEMO__ = await installDemo();
await import('../meridian.js');

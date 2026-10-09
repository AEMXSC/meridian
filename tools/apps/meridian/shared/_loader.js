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

// Minimal stylesheet loader for the shared components ported from
// adobe-rnd/ew-extensions (blocks/skills/shared). Fetches the component's
// sibling .css and returns an adoptable CSSStyleSheet; a fetch failure yields an
// empty sheet so the component still renders (unstyled) rather than throwing.
export async function loadStyle(url) {
  const cssUrl = String(url).replace(/\.js(\?.*)?$/, '.css');
  const sheet = new CSSStyleSheet();
  try {
    const res = await fetch(cssUrl);
    if (res.ok) sheet.replaceSync(await res.text());
  } catch { /* leave empty */ }
  return sheet;
}

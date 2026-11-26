# Instructions for future LLMs — Google Darkest Fusion

These instructions apply when editing **`clip-20261126-000706.txt`**, the large Stylus/UserCSS-style stylesheet in this repository.

## Source of truth

- File: [`clip-20261126-000706.txt`](clip-20261126-000706.txt)
- It is a UserStyle with a `/* ==UserStyle== */` metadata header and uses the **Less** preprocessor.
- The `@var color backgroundGlobalColor` setting is the shared page-background color. Its declared default is **`#1C1C1C`**.
- The stylesheet is large and contains many site-specific `@-moz-document` sections plus Less conditionals. Preserve that structure.

Do not replace this file with a simplified stylesheet or reformat the whole source just to make a small change. Make the smallest targeted edit that accomplishes the request.

## Non-negotiable behavior

### 1. Do not override border radii

The intended behavior is to let Google determine its own border radii.

- There must be **no** `border-radius`, `border-top-left-radius`, `border-top-right-radius`, `border-bottom-left-radius`, or `border-bottom-right-radius` declarations in the stylesheet.
- Do not add a border-radius setting, variable, toggle, global reset, or replacement rule.
- Do not set radii to `0`, `revert`, `unset`, or a custom value. The correct way to preserve Google's radii is to leave them alone.

### 2. Never style descendants of `#gp-gbar-inner`

The user explicitly wants Google-provided elements inside `#gp-gbar-inner` excluded from **all stylesheet changes**, so their native Google styling remains intact.

The current file applies this guard to ordinary CSS selector branches:

```css
:not(#gp-gbar-inner *)
```

When adding or changing a rule:

- Add the guard to **every comma-separated selector branch**, not just the first branch.
- Keep the guard on the element selector, before a pseudo-element (for example, `.example:not(#gp-gbar-inner *)::before`).
- Do not add unguarded broad selectors such as `*`, `#gb *`, or `[class^="gb_"]` that can reach into the protected descendants.
- Do not try to solve this with `all: revert` or a blanket reset on `#gp-gbar-inner *`. Such a reset can itself disrupt Google's built-in styling.
- Less directives and at-rules (such as `@-moz-document` and `& when (...)`) are structural syntax, not ordinary selector branches; preserve them rather than blindly appending selector text to them.

**Specificity caution:** the current `:not(#gp-gbar-inner *)` guard is not zero-specificity. Its argument contains an ID selector, so it contributes ID-level specificity. Do not claim otherwise. If considering a migration to a zero-specificity guard such as `:where(:not(#gp-gbar-inner *))`, assess the impact on cascade behavior and the considerable source-size increase before changing thousands of occurrences. Do not perform a blind global replacement.

### 3. Keep the Google Search top strip the same color as the main page

The top strip is layered; changing only its outer container is insufficient. The source has separate backgrounds for the search-form container and inner/header layers.

The target color is the shared `@backgroundGlobalColor` variable (default `#1C1C1C`), not a hard-coded `#161616`.

The two explicit search-form state rules must continue to use that variable:

- Expanded: `#searchform.CvDJxb.big:not(.minidiv)`
- Compact/sticky: `#searchform.CvDJxb.big.minidiv`

The final, page-scoped correction is intentionally placed at the **end of the last broad Google-page `@-moz-document` section**, so it wins over earlier conflicting rules. It covers these layers:

- `#searchform`
- `#searchform .sfbg` and the search-form `.sfbg` variants
- `#gb` and its banner form

Keep the background declaration as:

```less
background-color: @backgroundGlobalColor !important;
```

Keep the `#gp-gbar-inner` exclusion on every selector in this correction too. Do not change the whole Google header to `#161616`; that was the mismatch visible in the user's screenshot.

## Why the search-header fix needs multiple selectors

Google Search paints the upper region through more than one element. The search form, the `.sfbg` background layer, and the Google bar/banner can each have their own background declaration. A correction on `#searchform` alone may leave a visible strip at `#161616`. When the user reports a remaining color mismatch, inspect the actual painted layers and all later matching rules before adding another override.

The existing final correction is in the broad Google-page scope, not a global rule for unrelated Google products. Preserve that scope unless the user explicitly asks for a wider change.

## Safe editing and verification procedure

1. Fetch and inspect the **complete current file** before editing. Confirm the response contains non-empty source and record its blob SHA. An empty/truncated fetch is not a valid source for a write.
2. Identify the relevant `@-moz-document` scope and inspect later rules that can override the target. Remember that source order matters.
3. Keep the edit narrow. Do not change userstyle variables, unrelated product sections, images, icons, filters, colors, or Less conditionals unless asked.
4. Before writing, verify:
   - no border-radius declarations remain;
   - every newly added selector branch excludes `#gp-gbar-inner *`;
   - both search-form states still use `@backgroundGlobalColor`;
   - the final Search-header correction still covers `#searchform`, `.sfbg`, and `#gb`/banner;
   - Less and `@-moz-document` braces remain balanced.
5. After writing, fetch the file again using the **new commit SHA** and verify that the returned content is non-empty and contains the intended changes. Do not rely only on the write tool's success response.
6. Distinguish source-level checks from browser testing. Unless the modified style has actually been loaded in a browser and visually checked, say that live visual verification is still pending.

## Current known state

At the time this document was added:

- All 13 prior border-radius declarations had been removed; the source check found zero remaining border-radius declarations.
- Ordinary stylesheet selector branches had been guarded against descendants of `#gp-gbar-inner`.
- Both explicit `#searchform` state rules used `@backgroundGlobalColor`.
- A final correction at the end of the broad Google-page scope applied `@backgroundGlobalColor` to `#searchform`, its `.sfbg` layers, and `#gb`/banner.
- The source was checked after the latest commit, but the user's browser still needs to be used for final visual confirmation.

**User intent takes priority over cosmetic simplification:** preserve Google's native UI inside `#gp-gbar-inner`, preserve native Google border radii, and make the Search top strip visually match the main page background.

# Instructions for future LLMs — Google Darkest Fusion

These instructions apply when editing **`clip-20261126-000706.txt`**, the large Stylus/UserCSS-style stylesheet in this repository.

## Source of truth

- File: [`clip-20261126-000706.txt`](clip-20261126-000706.txt)
- It is a UserStyle with a `/* ==UserStyle== */` metadata header and uses the **Less** preprocessor.
- The `@var color backgroundGlobalColor` setting is the shared page-background color. Its declared default is **`#1C1C1C`**.
- The stylesheet is large and contains many site-specific `@-moz-document` sections plus Less conditionals. Preserve that structure.

Do not replace this file with a simplified stylesheet or reformat the whole source just to make a small change. Make the smallest targeted edit that accomplishes the request.

## Non-negotiable behavior

### 1. Remove border-radius rules and preserve native defaults

The intended behavior is to preserve Google's **original/default border radii**. The stylesheet must not set, reset, normalize, or otherwise override them.

**Required cleanup — remove existing rules, not just avoid adding new ones:**

- Search the complete stylesheet, including every `@-moz-document` scope and Less conditional, and **delete every declaration** for `border-radius`, `border-top-left-radius`, `border-top-right-radius`, `border-bottom-left-radius`, or `border-bottom-right-radius`. Also remove vendor-prefixed equivalents such as `-webkit-border-radius` or `-moz-border-radius`, if present.
- Remove those declarations even when they are old, redundant, scoped to a rarely used page, or currently inactive.
- If a rule contains other declarations, keep those other declarations and remove only the radius declaration. Remove the whole rule only when it becomes empty.
- **Preserve the defaults by leaving the properties undeclared.** Do not replace a removed declaration with `0`, `none`, `initial`, `inherit`, `revert`, `unset`, or any custom radius. Do not add a global reset or a new rule intended to force a particular radius.
- Do not add a border-radius setting, variable, or toggle.

The expected result is **zero border-radius declarations** in the complete stylesheet, allowing Google's own styles (and normal browser defaults where applicable) to determine the shape of each element.

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
**Critical selector-syntax warning — pseudo-elements (`::before` / `::after`)**

The `:not(#gp-gbar-inner *)` guard is a **pseudo-class on the element**, not a pseudo-element. It must be inserted into the element's compound selector **before** the pseudo-element token.

Valid:

```css
.example:not(#gp-gbar-inner *)::before { ... }
.example:hover:not(#gp-gbar-inner *)::after { ... }
```

Invalid — these forms corrupt the pseudo-element syntax, so the selector no longer matches:

```css
.example::not(#gp-gbar-inner *):before
.example::not(#gp-gbar-inner *):after
```

**Never insert the guard by blindly searching for the last colon or by inserting it immediately after a detected `::`.** A naive selector-string rewrite can split the pseudo-element token and turn a valid `::before` / `::after` selector into an invalid `::not(...):before` / `::not(...):after` selector. This can silently disable rules that paint backgrounds, overlays, borders, and other visible UI; the page may fall back to Google's white defaults.

When adding guards programmatically:

- Split selector lists only on **top-level commas**, outside brackets, parentheses, strings, and comments.
- Parse each selector branch and identify the pseudo-element token (`::before`, `::after`, `::first-line`, `::first-letter`, `::selection`, etc.; also account for legacy single-colon spellings such as `:before`).
- Insert `:not(#gp-gbar-inner *)` on the originating element, immediately **before** the pseudo-element token. Preserve existing pseudo-classes and their arguments.
- Do not append guards to at-rules, Less directives, or structural syntax.

**Mandatory post-edit checks:**

- Search the complete stylesheet for the malformed pattern `::not(#gp-gbar-inner *)`; the expected count is **zero**.
- Inspect every guarded pseudo-element selector and confirm its shape is `:not(#gp-gbar-inner *)::before` / `:not(#gp-gbar-inner *)::after`, never `::not(...):before` / `::not(...):after`.
- Parse or compile the complete UserStyle after selector rewriting; balanced braces alone do not prove selectors are valid.
- If a large automated guard migration is necessary, test representative pseudo-elements and confirm the generated selectors before applying it to the entire file.

**Regression history (2026-11-27):** a bulk guard insertion incorrectly positioned the guard in **386 pseudo-element selectors** (261 `::before`, 125 `::after`). Those selectors stopped matching and contributed to Google surfaces falling back to white. The selectors were repaired by moving the guard back onto the originating element, before the pseudo-element. The repaired stylesheet was fetched after commit and verified to contain zero `::not(#gp-gbar-inner *)` patterns. This incident is a permanent warning against blind colon-based selector rewriting.


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

- A historical source check at the time this note was written found zero remaining border-radius declarations after removing 13 known declarations. Treat that as a historical result only: always scan the complete current target file again, because later edits or a different stylesheet copy may reintroduce radius declarations.
- Ordinary stylesheet selector branches had been guarded against descendants of `#gp-gbar-inner`.
- Both explicit `#searchform` state rules used `@backgroundGlobalColor`.
- A final correction at the end of the broad Google-page scope applied `@backgroundGlobalColor` to `#searchform`, its `.sfbg` layers, and `#gb`/banner.
- The source was checked after the latest commit, but the user's browser still needs to be used for final visual confirmation.

**User intent takes priority over cosmetic simplification:** preserve Google's native UI inside `#gp-gbar-inner`, preserve native Google border radii, and make the Search top strip visually match the main page background.


## Additional fixes: `.xrOgrb` and `--YLNNHc`

The later shared `#161616` background selector group included `.xrOgrb`, but this particular surface must be `#1C1C1C`.

- Keep `.xrOgrb:not(#gp-gbar-inner *)` **out of** the shared `#161616` selector group.
- Give it its own rule, placed after the shared dark group / near the final Google Search background corrections:

```css
.xrOgrb:not(#gp-gbar-inner *) {
    background-color: #1C1C1C !important;
}
```

Google's `--YLNNHc` token is used as a dark primary-text color in some Google interfaces. The stylesheet should turn that token white only within the main content roots, rather than changing it on `:root` (a root-level custom-property change would inherit into the protected Google bar).

Use this scoped Less/CSS rule:

```css
.main:not(#gp-gbar-inner *),
#main:not(#gp-gbar-inner *) {
    --YLNNHc: #fff !important;
}
```

Keep the `#gp-gbar-inner` exclusion on both selector branches. Do not broaden this to `:root`, `html`, or `body` without explicitly checking inheritance into the protected Google bar. If a future page places its `#gp-gbar-inner` inside one of these main containers, choose a more specific content root that does not contain it.

Historical source-level checks at that point: `.xrOgrb` was no longer in the `#161616` group; it had a separate `#1C1C1C` rule; the `--YLNNHc` override was scoped to `.main` and `#main`; the checked source contained no border-radius declarations; and the existing Google-bar selector exclusions were present. Re-run the complete border-radius scan on the current target file before relying on that historical result.


## Global shade normalization: `#161616` → `#1C1C1C`

The user wants **every occurrence** of the exact color literal `#161616` in this stylesheet changed to `#1C1C1C`.

This is a stylesheet-wide normalization, not just a search-header fix. It applies wherever the literal appears: backgrounds, text colors, border colors, SVG fills, gradients, and other CSS color values.

Rules for future edits:

- Do not introduce new `#161616` declarations or color values.
- When importing or editing rules that contain `#161616`, use `#1C1C1C` instead.
- Do not limit this change to `.xrOgrb`, `#searchform`, or one page scope. The intended change covers the entire stylesheet.
- Preserve the Google-bar exclusion on ordinary selectors. This color normalization does not authorize adding unguarded selectors or changing the protected `#gp-gbar-inner` descendants.
- Do not alter other shades such as `#1C1C1C`, `#2C2C2C`, `#3C3C3C`, or `#4C4C4C`.

The source was globally normalized on 2026-11-26: all 51 remaining `#161616` occurrences were replaced with `#1C1C1C`. A post-write fetch confirmed **zero** `#161616` occurrences, while the border-radius removal, `#gp-gbar-inner` exclusions, `.xrOgrb` correction, Search-header correction, and scoped `--YLNNHc` override remained present.

For verification after future edits, search the complete stylesheet for the literal `#161616`; the expected count is zero.

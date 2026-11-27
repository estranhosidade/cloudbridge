// ==UserScript==
// @name            Context Menu Editor — Layout Studio
// @description     WYSIWYG editor for Zen/Firefox context menus: reorder, rename,
//                  hide, inspect, search and take full control of menu layouts,
//                  including extension-created context-menu entries.
//                  Uses the existing __menuEngine + menu-config.json contract.
// @include         main
// @version         2.6.7
// @compatibility   Zen Browser (primary); Firefox 100+ (shared fallback IDs)
// ==/UserScript==

(function contextMenuEditorStudio() {
  "use strict";

  // ===========================================================================
  // DESIGN
  // ===========================================================================
  //
  // The editor has one job:
  //
  //     LIVE FIREFOX MENU
  //           ↓
  //     normalized rows
  //           ↓
  //     user commands
  //           ↓
  //     menu-config.json
  //
  // The saved config is the persistent model. This script applies custom order,
  // visibility, and labels directly to Firefox's live XUL menu nodes; if a
  // compatible __menuEngine exists, Save also asks it to reload its config.
  // Sorting the editor rows alone is not enough to reorder the native popup.
  //
  // Existing config fields are preserved:
  //
  //   menus.<menuId>.reorder
  //   menus.<menuId>.entries[]
  //   menus.<menuId>.pinnedTail[]
  //   menus.<menuId>.childOrders[]
  //
  // Each entry may contain:
  //
  //   selector, label, hidden, separator, originalLabel, parentSelector
  //
  // "label" is a single title. Older configs used an "en"/"pt" pair; those are
  // migrated to "label" on load, keeping the column for the running locale.
  //
  // "originalLabel" records the title an item carried before its first rename.
  // It is never applied to the menu — it exists purely so the default name
  // stays searchable after a custom one has replaced it on screen.
  //
  // "parentSelector" is optional structural metadata for saved submenu items.
  // It lets a dynamically hidden/lazy submenu retain its child rules after a
  // restart, without guessing the hierarchy from a stale DOM snapshot.
  //
  // Nothing is written until Save.

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  const CONFIG = Object.freeze({
    path: "chrome/JS/menu-config.json",
    // Where "Export" drops its bundle. Kept beside the real config so it is
    // obvious the two belong together and easy to find in a file manager.
    exportPath: "chrome/JS/menu-config.export.json",
    exportFormat: "context-menu-editor/export@1",
    panelId: "context-menu-editor-panel",
    styleId: "context-menu-editor-panel-style",
    version: 2,
    historyLimit: 80,
    maxMenuWidth: 320,
    // Defensive bounds for a hand-edited or corrupted menu-config.json.
    maxConfigChars: 4 * 1024 * 1024,
    maxMenus: 200,
    maxBackups: 30,
    shortcuts: Object.freeze({
      toggle: Object.freeze({
        key: "KeyE",
        ctrl: true,
        shift: true,
        alt: false,
        meta: false,
      }),
      // Ctrl+W (Cmd+W on macOS) closes the panel.
      //
      // This has to be preventDefault()ed or Firefox closes the TAB first, which
      // is unrecoverable from a userscript — so the handler consumes it and calls
      // stopPropagation() as well, to stop the browser-level default from ever
      // running.
      close: Object.freeze({
        key: "KeyW",
        ctrl: true,
        shift: false,
        alt: false,
        // Accept Cmd on macOS, where Ctrl+W is not the conventional close chord.
        meta: true,
      }),
      // Ctrl+F / Cmd+F toggles the find minibar.
      //
      // A toggle rather than a one-way open, so the same chord both summons and
      // dismisses the field — which is what every find bar in a browser does, and
      // means the user never has to reach for the mouse to get out of it.
      find: Object.freeze({
        key: "KeyF",
        ctrl: true,
        shift: false,
        alt: false,
        // Cmd on macOS, where Ctrl+F is not the conventional find chord.
        meta: true,
      }),
      // Ctrl+Z / Cmd+Z undoes the last change (rename, drag, hide, reset…).
      //
      // Backing this with the keyboard is the whole point: the undo/redo buttons
      // referenced by id are never actually created in the panel, so without this
      // chord there is NO way to step back — a mis-drag or a bad rename could only
      // be undone by reloading the config from disk. undo()/redo() already drive
      // the history stack, the save/dirty state and the re-render; this just gives
      // them a key.
      undo: Object.freeze({
        key: "KeyZ",
        ctrl: true,
        shift: false,
        alt: false,
        // Cmd on macOS, where Ctrl+Z is not the conventional undo chord.
        meta: true,
      }),
      // Ctrl+Y / Cmd+Y redoes the last undone change. Ctrl+Shift+Z (the other
      // common redo chord) is accepted by redoShortcutMatches on top of this.
      redo: Object.freeze({
        key: "KeyY",
        ctrl: true,
        shift: false,
        alt: false,
        meta: true,
      }),
    }),
    // These are the three everyday context-menu surfaces in Zen:
    // page content, an actual tab, and the vertical sidebar / browser toolbar.
    // Bookmarks / History remains available below as another real context menu,
    // but it is not one of the three primary browser surfaces.
    primaryMenus: Object.freeze([
      { id: "contentAreaContextMenu", label: "Page / content" },
      { id: "tabContextMenu", label: "Tab strip" },
      { id: "toolbar-context-menu", label: "Sidebar / toolbar" },
    ]),
  });

  // Only genuine context-menu roots belong in the normal picker. The old
  // discovery pass treated every XUL <menu> and <menupopup> as an independent
  // target, so nested submenus (Move Tab, Languages, History, etc.) and the
  // ordinary File / Edit menu-bar popups appeared as if they were context
  // menus in their own right.
  //
  // Keep this as an explicit, conservative list for Firefox/Zen's known roots;
  // newly-added roots can still be discovered through type="context" or a
  // live element's `context` attribute. Existing non-context menus that already
  // have saved rules are preserved separately as "Saved menus" below.
  const CONTEXT_MENU_ROOT_IDS = new Set([
    "contentAreaContextMenu",
    "subFrameContextMenu",
    "tabContextMenu",
    "toolbar-context-menu",
    "placesContext",
    "pageActionContextMenu",
    "downloadsContextMenu",
    "appMenu-contextMenu",
    "unifiedExtensionsContextMenu",
    "unified-extensions-context-menu",
    "permissionContext",
  ]);

  const FALLBACK_MENU_NAMES = Object.freeze({
    "toolbar-context-menu": "Sidebar / toolbar",
    placesContext: "Bookmarks / History",
    pageActionContextMenu: "Page action",
    backForwardMenu: "Back / Forward",
    downloadsContextMenu: "Downloads",
    contentAreaContextMenu: "Page / content",
    tabContextMenu: "Tab strip",
    "appMenu-contextMenu": "Application menu",
    unifiedExtensionsContextMenu: "Extensions",
    "unified-extensions-context-menu": "Extensions",
    customizeWidgetsPanel: "Toolbar customization",
    "customization-toolbar-menu": "Toolbar customization",
    sidebarHistoryMenu: "History sidebar",
    sidebarBookmarksMenu: "Bookmarks sidebar",
    sidebarTabsMenu: "Tabs sidebar",
    sidebarSyncedTabsMenu: "Synced tabs sidebar",
    bookmarkproperties: "Bookmark properties",
    editortoolbar: "Editor toolbar",
    permissionContext: "Permission",
    popupnotification: "Notification",
    subFrameContextMenu: "Sub-frame",
    "appMenu-mainView": "Application menu",
  });

  // Firefox/Zen's hamburger menu is a PanelMultiView panelview, not a menupopup.
  // Keep its main view as one independent surface instead of flattening sibling
  // History, Bookmarks, More Tools, and Help subviews into the same menu.
  const APP_MENU_VIEW_ID = "appMenu-mainView";
  const APP_MENU_PANEL_ID = "appMenu-popup";

  const SEP = n => `sep:${n}`;

  // ===========================================================================
  // STATE
  // ===========================================================================

  const state = {
    config: null,
    activeMenu: CONFIG.primaryMenus[0].id,
    dirty: false,
    panel: null,
    customReferenceDialog: null,
    confirmDialog: null,

    filter: "",
    filterMode: "all", // all | visible | hidden | changed | unmanaged | extension | dormant | unverified
    showIds: false,
    compact: true,
    // Extension and native submenu children stay addressable in the tree, but
    // are rendered only while their parent row is expanded.
    expandedGroups: new Set(),

    // The Ctrl+F find minibar.
    //
    // findOpen drives visibility; findQuery is the live text. findKeys holds the
    // keys of every matching row in list order, and findIndex is the cursor
    // within that list — so "3 of 7" is just findIndex + 1 over findKeys.length.
    //
    // This is deliberately NOT the same mechanism as `filter` above. The filter
    // REMOVES non-matching rows from the list; find keeps every row on screen and
    // merely marks the matches. That difference is the whole point of the
    // minibar: you are looking for one entry in a menu you are still reading, not
    // asking for a filtered subset of it.
    findOpen: false,
    findQuery: "",
    findKeys: [],
    findIndex: -1,

    // The one and only find bar element, built once in buildPanel().
    //
    // It has to outlive individual renders: renderRowsOnly() rebuilds the list
    // header on every pass, and a find bar recreated along with it would drop
    // focus and the caret position on every keystroke that happened to trigger a
    // re-render. So the node is kept here and re-attached to each new header
    // instead of being rebuilt. See mountFindBar().
    findBarEl: null,

    selectedKey: null,
    selectedMenu: null,

    // Every selected row, for multi-select and multi-row drags.
    //
    // selectedKey stays the PRIMARY row: it is what the keyboard acts on and what
    // the existing single-row tests read. selectedKeys is the full set. Keeping
    // both means multi-select never has to redefine "the" selection, it only
    // widens it — a plain click resets the set back to exactly this one key.
    selectedKeys: new Set(),

    // Where a Shift-click extends the selection from. Kept separate from
    // selectedKey because the anchor must survive the click that moves the
    // primary row, otherwise every Shift-click would collapse the range.
    selectionAnchor: null,

    history: [],
    future: [],

    renderQueued: false,
    saveInProgress: false,
    scanning: false,
    startupPromise: null,
    hiddenWatcherInstalled: false,
  };

  // ===========================================================================
  // SERVICES / ENGINE
  // ===========================================================================

  function getServices() {
    if (globalThis.Services) return globalThis.Services;

    try {
      return ChromeUtils.importESModule(
        "resource://gre/modules/Services.sys.mjs"
      ).Services;
    } catch (_) {
      return null;
    }
  }

  const Services = getServices();

  function engine() {
    return globalThis.__menuEngine || null;
  }

  // ===========================================================================
  // GENERIC HELPERS
  // ===========================================================================

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeCss(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));

    return String(value).replace(/([^\w-])/g, "\\$1");
  }

  function text(value) {
    return String(value ?? "");
  }

  function trim(value) {
    return text(value).trim();
  }

  function isSeparatorSelector(selector) {
    return /^sep:\d+$/.test(text(selector));
  }

  function isInputLike(node) {
    return /^(input|textarea|select)$/i.test(node?.localName || "");
  }

  // Most Firefox context-menu entries have an id. For the handful that do not,
  // use a namespaced data attribute as a stable selector instead of
  // menuitem[label="..."] (which can point at several different entries).
  // The key is attached to the XUL node only; it is not written into Firefox's
  // profile or into the menu-config JSON as anything other than a selector.
  const ANONYMOUS_KEY_ATTR = "data-context-menu-editor-key";

  function isApplicationMenu(menuId) {
    return text(menuId) === APP_MENU_VIEW_ID;
  }

  function isMenuSeparatorNode(node, menuId = "") {
    const name = String(node?.localName || "").toLowerCase();
    return name === "menuseparator" ||
      (isApplicationMenu(menuId) && name === "toolbarseparator");
  }

  function isMenuEntryNode(node, menuId = "") {
    const name = String(node?.localName || "").toLowerCase();
    if (name === "menuitem" || name === "menu") return true;
    return isApplicationMenu(menuId) &&
      (name === "toolbarbutton" || name === "toolbaritem");
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function anonymousNodeSignature(menuId, node, scopePath = "root") {
    const stableAttributes = [
      "label", "tooltiptext", "aria-label", "command", "observes",
      "class", "type", "name", "value",
    ];

    return [
      menuId,
      scopePath,
      String(node?.localName || "").toLowerCase(),
      ...stableAttributes.map(name => node?.getAttribute?.(name) || ""),
    ].join("\u001f");
  }

  function prepareAnonymousNodeKeys(menuId, popup, scopePath = "root") {
    if (!popup?.children) return;

    const nodes = Array.from(popup.children).filter(node =>
      isMenuEntryNode(node, menuId) || isMenuSeparatorNode(node, menuId)
    );
    const usedKeys = new Set(
      nodes.map(node => node.getAttribute?.(ANONYMOUS_KEY_ATTR)).filter(Boolean)
    );
    const occurrenceBySignature = new Map();

    for (const node of nodes) {
      if (trim(node.id)) continue;

      // Count every anonymous sibling with this signature, including siblings
      // that already have a key. A partially rebuilt popup can retain some
      // nodes while replacing others; skipping keyed siblings shifted the
      // occurrence number and assigned a different key to the replacement.
      const signature = anonymousNodeSignature(menuId, node, scopePath);
      const occurrence = (occurrenceBySignature.get(signature) || 0) + 1;
      occurrenceBySignature.set(signature, occurrence);

      if (trim(node.getAttribute?.(ANONYMOUS_KEY_ATTR))) continue;

      let salt = occurrence;
      let key = `cme-${fnv1a(`${signature}\u001f${salt}`)}`;
      while (usedKeys.has(key)) {
        salt++;
        key = `cme-${fnv1a(`${signature}\u001f${salt}`)}`;
      }

      node.setAttribute(ANONYMOUS_KEY_ATTR, key);
      usedKeys.add(key);
    }
  }

  function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  function plural(n, singular, pluralForm = `${singular}s`) {
    return n === 1 ? singular : pluralForm;
  }

  function safeCall(fn, fallback = undefined) {
    try {
      return fn();
    } catch (error) {
      console.error("[menu-editor]", error);
      return fallback;
    }
  }

  // ===========================================================================
  // DOM FACTORY
  // ===========================================================================

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;

      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key === "style") {
        node.setAttribute("style", value);
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else {
        node.setAttribute(key, value);
      }
    }

    for (const child of children) {
      if (child) node.appendChild(child);
    }

    return node;
  }

  function button(label, title, onclick, extra = {}) {
    return el("button", {
      type: "button",
      text: label,
      title,
      ...extra,
      onclick,
    });
  }

  // ===========================================================================
  // CONFIG IO
  // ===========================================================================

  async function profilePath() {
    try {
      if (typeof PathUtils !== "undefined" && PathUtils.profileDir) {
        const profile = await PathUtils.profileDir;
        if (typeof profile === "string") return profile;
        if (profile?.path) return profile.path;
      }
    } catch (_) {
      // Fall through.
    }

    if (Services?.dirsvc) {
      return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    }

    throw new Error("Cannot locate Firefox profile directory");
  }

  // Join profile-relative paths with the host platform's native separator.
  // PathUtils is the preferred Firefox API; the fallback keeps the helper
  // usable in older chrome contexts and in the Node regression tests.
  function joinProfilePath(base, relative) {
    const root = String(base ?? "");
    const segments = String(relative ?? "")
      .split(/[\\/]+/)
      .filter(Boolean);

    if (!segments.length) return root;

    if (
      typeof PathUtils !== "undefined" &&
      typeof PathUtils.join === "function"
    ) {
      return PathUtils.join(root, ...segments);
    }

    const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root);
    const separator = windowsPath ? "\\" : "/";
    const normalizedRoot = root.replace(/[\\/]+$/, "");

    if (!normalizedRoot) {
      return `${separator}${segments.join(separator)}`;
    }

    return `${normalizedRoot}${separator}${segments.join(separator)}`;
  }

  // Normalize a path pasted by the user to the host OS before passing it to
  // Gecko's filesystem APIs. PathUtils is deliberately strict about native
  // Windows separators, while POSIX paths must retain their forward slashes.
  function normalizeHostPath(path) {
    const value = String(path ?? "").trim();
    const isWindows =
      typeof Services !== "undefined" &&
      Services.appinfo?.OS === "WINNT";

    return isWindows ? value.replace(/\//g, "\\") : value;
  }

  async function configPath() {
    return joinProfilePath(await profilePath(), CONFIG.path);
  }

  function makeEmptyConfig() {
    return {
      version: CONFIG.version,
      note: "Created by Context Menu Editor",
      menus: {},
    };
  }

  // Older configs may still contain the former locale-specific title fields.
  // They are read once and collapsed into the single `label` field; all live
  // rename/edit logic below uses `label` only.
  function legacyLabel(raw) {
    return trim(raw.label) || trim(raw.en) || trim(raw.pt);
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;

    // Normalize CSS selector lists before they become rule identities. A rule
    // such as "#item, #item" is one target, not two saved entries; retaining the
    // duplicate branch can otherwise create an apparently duplicated row.
    const selectorBranches = [...new Set(
      splitSelectorList(raw.selector).map(trim).filter(Boolean)
    )].slice(0, 32).map(value => value.slice(0, 2048));
    const entry = {
      selector: selectorBranches.join(", "),
    };

    if (!entry.selector) return null;

    // Optional structural metadata for rules created from nested menu rows.
    // This survives restarts even when a parent submenu is conditionally hidden
    // before the editor has a chance to observe its children in this session.
    const parentSelector = trim(raw.parentSelector);
    if (parentSelector) entry.parentSelector = parentSelector.slice(0, 2048);

    if (raw.label !== undefined || raw.en !== undefined || raw.pt !== undefined) {
      // Normalize everything to one title field.
      entry.label = (legacyLabel(raw) || "").slice(0, 512) || undefined;
      if (!entry.label) delete entry.label;
    }

    // Bookkeeping only: never applied to the menu, never shown as the row's
    // name. Kept purely so a renamed entry can still be found by the name it
    // used to have.
    if (raw.originalLabel) {
      entry.originalLabel = trim(raw.originalLabel).slice(0, 512);
    }

    if (raw.hidden) entry.hidden = true;
    if (raw.separator || isSeparatorSelector(entry.selector)) {
      entry.separator = true;
    }

    // A user-authored context restriction: the list of right-click "fields"
    // (page, link, image, media, selection, editable, frame) the entry is
    // allowed to appear in. Absent/empty means "no restriction" — the entry
    // shows wherever Firefox naturally shows it. This is the editable override
    // driven by the per-row context filter; it is distinct from the read-only
    // registry/native metadata that also happens to be called "contexts".
    if (Array.isArray(raw.contexts)) {
      const contexts = [...new Set(
        raw.contexts
          .map(value => text(value).toLowerCase())
          .filter(Boolean)
      )];

      if (contexts.length) entry.contexts = contexts.slice(0, 16).map(value => value.slice(0, 64));
    }

    // The custom context tag borrows another item in this same menu as its
    // reference. Accept either a bare element ID (recommended because "Copy
    // original ID" makes this easy) or a CSS selector.
    const contextReference = trim(raw.contextReference);
    if (contextReference) entry.contextReference = contextReference.slice(0, 2048);

    return entry;
  }

  function normalizeMenu(raw) {
    const menu = raw && typeof raw === "object" ? raw : {};

    const result = {
      reorder: menu.reorder !== false,
      entries: Array.isArray(menu.entries)
        ? menu.entries.slice(0, 2000).map(normalizeEntry).filter(Boolean)
        : [],
      pinnedTail: Array.isArray(menu.pinnedTail)
        ? menu.pinnedTail.slice(0, 2000).map(normalizeEntry).filter(Boolean)
        : [],
      childOrders: normalizeChildOrders(menu.childOrders),
    };

    return dedupeMenu(result);
  }

  // Nested menus have their own sibling order, independent of the top-level
  // menu order. Keep that order in a separate table instead of adding child
  // entries to `entries`: doing so would make a child look like a direct child
  // of the browser context menu and could move it out of its submenu.
  //
  // Shape:
  //   childOrders: [{ parentSelector: "#parent-id", order: ["#child-a", ...] }]
  //
  // Selectors are used rather than array indices because ExtensionMenus can
  // register entries in a different order after an add-on update/restart.
  function normalizeChildOrders(raw) {
    if (!Array.isArray(raw)) return [];

    const byParent = new Map();

    for (const item of raw.slice(0, 500)) {
      if (!item || typeof item !== "object") continue;

      const parentSelector = trim(
        item.parentSelector || item.parent
      );
      if (!parentSelector) continue;

      const rawOrder = Array.isArray(item.order)
        ? item.order
        : Array.isArray(item.selectors)
          ? item.selectors
          : [];
      const order = [...new Set(rawOrder.slice(0, 2000).map(trim).filter(Boolean))]
        .map(value => value.slice(0, 2048));

      if (!order.length) continue;

      const existing = byParent.get(parentSelector);
      if (existing) {
        // First occurrence defines precedence; later duplicate records may add
        // newly registered children without changing the saved relative order.
        for (const selector of order) {
          if (!existing.order.includes(selector)) existing.order.push(selector);
        }
      } else {
        byParent.set(parentSelector, { parentSelector, order });
      }
    }

    return [...byParent.values()];
  }

  // Merge duplicate rules rather than silently dropping their customisations.
  // Earlier versions kept the first matching selector and discarded the other
  // record, which could lose a rename or a hide flag during config normalization.
  function mergeEntryFields(target, source) {
    if (!target || !source || target === source) return target;

    if (!target.label && source.label) target.label = source.label;
    if (!target.originalLabel && source.originalLabel) {
      target.originalLabel = source.originalLabel;
    }
    if (!target.parentSelector && source.parentSelector) {
      target.parentSelector = trim(source.parentSelector);
    }

    // A true hide setting must survive merging. False is represented by the
    // absence of the property, so it does not cancel another record's true flag.
    if (target.hidden || source.hidden) target.hidden = true;
    else delete target.hidden;

    if (target.separator || source.separator || isSeparatorSelector(target.selector)) {
      target.separator = true;
    } else {
      delete target.separator;
    }

    // A context restriction must survive a dedupe merge. The first record that
    // carries one wins, exactly like a custom label — a later duplicate cannot
    // silently widen or narrow an explicit user choice.
    if (!target.contexts && Array.isArray(source.contexts) && source.contexts.length) {
      target.contexts = [...source.contexts];
    }
    if (!target.contextReference && source.contextReference) {
      target.contextReference = trim(source.contextReference);
    }

    return target;
  }

  function dedupeEntries(entries) {
    const bySelector = new Map();
    const result = [];

    for (const rawEntry of entries || []) {
      if (!rawEntry?.selector) continue;

      const selector = trim(rawEntry.selector);
      if (!selector) continue;
      rawEntry.selector = selector;

      const existing = bySelector.get(selector);
      if (existing) {
        if (
          existing.label && rawEntry.label &&
          existing.label !== rawEntry.label
        ) {
          console.warn(
            `[menu-editor] duplicate rule for ${selector}; keeping the first custom label`
          );
        }
        mergeEntryFields(existing, rawEntry);
        continue;
      }

      bySelector.set(selector, rawEntry);
      result.push(rawEntry);
    }

    return result;
  }

  function dedupeMenu(menu) {
    const entries = dedupeEntries(menu.entries || []);
    const pinnedInput = dedupeEntries(menu.pinnedTail || []);
    const bySelector = new Map(entries.map(entry => [entry.selector, entry]));
    const pinnedSelectors = [];
    const pinnedSeen = new Set();

    // If the same selector occurs in both lists, merge its data and preserve the
    // pinned-tail intent instead of dropping the pinned record's custom fields.
    for (const pinnedEntry of pinnedInput) {
      const selector = pinnedEntry.selector;
      let canonical = bySelector.get(selector);

      if (canonical) {
        mergeEntryFields(canonical, pinnedEntry);
      } else {
        canonical = pinnedEntry;
        bySelector.set(selector, canonical);
      }

      if (!pinnedSeen.has(selector)) {
        pinnedSeen.add(selector);
        pinnedSelectors.push(selector);
      }
    }

    return {
      reorder: menu.reorder !== false,
      entries: [...bySelector.values()].filter(
        entry => !pinnedSeen.has(entry.selector)
      ),
      pinnedTail: pinnedSelectors.map(selector => bySelector.get(selector)),
      childOrders: normalizeChildOrders(menu.childOrders),
    };
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : makeEmptyConfig();

    const result = {
      version: Number(source.version) || CONFIG.version,
      note: source.note || "Context Menu Editor",
      menus: {},
    };

    const rawMenus = source.menus;
    if (!rawMenus || typeof rawMenus !== "object" || Array.isArray(rawMenus)) {
      return result;
    }

    let acceptedMenus = 0;
    for (const [menuId, menu] of Object.entries(rawMenus)) {
      // Never allow special object-property names from JSON to mutate prototypes.
      if (!menuId || menuId.length > 256 ||
          menuId === "__proto__" || menuId === "prototype" || menuId === "constructor") {
        continue;
      }
      if (acceptedMenus >= CONFIG.maxMenus) break;
      result.menus[menuId] = normalizeMenu(menu);
      acceptedMenus++;
    }

    return result;
  }

  async function readBoundedConfigText(path) {
    // Check the on-disk byte size before allocating/decoding the file contents.
    const info = await IOUtils.stat(path);
    if (Number(info?.size) > CONFIG.maxConfigChars) {
      throw new Error(`Config file exceeds the ${CONFIG.maxConfigChars} byte safety limit`);
    }
    const contents = await IOUtils.readUTF8(path);
    if (contents.length > CONFIG.maxConfigChars) {
      throw new Error(`Config file exceeds the ${CONFIG.maxConfigChars} character safety limit`);
    }
    return contents;
  }

  async function readConfig() {
    const path = await configPath();

    if (!(await IOUtils.exists(path))) {
      return makeEmptyConfig();
    }

    const contents = await readBoundedConfigText(path);
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("menu-config.json root must be a JSON object");
    }

    // Migrate a config that still uses the old en/pt pair to a single "label".
    //
    // Doing it here rather than on the next manual Save means the file on disk
    // matches what the editor shows immediately, and the engine stops having to
    // understand two fields. writeConfig keeps a .bak of the original.
    if (hasLegacyLabels(parsed)) {
      try {
        await writeConfig(normalizeConfig(parsed));
        await engine()?.reload?.();
        console.info("[menu-editor] migrated en/pt titles to a single label");
      } catch (error) {
        console.warn("[menu-editor] label migration failed:", error);
      }
    }

    return normalizeConfig(parsed);
  }

  // True when any entry still carries the pre-migration "en"/"pt" fields.
  function hasLegacyLabels(config) {
    for (const menu of Object.values(config?.menus || {})) {
      for (const entry of [
        ...(menu?.entries || []),
        ...(menu?.pinnedTail || []),
      ]) {
        if (entry && (entry.en !== undefined || entry.pt !== undefined)) {
          return true;
        }
      }
    }

    return false;
  }

  // IOUtils can write to a temporary sibling and move it over the destination.
  // This avoids leaving a truncated menu-config.json if the browser exits during
  // a save. A backup is created by the same operation, before replacement.
  async function pruneConfigBackups(path) {
    // Keep the newest N backups for this exact config path. Never recurse or
    // touch exports, temporary files, or unrelated backup files.
    try {
      const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const directory = slash >= 0 ? path.slice(0, slash) : await profilePath();
      const prefix = `${path}.bak-`;
      const children = await IOUtils.getChildren(directory);
      const backups = children.filter(child => child.startsWith(prefix))
        .sort((a, b) => b.localeCompare(a));
      for (const obsolete of backups.slice(CONFIG.maxBackups)) {
        try { await IOUtils.remove(obsolete); }
        catch (error) { console.warn("[menu-editor] could not prune old config backup:", obsolete, error); }
      }
    } catch (error) {
      // Retention is best-effort and must never make saving fail.
      console.warn("[menu-editor] backup retention check failed:", error);
    }
  }

  let backupSequence = 0;

  async function writeUtf8Atomically(path, contents, { backup = false } = {}) {
    // The sequence prevents same-millisecond saves from targeting one backup
    // filename even though writes are serialized.
    const stamp = `${nowStamp()}-${String(++backupSequence).padStart(4, "0")}`;
    const options = { tmpPath: `${path}.tmp-${stamp}`, flush: true };
    if (backup && await IOUtils.exists(path)) options.backupFile = `${path}.bak-${stamp}`;
    await IOUtils.writeUTF8(path, contents, options);
    if (backup) await pruneConfigBackups(path);
    return path;
  }

  // Serialize saves: rapid clicks/imports cannot race over the same temporary
  // path or create overlapping backups for one config revision.
  let configWriteQueue = Promise.resolve();

  async function writeConfig(config) {
    const path = await configPath();
    const output = deepClone(config);
    output.version = CONFIG.version;
    const contents = JSON.stringify(output, null, 2) + "\n";

    const write = configWriteQueue.then(() =>
      writeUtf8Atomically(path, contents, { backup: true })
    );
    configWriteQueue = write.catch(error => {
      console.error("[menu-editor] queued config write failed:", error);
    });
    await write;
    return path;
  }

  // ===========================================================================
  // CONFIG MODEL
  // ===========================================================================

  function menuConfig(menuId, create = true) {
    if (!state.config) return null;

    if (!state.config.menus[menuId]) {
      if (!create) return null;

      state.config.menus[menuId] = {
        reorder: true,
        entries: [],
        pinnedTail: [],
        childOrders: [],
      };
    }

    const menu = state.config.menus[menuId];

    if (!Array.isArray(menu.entries)) menu.entries = [];
    if (!Array.isArray(menu.pinnedTail)) menu.pinnedTail = [];
    if (!Array.isArray(menu.childOrders)) menu.childOrders = [];
    if (menu.reorder === undefined) menu.reorder = true;

    return menu;
  }

  function childOrderRecord(menu, parentSelector, create = false) {
    const parent = trim(parentSelector);
    if (!menu || !parent) return null;

    if (!Array.isArray(menu.childOrders)) menu.childOrders = [];

    let record = menu.childOrders.find(
      item => trim(item?.parentSelector) === parent
    );

    if (!record && create) {
      record = { parentSelector: parent, order: [] };
      menu.childOrders.push(record);
    }

    if (record && !Array.isArray(record.order)) record.order = [];
    return record || null;
  }

  function rowHasChildOrder(row) {
    const menu = menuConfig(row?.menuId, false);
    const selectors = new Set([
      trim(row?.selector),
      trim(row?.entry?.selector),
      trim(row?.childOrderParentSelector),
    ].filter(Boolean));
    return !!(
      menu &&
      menu.childOrders?.some(
        item => selectors.has(trim(item?.parentSelector)) && item.order?.length
      )
    );
  }

  // Apply a parent's saved order to its currently discoverable children.
  // Unknown/new children are appended in their registry order, so an add-on
  // update cannot make a newly added command disappear or steal an old slot.
  function sortChildRowsByConfig(rows, menu, parentSelector) {
    if (!Array.isArray(rows) || rows.length < 2) return rows || [];

    const record = childOrderRecord(menu, parentSelector, false);
    if (!record?.order?.length) return rows;

    const rank = new Map(
      record.order.map((selector, index) => [trim(selector), index])
    );

    return [...rows].sort((a, b) => {
      const aSelector = trim(a?.entry?.selector || a?.selector);
      const bSelector = trim(b?.entry?.selector || b?.selector);
      const aKnown = rank.has(aSelector);
      const bKnown = rank.has(bSelector);

      if (aKnown && bKnown) return rank.get(aSelector) - rank.get(bSelector);
      if (aKnown) return -1;
      if (bKnown) return 1;
      return 0;
    });
  }

  function rowOrderScopeKey(row) {
    const parent = trim(row?.parentSelector);
    return parent ? `parent:${parent}` : "root";
  }

  function allRules(menuId) {
    const menu = menuConfig(menuId, false);
    if (!menu) return [];

    return [...menu.entries, ...menu.pinnedTail];
  }

  function findRule(menuId, selector) {
    for (const entry of allRules(menuId)) {
      if (entry.selector === selector) return entry;
    }

    return null;
  }

  function findRuleLocation(menuId, entry) {
    const menu = menuConfig(menuId, false);
    if (!menu) return null;

    const inPinned = menu.pinnedTail.includes(entry);

    return {
      list: inPinned ? menu.pinnedTail : menu.entries,
      pinned: inPinned,
    };
  }

  // Capture the title the entry is being renamed away from, so the original
  // name stays searchable. Written only once: the FIRST rename is the one that
  // captures the real default, and later renames must not overwrite it with a
  // custom title that happens to be current.
  function rememberOriginalLabel(entry, previous) {
    if (entry.originalLabel) return;

    const original = trim(previous);
    if (original) entry.originalLabel = original;
  }

  function setEntryLabel(entry, value) {
    const previous = entryLabel(entry);

    const valueTrimmed = trim(value);

    if (valueTrimmed) {
      rememberOriginalLabel(entry, previous);
      entry.label = valueTrimmed;
    } else {
      delete entry.label;
    }
  }

  // The custom title stored for an entry. The browser/extension title is read
  // from the discovered row instead.
  function entryLabel(entry) {
    return trim(entry?.label);
  }

  // The default title the entry carried before it was first renamed.
  function entryOriginalLabel(entry) {
    return trim(entry?.originalLabel);
  }

  function ensureRuleForRow(menuId, row) {
    const menu = menuConfig(menuId);
    const parentSelector = trim(
      row?.parentSelector || row?.childOrderParentSelector
    );

    if (row.entry) {
      if (
        parentSelector &&
        trim(row.entry.parentSelector) !== parentSelector
      ) {
        row.entry.parentSelector = parentSelector;
      }
      return row.entry;
    }
    if (!row.selector) return null;

    const existing = findRule(menuId, row.selector);
    if (existing) {
      if (
        parentSelector &&
        trim(existing.parentSelector) !== parentSelector
      ) {
        existing.parentSelector = parentSelector;
      }
      row.entry = existing;
      return existing;
    }

    const entry = {
      selector: row.selector,
      ...(parentSelector ? { parentSelector } : {}),
    };

    if (row.kind === "separator" || isSeparatorSelector(row.selector)) {
      entry.separator = true;
    }

    menu.entries.push(entry);
    row.entry = entry;
    row.managed = true;

    return entry;
  }

  function removeRule(menuId, entry) {
    const menu = menuConfig(menuId, false);
    if (!menu || !entry) return false;

    let removed = false;

    for (const list of [menu.entries, menu.pinnedTail]) {
      const index = list.indexOf(entry);

      if (index >= 0) {
        list.splice(index, 1);
        removed = true;
      }
    }

    return removed;
  }

  function ruleIsChanged(entry) {
    return !!(
      entry &&
      (
        entry.hidden ||
        entry.label ||
        entry.separator ||
        (Array.isArray(entry.contexts) && entry.contexts.length)
      )
    );
  }

  // The title to RENDER, which is not always getRowName(). Only selector
  // fallbacks are prettified; real labels and custom names remain untouched.
  // This is deliberately display-only: startInlineRename() continues to seed
  // its input from getRowName(), so clicking Rename reveals the actual label or
  // raw selector rather than saving a friendly display string as a custom name.
function getRowDisplayName(row) {
  const name =
    getRowName(row);

  const selector =
    trim(row?.selector);

  // Only when the name IS the selector, i.e. every real label missed.
  if (!name || !selector || name !== selector) {
    return name;
  }

  return prettifySelector(name, row);
  }

  // ===========================================================================
  // HIDDEN-RULE EXECUTOR
  //
  // Firefox context menus are XUL popups. The reliable way to hide a live
  // context-menu entry is to change the item's actual XUL `hidden` property,
  // rather than depending on a stylesheet selector matching a popup that
  // Firefox may rebuild while it is opening.
  //
  // Rules in menu-config.json still use CSS selectors. The selector is resolved
  // against the live menu when it is shown, and a MutationObserver catches menu
  // items that extensions insert after popupshowing.
  //
  // Important detail: we NEVER force an unhidden state for entries that Firefox
  // owns. When a rule is removed, we restore only nodes that THIS script hid,
  // and restore the exact hidden state they had before we touched them.
  // ===========================================================================

  const hiddenNodeState = new Map();
  const contextHiddenNodeState = new Map();
  const editorHiddenOriginalState = new Map();
  const hiddenObservers = new Map();

  // Separators at either visible edge are visual debris: they divide nothing.
  // Kept apart from hiddenNodeState because this is derived presentation state,
  // not a user-authored hide rule, and must be released if a late extension
  // item appears beyond the separator.
  const edgeSeparatorState = new Map();

  function splitSelectorList(value) {
    const source = text(value);
    const parts = [];

    let current = "";
    let depth = 0;
    let quote = "";

    for (let i = 0; i < source.length; i++) {
      const char = source[i];

      if (quote) {
        current += char;

        if (char === "\\") {
          const next = source[++i];
          if (next !== undefined) current += next;
        } else if (char === quote) {
          quote = "";
        }

        continue;
      }

      if (char === "\\") {
        current += char;
        const next = source[++i];
        if (next !== undefined) current += next;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        current += char;
        continue;
      }

      if (char === "[" || char === "(") depth++;
      else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);

      if (char === "," && depth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = "";
        continue;
      }

      current += char;
    }

    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function menuScope(menuId) {
    const menu = menuElement(menuId);
    if (!menu) return null;

    // contentAreaContextMenu is itself the menupopup. tabContextMenu and a
    // number of extension-created menus are <menu> wrappers around one. The
    // application menu's panelview is the query/rule scope.
    return menu;
  }

  function menuItemsContainer(menuId, menu = menuScope(menuId)) {
    if (!menu) return null;

    if (isApplicationMenu(menuId)) {
      // Only the main view's body contains its reorderable rows. Do not fall
      // back to the panelview itself: when a lazy view has not materialized its
      // body yet, treating the outer wrapper as a menu can make unrelated
      // chrome/engine rows look like children of the Application menu.
      return menu.querySelector?.(
        ":scope > .panel-subview-body, :scope > vbox.panel-subview-body, .panel-subview-body"
      ) || null;
    }

    return menu.localName === "menu"
      ? menu.querySelector(":scope > menupopup")
      : menu;
  }

  function selectorMatchesNode(node, selector) {
    if (!node || !selector) return false;

    for (const branch of splitSelectorList(selector)) {
      if (!branch) continue;

      try {
        if (node.matches?.(branch)) return true;
      } catch (error) {
        console.warn("[menu-editor] invalid hidden selector:", branch, error);
      }
    }

    return false;
  }

  function nodeBelongsToMenu(node, menuId) {
    const menu = menuScope(menuId);
    if (!menu || !node) return false;
    return node === menu || menu.contains(node);
  }

  function ruleTargetsNode(menuId, entry, node) {
    if (!entry?.hidden || !entry.selector) return false;
    if (!nodeBelongsToMenu(node, menuId)) return false;
    return selectorMatchesNode(node, entry.selector);
  }

  function shouldHideNode(node) {
    if (!node || !node.isConnected) return false;

    for (const [menuId, menu] of Object.entries(state.config?.menus || {})) {
      if (!menu) continue;
      if (!nodeBelongsToMenu(node, menuId)) continue;

      for (const entry of allRules(menuId)) {
        if (ruleTargetsNode(menuId, entry, node)) return true;
      }
    }

    return false;
  }

  function rememberEditorHiddenOriginal(node) {
    if (!editorHiddenOriginalState.has(node)) {
      editorHiddenOriginalState.set(node, {
        hidden: !!node.hidden,
      });
    }
  }

  // Explicit hide rules and context restrictions can claim the same node.
  // Capture the true pre-editor state once, and restore it only after both
  // independent reasons have released the node.
  function restoreEditorHiddenOriginalIfUnclaimed(node) {
    if (
      hiddenNodeState.has(node) ||
      contextHiddenNodeState.has(node)
    ) {
      return;
    }

    const previous = editorHiddenOriginalState.get(node);
    if (previous && node && typeof node.hidden === "boolean") {
      node.hidden = !!previous.hidden;
    }
    editorHiddenOriginalState.delete(node);
  }

  function markNodeHidden(node) {
    if (!node || typeof node.hidden !== "boolean") return;

    if (!hiddenNodeState.has(node)) {
      rememberEditorHiddenOriginal(node);
      hiddenNodeState.set(node, {
        hidden: !!node.hidden,
      });
    }

    if (!node.hidden) node.hidden = true;
  }

  function restoreNoLongerHiddenNodes() {
    for (const node of hiddenNodeState.keys()) {
      if (!node?.isConnected || !shouldHideNode(node)) {
        hiddenNodeState.delete(node);
        restoreEditorHiddenOriginalIfUnclaimed(node);
      }
    }
  }

  function applyHiddenRulesToMenu(menuId) {
    const menu = menuScope(menuId);
    if (!menu || (isApplicationMenu(menuId) && !menu.isConnected)) return;

    const popup = menuItemsContainer(menuId, menu);
    prepareAnonymousNodeKeys(menuId, popup || menu);

    const hiddenEntries = allRules(menuId).filter(
      entry => entry?.hidden && entry.selector
    );

    if (!hiddenEntries.length) return;

    for (const entry of hiddenEntries) {
      for (const selector of splitSelectorList(entry.selector)) {
        if (!selector) continue;

        // The menu itself is allowed as a match, although normal entries are
        // descendants of it.
        if (selectorMatchesNode(menu, selector)) {
          markNodeHidden(menu);
        }

        try {
          for (const node of menu.querySelectorAll(selector)) {
            // Context-menu entries are XUL nodes. Restrict changes to actual
            // menu items/submenus/separators so an overly broad selector cannot
            // unexpectedly hide browser chrome outside the menu UI.
            const localName = String(node.localName || "").toLowerCase();

            if (
              isMenuEntryNode(node, menuId) ||
              isMenuSeparatorNode(node, menuId)
            ) {
              markNodeHidden(node);
            }
          }
        } catch (error) {
          console.warn(
            `[menu-editor] hidden selector failed for ${menuId}:`,
            selector,
            error
          );
        }
      }
    }
  }

  // ===========================================================================
  // CONTEXT-RULE EXECUTOR
  //
  // A context restriction ("show this entry only in the image field") is a line
  // in menu-config.json until something enforces it on the live XUL menu. This
  // does that, at the same popup-time moment the hidden rules run.
  //
  // Unlike a hide rule, which is unconditional, a context rule is CONDITIONAL on
  // what was actually right-clicked. Firefox exposes that through the global
  // gContextMenu (the nsContextMenu instance): its boolean properties — onImage,
  // onLink, isTextSelected, onEditable, onVideo, onAudio, inFrame — say which
  // "field" the pointer was over when the menu opened. So an entry restricted to
  // ["image"] is hidden in every other field and left to Firefox's own logic in
  // the image field.
  //
  // It deliberately mirrors the hidden-rule executor's safety contract: only
  // nodes THIS pass hid are ever restored, and each returns to the exact hidden
  // state it had the instant before we touched it. The restore pass re-runs on
  // every popup, so flipping between fields never leaves a stale hide behind.
  // ===========================================================================

  // The menus a context restriction can apply to. "field" (image, media,
  // selection, ...) is a content-area notion: it describes what the pointer was
  // over in the page. The tab strip, bookmarks and toolbar menus have no such
  // field, so a restriction there would be meaningless — and gContextMenu, the
  // object that reports the field, only ever describes the content-area menu.
  // Gating on this keeps both the UI and the live pass honest.
  const CONTENT_MENU_IDS = Object.freeze([
    "contentAreaContextMenu",
    "subFrameContextMenu",
  ]);

  function isContentMenu(menuId) {
    return CONTENT_MENU_IDS.includes(text(menuId));
  }

  // The set of right-click "fields" Firefox reports for the menu currently being
  // shown, or null when it cannot be determined (no gContextMenu). Null means
  // "do not restrict anything".
  //
  // Property names are the long-standing nsContextMenu booleans. Each is read
  // defensively: a future Firefox that drops one simply contributes no context
  // rather than throwing.
  function activeContextSet() {
    const menu =
      typeof gContextMenu !== "undefined" ? gContextMenu : null;

    if (!menu || typeof menu !== "object") return null;

    const active = new Set();

    if (menu.onImage) active.add("image");
    if (menu.onVideo) active.add("video");
    if (menu.onAudio) active.add("audio");
    if (menu.onVideo || menu.onAudio) active.add("media");
    if (menu.onLink) active.add("link");
    if (menu.isTextSelected) active.add("selection");
    if (menu.onEditable || menu.onTextInput) active.add("editable");
    if (menu.inFrame) active.add("frame");

    // "page" means a bare-page click, not the generic background state that
    // accompanies links, images, selected text, media or inputs. The old
    // unconditional page tag made a Page-only rule also match links.
    if (!active.size) active.add("page");

    return active;
  }

  // Resolve a custom reference only inside the current content menu. A copied
  // original ID such as "context-savepage" is accepted directly; a short ID
  // such as "savepage" also tries the conventional context- prefix. Selectors
  // (for example '#context-savepage') are accepted as-is.
  function customReferenceNode(menuId, reference) {
    const menu = menuScope(menuId);
    if (!menu) return null;

    const root = menu.localName === "menu"
      ? menu.querySelector(":scope > menupopup")
      : menu;
    if (!root) return null;

    const raw = trim(reference);
    if (!raw) return null;

    const looksLikeSelector =
      raw.startsWith("#") ||
      raw.startsWith(".") ||
      raw.startsWith("[") ||
      raw.startsWith("*") ||
      raw.startsWith(":") ||
      /[ >+~]/.test(raw) ||
      /\[.*\]/.test(raw);
    const candidates = looksLikeSelector
      ? [raw]
      : [
          `#${escapeCss(raw)}`,
          `#context-${escapeCss(raw)}`,
        ];

    for (const selector of [...new Set(candidates)]) {
      try {
        const node = root.querySelector(selector);
        if (node) return node;
      } catch (error) {
        console.warn(
          `[menu-editor] invalid custom context reference for ${menuId}:`,
          selector,
          error
        );
      }
    }

    return null;
  }

  function isVisibleMenuReference(node, root) {
    if (!node || !root || !root.contains(node)) return false;

    let current = node;
    while (current) {
      if (
        current.hidden === true ||
        current.collapsed === true ||
        current.hasAttribute?.("hidden") ||
        current.getAttribute?.("collapsed") === "true"
      ) {
        return false;
      }

      try {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        ) {
          return false;
        }
      } catch (_) {
        // XUL nodes can lack a normal computed style during early popup build.
      }

      if (current === root) return true;
      current = current.parentElement;
    }

    return false;
  }

  function customReferenceIsActive(menuId, entry, subjectNode = null) {
    if (!entry?.contextReference) return false;

    const menu = menuScope(menuId);
    if (!menu) return false;
    const root = menu.localName === "menu"
      ? menu.querySelector(":scope > menupopup")
      : menu;
    if (!root) return false;

    const reference = customReferenceNode(menuId, entry.contextReference);
    // Guard against accidentally referencing the row being controlled. Without
    // this check, a custom rule could make its own visibility self-dependent.
    if (!reference || reference === subjectNode) return false;

    return isVisibleMenuReference(reference, root);
  }

  // Multiple context tags are an OR set: the entry is shown as soon as any
  // selected tag matches. "custom" matches when its referenced menu item is
  // currently present and visible.
  function contextRuleHidesNode(menuId, entry, node, active) {
    const allowed = Array.isArray(entry?.contexts)
      ? entry.contexts
      : null;

    if (!allowed || !allowed.length) return false;
    if (!entry.selector) return false;
    if (!active) return false;
    if (!nodeBelongsToMenu(node, menuId)) return false;
    if (!selectorMatchesNode(node, entry.selector)) return false;

    const matches = allowed.some(context => {
      if (context === "custom") {
        return customReferenceIsActive(menuId, entry, node);
      }

      return active.has(context) ||
        (context === "media" && (active.has("video") || active.has("audio")));
    });

    return !matches;
  }

  function markNodeContextHidden(node, menuId) {
    if (!node || typeof node.hidden !== "boolean") return;

    if (!contextHiddenNodeState.has(node)) {
      rememberEditorHiddenOriginal(node);
      contextHiddenNodeState.set(node, {
        menuId,
      });
    } else {
      // A node can be detached and reused under a different menu root.
      contextHiddenNodeState.get(node).menuId = menuId;
    }

    if (!node.hidden) node.hidden = true;
  }

  // Release only nodes owned by this menu. Detached nodes are restored too:
  // Firefox/Zen can recycle the same XUL element after temporarily removing it.
  function restoreNoLongerContextHiddenNodes(menuId, active) {
    for (const [node, previous] of contextHiddenNodeState) {
      if (previous?.menuId !== menuId) continue;

      let stillHidden = false;
      if (node?.isConnected && active) {
        for (const entry of allRules(menuId)) {
          if (contextRuleHidesNode(menuId, entry, node, active)) {
            stillHidden = true;
            break;
          }
        }
      }

      if (!node?.isConnected || !stillHidden) {
        contextHiddenNodeState.delete(node);
        restoreEditorHiddenOriginalIfUnclaimed(node);
      }
    }
  }

  function restoreContextHiddenNodesForRemovedMenus(configuredMenus) {
    const configured = configuredMenus || {};
    const removedMenuIds = new Set();

    for (const previous of contextHiddenNodeState.values()) {
      const menuId = previous?.menuId;
      if (menuId && !Object.prototype.hasOwnProperty.call(configured, menuId)) {
        removedMenuIds.add(menuId);
      }
    }

    for (const menuId of removedMenuIds) {
      restoreNoLongerContextHiddenNodes(menuId, null);
    }
  }

  function applyContextRulesToMenu(menuId) {
    // A context restriction is only meaningful for the content-area menu; see
    // CONTENT_MENU_IDS. Skip every other menu so its entries are never hidden
    // against gContextMenu's stale content-click state.
    if (!isContentMenu(menuId)) return;

    const restricted = allRules(menuId).filter(
      entry =>
        Array.isArray(entry?.contexts) &&
        entry.contexts.length &&
        entry.selector
    );
    const active = activeContextSet();

    // Release first, even when every context rule was removed or the context
    // cannot currently be identified. Otherwise an old hide can survive forever.
    restoreNoLongerContextHiddenNodes(menuId, active);

    const menu = menuScope(menuId);
    if (!menu || !restricted.length || !active) return;

    const popup = menu.localName === "menu"
      ? menu.querySelector(":scope > menupopup")
      : menu;
    prepareAnonymousNodeKeys(menuId, popup || menu);

    for (const entry of restricted) {
      for (const selector of splitSelectorList(entry.selector)) {
        if (!selector) continue;

        if (selectorMatchesNode(menu, selector)) {
          markNodeContextHidden(menu, menuId);
        }

        try {
          for (const node of menu.querySelectorAll(selector)) {
            const localName = String(node.localName || "").toLowerCase();

            if (
              localName === "menuitem" ||
              localName === "menu" ||
              localName === "menuseparator"
            ) {
              if (contextRuleHidesNode(menuId, entry, node, active)) {
                markNodeContextHidden(node, menuId);
              }
            }
          }
        } catch (error) {
          console.warn(
            `[menu-editor] context selector failed for ${menuId}:`,
            selector,
            error
          );
        }
      }
    }
  }

  // ===========================================================================
  // LABEL-RULE EXECUTOR
  //
  // A rename is only a line in menu-config.json until something writes it onto
  // the live XUL menu item. This profile has no __menuEngine — nothing defines
  // that global, so the engine hooks below silently no-op — which means without
  // this executor a saved rename appears in the editor and never in the real
  // menu. That is exactly the "renamed badge is set but the menu still says the
  // old title" symptom.
  //
  // It deliberately mirrors the hidden-rule executor, including the same
  // promise: only nodes THIS script relabelled are ever restored, and each goes
  // back to the exact attribute state it had beforehand (including having had no
  // label attribute at all).
  // ===========================================================================

  // node -> { label } where label === null records "there was no label
  // attribute", which is different from an empty one and must be restored by
  // removing the attribute rather than setting it to "".
  const labelNodeState = new Map();

  // The rename that currently claims this node, or null.
  function labelRuleForNode(node) {
    if (!node || !node.isConnected) return null;

    for (const [menuId, menu] of Object.entries(state.config?.menus || {})) {
      if (!menu) continue;
      const root = menuScope(menuId);
      if (!root || !nodeBelongsToMenu(node, menuId)) continue;

      for (const entry of allRules(menuId)) {
        if (!entry?.label || !entry.selector) continue;

        if (!isApplicationMenu(menuId)) {
          if (selectorMatchesNode(node, entry.selector)) return entry;
          continue;
        }

        // Composite app-menu rows are renamed through a descendant text label,
        // while selectors deliberately identify the outer toolbarbutton/item.
        // Keep this ancestor lookup app-menu-only: ordinary context-menu rules
        // must still claim only the exact node their selector matched.
        for (let current = node; current; current = current.parentNode) {
          if (selectorMatchesNode(current, entry.selector)) return entry;
          if (current === root) break;
        }
      }
    }

    return null;
  }

  function applicationMenuLabelTarget(node) {
    const name = String(node?.localName || "").toLowerCase();
    if (name !== "toolbaritem" && name !== "toolbarbutton") return node;

    // Some app-menu commands render their label as an explicit child
    // .toolbarbutton-text <label> (Zen's Smart/Blank Window rows are examples).
    // Setting label on the outer toolbarbutton alone does not reliably override
    // such a child, so target the visible text element when it exists.
    const textTargets = Array.from(
      node.querySelectorAll?.(".toolbarbutton-text, label") || []
    );
    const textTarget = textTargets.find(candidate =>
      trim(candidate.getAttribute?.("value")) ||
      trim(candidate.getAttribute?.("label")) ||
      trim(candidate.textContent)
    );
    if (textTarget) return textTarget;

    if (name === "toolbaritem") {
      const button = node.querySelector?.("toolbarbutton");
      return button || node;
    }

    return node;
  }

  function labelAttributeForNode(node) {
    return String(node?.localName || "").toLowerCase() === "label"
      ? "value"
      : "label";
  }

  function markNodeLabeled(node, label) {
    if (!node || !label) return;
    const attribute = labelAttributeForNode(node);

    if (!labelNodeState.has(node)) {
      labelNodeState.set(node, {
        attribute,
        value: node.hasAttribute(attribute)
          ? node.getAttribute(attribute)
          : null,
      });
    }

    if (node.getAttribute(attribute) !== label) {
      node.setAttribute(attribute, label);
    }
  }

  function restoreNoLongerLabeledNodes() {
    for (const [node, previous] of labelNodeState) {
      if (node?.isConnected && labelRuleForNode(node)) continue;

      // Attribute restoration is safe on detached nodes and matters because
      // Firefox/Zen may later reinsert the same XUL object into a rebuilt menu.
      if (node && previous) {
        if (previous.value === null) {
          node.removeAttribute(previous.attribute);
        } else {
          node.setAttribute(previous.attribute, previous.value);
        }
      }

      labelNodeState.delete(node);
    }
  }

  function applyLabelRulesToMenu(menuId) {
    const menu = menuScope(menuId);
    if (!menu || (isApplicationMenu(menuId) && !menu.isConnected)) return;

    const labelEntries = allRules(menuId).filter(
      entry => entry?.label && entry.selector
    );

    if (!labelEntries.length) return;

    for (const entry of labelEntries) {
      for (const selector of splitSelectorList(entry.selector)) {
        if (!selector) continue;

        try {
          for (const node of menu.querySelectorAll(selector)) {
            // Same restriction as the hidden executor: only real XUL menu
            // entries, so a broad selector cannot relabel unrelated chrome.
            const localName = String(node.localName || "").toLowerCase();

            if (
              isMenuEntryNode(node, menuId) ||
              isMenuSeparatorNode(node, menuId)
            ) {
              const target = isApplicationMenu(menuId)
                ? applicationMenuLabelTarget(node)
                : node;
              markNodeLabeled(target, trim(entry.label));
            }
          }
        } catch (error) {
          console.warn(
            `[menu-editor] label selector failed for ${menuId}:`,
            selector,
            error
          );
        }
      }
    }
  }

  // Apply configured order to the actual live XUL popup.
  //
  // A selector such as menuitem[label="Share"] stops matching after this editor
  // renames the node. Cache rule-to-node bindings while the original selector is
  // still valid, and discard/re-resolve a binding if Firefox rebuilds the popup.
  // Also, one unmatched dynamic child must not cancel the entire reorder: sort
  // managed nodes into the slots they already occupy and leave unknown nodes in
  // place. Diagnostics explain missing selectors and unrecognized live nodes.
  const separatorRuleIdentity = new WeakMap();
  const orderNodeBindings = new Map();
  const orderDiagnosticState = new Map();

  function orderBindingKey(menuId, selector) {
    return `${menuId}\u0000${selector}`;
  }

  function describeOrderNode(node) {
    if (!node) return "(missing node)";
    const name = String(node.localName || node.nodeName || "node").toLowerCase();
    const id = trim(node.id);
    const label = trim(
      node.getAttribute?.("label") ||
      node.getAttribute?.("tooltiptext") ||
      node.getAttribute?.("aria-label") ||
      node.textContent
    ).replace(/\s+/g, " ").slice(0, 72);
    return `${name}${id ? `#${id}` : ""}${label ? ` [${label}]` : ""}`;
  }

  function logOrderDiagnostic(menuId, kind, detail) {
    const key = `${menuId}\u0000${kind}`;
    let signature;
    try {
      signature = JSON.stringify(detail);
    } catch (_) {
      signature = String(detail);
    }
    if (orderDiagnosticState.get(key) === signature) return;
    orderDiagnosticState.set(key, signature);
    const logger = kind.includes("reordered") ? console.info : console.warn;
    logger.call(console, `[menu-editor:order] ${menuId}: ${kind}`, detail);
  }

  function separatorRuleIndexForNode(node, popup, fallbackIndex) {
    const saved = separatorRuleIdentity.get(node);
    if (saved && isSeparatorSelector(saved)) {
      return Number(saved.slice(4));
    }

    // Pick a free stable rule number, not simply the separator's current index.
    // Otherwise an inserted separator can take over an existing sep:N rule.
    const usedIndexes = new Set();
    const ownerMenuId = trim(popup?.parentElement?.id);
    for (const candidate of Array.from(popup?.children || [])) {
      if (!isMenuSeparatorNode(candidate, ownerMenuId)) continue;
      const identity = separatorRuleIdentity.get(candidate);
      if (isSeparatorSelector(identity)) usedIndexes.add(Number(identity.slice(4)));
    }

    let index = Math.max(0, Number(fallbackIndex) || 0);
    while (usedIndexes.has(index)) index++;
    separatorRuleIdentity.set(node, SEP(index));
    return index;
  }

  function selectorMatchesOrderEntry(node, entry) {
    if (!node || !entry?.selector) return false;
    if (selectorMatchesNode(node, entry.selector)) return true;

    // A saved selector can be label-based. If the editor already renamed that
    // item (including when this script was hot-reloaded), retry the same selector
    // with its configured live label, retaining any other selector constraints.
    const configuredLabel = trim(entry.label);
    if (!configuredLabel || trim(node.getAttribute?.("label")) !== configuredLabel) {
      return false;
    }

    const escapedLabel = configuredLabel
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    for (const branch of splitSelectorList(entry.selector)) {
      const rebound = branch.replace(
        /\[\s*label\s*=\s*(["'])(.*?)\1\s*\]/i,
        () => `[label="${escapedLabel}"]`
      );
      if (rebound !== branch) {
        try {
          if (node.matches?.(rebound)) return true;
        } catch (_) {
          // The original selector validator handles malformed selectors.
        }
      }
    }
    return false;
  }

  function applyOrderRulesToMenu(menuId) {
    const config = menuConfig(menuId, false);
    if (!config || config.reorder === false) return;

    const menu = menuScope(menuId);
    if (!menu || (isApplicationMenu(menuId) && !menu.isConnected)) return;
    const popup = menuItemsContainer(menuId, menu);
    if (!popup) return;

    const nodes = Array.from(popup.children).filter(node =>
      isMenuEntryNode(node, menuId) || isMenuSeparatorNode(node, menuId)
    );
    if (!nodes.length) return;

    // Keep separator identity on each node for its lifetime. When Firefox
    // replaces the popup, its new separators are identified from the new popup's
    // default order before any custom ordering is applied.
    let separatorIndex = 0;
    for (const node of nodes) {
      if (!isMenuSeparatorNode(node, menuId)) continue;
      separatorRuleIndexForNode(node, popup, separatorIndex);
      separatorIndex++;
    }

    const used = new Set();
    const ordered = [];
    const missingSelectors = [];
    const rules = [...(config.entries || []), ...(config.pinnedTail || [])];

    for (const entry of rules) {
      const selector = trim(entry?.selector);
      if (!selector) continue;

      const key = orderBindingKey(menuId, selector);
      let node = orderNodeBindings.get(key) || null;

      // Cached nodes are authoritative even if a rename means the original CSS
      // selector no longer matches. They are invalidated when Firefox replaces
      // the node or when the node is no longer a direct child of this popup.
      if (node && (node.parentNode !== popup || !nodes.includes(node) || used.has(node))) {
        orderNodeBindings.delete(key);
        node = null;
      }

      if (!node) {
        if (isSeparatorSelector(selector)) {
          node = nodes.find(candidate =>
            !used.has(candidate) &&
            isMenuSeparatorNode(candidate, menuId) &&
            separatorRuleIdentity.get(candidate) === selector
          ) || null;
        } else {
          node = nodes.find(candidate =>
            !used.has(candidate) && selectorMatchesOrderEntry(candidate, entry)
          ) || null;
        }
      }

      if (!node || used.has(node)) {
        missingSelectors.push(selector);
        continue;
      }

      orderNodeBindings.set(key, node);
      used.add(node);
      ordered.push(node);
    }

    const unmanagedNodes = nodes.filter(node => !used.has(node));
    if (missingSelectors.length || unmanagedNodes.length) {
      logOrderDiagnostic(menuId, "partial-match", {
        popupId: popup.id || menuId,
        configuredRules: rules.length,
        liveMenuNodes: nodes.length,
        matchedRules: ordered.length,
        missingSelectors: missingSelectors.slice(0, 12),
        additionalMissingSelectors: Math.max(0, missingSelectors.length - 12),
        unmatchedLiveNodes: unmanagedNodes.slice(0, 12).map(describeOrderNode),
        additionalUnmatchedLiveNodes: Math.max(0, unmanagedNodes.length - 12),
        note: "Matched entries are still reordered within their existing slots; unmatched nodes are left in place."
      });
    }

    if (ordered.length < 2) return;

    // Keep every unmanaged item at its existing child slot, and reorder only the
    // matched nodes among the slots they currently occupy. Comment placeholders
    // preserve those exact slots while nodes are moved; the operation is
    // synchronous, so Firefox never paints the intermediate state.
    const currentManaged = nodes.filter(node => used.has(node));
    if (currentManaged.every((node, index) => node === ordered[index])) return;

    const markers = [];
    for (let index = 0; index < currentManaged.length; index++) {
      const marker = document.createComment(`menu-editor-order:${menuId}:${index}`);
      popup.replaceChild(marker, currentManaged[index]);
      markers.push(marker);
    }

    for (let index = 0; index < ordered.length; index++) {
      popup.replaceChild(ordered[index], markers[index]);
    }

    logOrderDiagnostic(menuId, "reordered", {
      popupId: popup.id || menuId,
      reorderedNodes: ordered.length,
      liveMenuNodes: nodes.length,
      before: currentManaged.map(describeOrderNode),
      after: ordered.map(describeOrderNode)
    });
  }

  // Apply saved sibling orders inside native or extension-created submenus.
  // Each record identifies its parent by selector, then applies its ordered child selectors
  // only to that parent's direct <menupopup> children. The same slot-preserving
  // technique as the root executor keeps un-managed browser/add-on entries at
  // their existing positions instead of shuffling the whole popup.
  const nestedOrderNodeBindings = new Map();

  function applyNestedChildOrderRules(menuId) {
    const config = menuConfig(menuId, false);
    if (
      !config ||
      config.reorder === false ||
      !Array.isArray(config.childOrders) ||
      !config.childOrders.length
    ) {
      return;
    }

    const root = menuScope(menuId);
    if (!root) return;

    for (const record of config.childOrders) {
      const parentSelector = trim(record?.parentSelector);
      const childOrder = Array.isArray(record?.order)
        ? record.order.map(trim).filter(Boolean)
        : [];
      if (!parentSelector || childOrder.length < 2) continue;

      const parentRule = allRules(menuId).find(
        entry => trim(entry?.selector) === parentSelector
      ) || null;
      const parentMatch = parentRule || { selector: parentSelector };
      let parentNode = null;
      try {
        parentNode = selectorMatchesOrderEntry(root, parentMatch)
          ? root
          : root.querySelector(parentSelector);

        // A parent can itself have a custom label. If its original selector
        // used [label="…"], the direct query stops matching after Rename; retry
        // across the live subtree using the same label-rebinding logic as the
        // normal order executor.
        if (!parentNode && parentRule?.label) {
          parentNode = Array.from(root.querySelectorAll?.("*") || []).find(
            node => selectorMatchesOrderEntry(node, parentRule)
          ) || null;
        }
      } catch (error) {
        console.warn(
          `[menu-editor:order] ${menuId}: invalid nested parent selector`,
          parentSelector,
          error
        );
        continue;
      }
      if (!parentNode) continue;

      const parentName = String(parentNode.localName || "").toLowerCase();
      const popup = parentName === "menupopup"
        ? parentNode
        : Array.from(parentNode.children || []).find(
            child => String(child.localName || "").toLowerCase() === "menupopup"
          ) || null;
      if (!popup) continue;

      const nodes = Array.from(popup.children || []).filter(node => {
        const name = String(node.localName || "").toLowerCase();
        return name === "menuitem" || name === "menu" || name === "menuseparator";
      });
      if (nodes.length < 2) continue;

      const used = new Set();
      const ordered = [];
      const missingSelectors = [];

      for (const selector of childOrder) {
        const key = `${menuId}\u0000${parentSelector}\u0000${selector}`;
        let node = nestedOrderNodeBindings.get(key) || null;

        // Cached bindings survive label changes, but never survive a popup
        // rebuild or movement to a different submenu.
        if (
          node &&
          (node.parentNode !== popup || !nodes.includes(node) || used.has(node))
        ) {
          nestedOrderNodeBindings.delete(key);
          node = null;
        }

        if (!node) {
          const childRule = allRules(menuId).find(
            entry => trim(entry?.selector) === selector
          ) || { selector };
          node = nodes.find(candidate =>
            !used.has(candidate) &&
            selectorMatchesOrderEntry(candidate, childRule)
          ) || null;
        }

        if (!node) {
          missingSelectors.push(selector);
          continue;
        }

        nestedOrderNodeBindings.set(key, node);
        used.add(node);
        ordered.push(node);
      }

      const unmanagedNodes = nodes.filter(node => !used.has(node));
      if (missingSelectors.length || unmanagedNodes.length) {
        logOrderDiagnostic(menuId, "nested-partial-match", {
          parentSelector,
          popupId: popup.id || parentNode.id || "(submenu)",
          configuredChildren: childOrder.length,
          liveChildren: nodes.length,
          matchedChildren: ordered.length,
          missingSelectors: missingSelectors.slice(0, 12),
          additionalMissingSelectors: Math.max(0, missingSelectors.length - 12),
          unmatchedLiveChildren: unmanagedNodes.slice(0, 12).map(describeOrderNode),
          additionalUnmatchedLiveChildren: Math.max(0, unmanagedNodes.length - 12),
          note: "Matched children are reordered within their existing slots; unmatched children stay in place.",
        });
      }

      if (ordered.length < 2) continue;

      const currentManaged = nodes.filter(node => used.has(node));
      if (currentManaged.every((node, index) => node === ordered[index])) continue;

      const markers = [];
      for (let index = 0; index < currentManaged.length; index++) {
        const marker = document.createComment(
          `menu-editor-child-order:${menuId}:${index}`
        );
        popup.replaceChild(marker, currentManaged[index]);
        markers.push(marker);
      }

      for (let index = 0; index < ordered.length; index++) {
        popup.replaceChild(ordered[index], markers[index]);
      }

      logOrderDiagnostic(menuId, "nested-reordered", {
        parentSelector,
        popupId: popup.id || parentNode.id || "(submenu)",
        reorderedNodes: ordered.length,
        before: currentManaged.map(describeOrderNode),
        after: ordered.map(describeOrderNode),
      });
    }
  }

  function restoreEdgeSeparatorNode(node, previous) {
    if (!node || !previous) return;

    if (previous.hidden) {
      node.setAttribute("hidden", previous.hiddenValue ?? "");
      node.hidden = true;
    } else {
      node.removeAttribute("hidden");
      node.hidden = false;
    }

    if (previous.display) {
      node.style.setProperty(
        "display",
        previous.display,
        previous.displayPriority
      );
    } else {
      node.style.removeProperty("display");
    }
  }

  function restoreEdgeSeparators() {
    for (const [node, previous] of edgeSeparatorState) {
      restoreEdgeSeparatorNode(node, previous);
      edgeSeparatorState.delete(node);
    }
  }

function cleanEdgeSeparators(menuId) {
  const menu = menuScope(menuId);
  if (!menu || (isApplicationMenu(menuId) && !menu.isConnected)) return;
  const popup = menuItemsContainer(menuId, menu);

  if (!popup) return;

  const isSeparator = node => {
    if (isMenuSeparatorNode(node, menuId)) return true;
    const name = String(node?.localName || "").toLowerCase();
    const role = String(node?.getAttribute?.("role") || "").toLowerCase();
    const className = String(node?.getAttribute?.("class") || "");
    // Some add-ons use ordinary elements as separators. Keep recognition narrow.
    return name === "hr" || name === "toolbarseparator" || role === "separator" ||
      node?.hasAttribute?.("data-separator") ||
      String(node?.getAttribute?.("type") || "").toLowerCase() === "separator" ||
      /(?:^|[\s_-])(?:menu[-_]?separator|toolbar[-_]?separator|separator)(?:$|[\s_-])/i.test(className);
  };

  const isEntry = node => {
    if (!isMenuEntryNode(node, menuId) || node.hidden || node.collapsed || shouldHideNode(node)) return false;
    try {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    } catch (_) {
      // A detached/transient node is treated as visible unless its own state says otherwise.
    }
    return true;
  };

  const children = Array.from(popup.children).filter(node =>
    isSeparator(node) || isEntry(node)
  );

  // Remember separators hidden by this function so they can be
  // restored when the menu changes.
  const setHidden = (node, hide) => {
    if (hide) {
      if (!edgeSeparatorState.has(node)) {
        edgeSeparatorState.set(node, {
          hidden: node.hasAttribute("hidden"),
          hiddenValue: node.getAttribute("hidden"),
          display: node.style.getPropertyValue("display"),
          displayPriority: node.style.getPropertyPriority("display")
        });
      }

	if (node.getAttribute("hidden") !== "true") {
	node.setAttribute("hidden", "true");
	}
	
	if (
	node.style.getPropertyValue("display") !== "none" ||
	node.style.getPropertyPriority("display") !== "important"
	) {
	node.style.setProperty("display", "none", "important");
	}
    } else {
      const previous = edgeSeparatorState.get(node);

      if (previous) {
        restoreEdgeSeparatorNode(node, previous);
        edgeSeparatorState.delete(node);
      } else {
        // Clear a native hidden attribute, but do not rewrite inline layout
        // styles that belong to the extension/theme which created this node.
        // In particular, custom separators may legitimately use display:flex.
        if (node.hasAttribute("hidden") || node.hidden) {
          node.removeAttribute("hidden");
          node.hidden = false;
        }
      }
    }
  };

  let previousWasEntry = false;
  let pendingSeparator = null;
  const separatorsToHide = new Set();
  const separatorsToShow = new Set();

  for (const node of children) {
    if (isSeparator(node)) {
      // Explicitly configured hidden separators remain untouched.
      if (
        hiddenNodeState.has(node) ||
        contextHiddenNodeState.has(node) ||
        shouldHideNode(node) ||
        node.hasAttribute("ensureHidden")
      ) {
        continue;
      }

      if (!previousWasEntry) {
        // Leading or consecutive separator.
        separatorsToHide.add(node);
      } else {
        // Keep a separator after a group of visible entries.
        if (pendingSeparator) {
          separatorsToHide.add(pendingSeparator);
        }

        pendingSeparator = node;
        separatorsToShow.add(node);
      }

      previousWasEntry = false;
    } else {
      // An entry after a separator makes that separator non-trailing.
      if (pendingSeparator) {
        pendingSeparator = null;
      }

      previousWasEntry = true;
    }
  }

  // A pending separator at the end of the menu is trailing.
  if (pendingSeparator) {
    separatorsToHide.add(pendingSeparator);
    separatorsToShow.delete(pendingSeparator);
  }

  // Apply changes only after evaluating the complete menu.
  for (const separator of separatorsToHide) {
    separatorsToShow.delete(separator);
    setHidden(separator, true);
  }

  for (const separator of separatorsToShow) {
    setHidden(separator, false);
  }
}

 function applyHiddenStyles() {
    if (!state.config) return;

    try {
      restoreContextHiddenNodesForRemovedMenus(state.config.menus || {});
      restoreNoLongerHiddenNodes();
      restoreNoLongerLabeledNodes();
      restoreEdgeSeparators();

      for (const menuId of Object.keys(state.config.menus || {})) {
        installHiddenObserver(menuId);
        applyHiddenRulesToMenu(menuId);
        applyContextRulesToMenu(menuId);
        applyOrderRulesToMenu(menuId);
        applyNestedChildOrderRules(menuId);
        applyLabelRulesToMenu(menuId);
        cleanEdgeSeparators(menuId);
      }

      restoreNoLongerHiddenNodes();
      restoreNoLongerLabeledNodes();
    } catch (error) {
      console.error("[menu-editor] applying hidden rules failed:", error);
    }
  }

  function installHiddenObserver(menuId) {
    // Zen can replace a popup node when a menu is opened. Disconnect observers
    // attached to the now-detached versions so this map cannot retain an old
    // menu tree (and its observer) every time the menu is rebuilt.
    for (const [observedMenu, oldObserver] of hiddenObservers) {
      if (!observedMenu?.isConnected) {
        oldObserver.disconnect();
        hiddenObservers.delete(observedMenu);
      }
    }

    const menu = menuScope(menuId);
    if (!menu || (isApplicationMenu(menuId) && !menu.isConnected) || hiddenObservers.has(menu)) return;

    let observerPassQueued = false;
    const observer = new MutationObserver(mutations => {
      // If this menu was replaced after installation, release it immediately
      // when any remaining mutation is delivered.
      if (!menu.isConnected) {
        observer.disconnect();
        hiddenObservers.delete(menu);
        return;
      }

      const structuralChange = mutations.some(
        mutation =>
          mutation.type === "childList" &&
          (mutation.addedNodes.length || mutation.removedNodes.length)
      );
      const relevant = structuralChange || mutations.some(
        mutation => mutation.type === "attributes"
      );
      if (!relevant || observerPassQueued) return;
      observerPassQueued = true;

      // Run after the current mutation batch. Extension menu construction can
      // add several nodes in succession, while the attribute filter catches
      // Firefox/Zen resetting our hidden or renamed labels after popupshowing.
      queueMicrotask(() => {
        observerPassQueued = false;
        if (!menu.isConnected) {
          observer.disconnect();
          hiddenObservers.delete(menu);
          return;
        }

        applyHiddenRulesToMenu(menuId);
        applyContextRulesToMenu(menuId);
        applyOrderRulesToMenu(menuId);
        applyNestedChildOrderRules(menuId);
        applyLabelRulesToMenu(menuId);

        // CRITICAL: restoring edge separators on an attribute-only pass would
        // unhide and re-hide the same separator, generating another attribute
        // mutation forever. Recalculate their original state only when the menu
        // structure changes; attribute-only passes must remain idempotent.
        if (structuralChange) restoreEdgeSeparators();
        cleanEdgeSeparators(menuId);
      });
    });

    observer.observe(menu, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "label", "value"],
    });

    hiddenObservers.set(menu, observer);
  }

  // Apply hidden+label rules for every configured menu the popup belongs to.
  // menuScope() is called fresh every time, so if Zen REPLACED the menu element
  // since the last pass (it rebuilds tabContextMenu on every opening), the new
  // element is picked up here and installHiddenObserver() attaches a fresh
  // MutationObserver to it — the one watching the detached old node is dead.
  function applyRulesForPopup(popup) {
    if (!popup || !state.config) return;

    for (const menuId of Object.keys(state.config.menus || {})) {
      const menu = menuScope(menuId);
      if (!menu) continue;

      // Zen may replace #tabContextMenu while it is opening.  In that case the
      // event still points at the detached, old popup, while menuScope() above
      // correctly resolves the new one.  Its id (or its wrapper's id) remains
      // the durable link between the event and the configured menu.
      const popupId = trim(popup.id);
      const popupParentId = trim(popup.parentElement?.id);

      const targetIsApplicationPanel =
        isApplicationMenu(menuId) && popupId === APP_MENU_PANEL_ID;

      const targetIsMenu =
        targetIsApplicationPanel ||
        popup === menu ||
        popupId === menuId ||
        popupParentId === menuId ||
        (
          menu.localName === "menu" &&
          popup.parentElement === menu
        );

      if (!targetIsMenu && !menu.contains(popup)) continue;

      installHiddenObserver(menuId);
      applyHiddenRulesToMenu(menuId);
      applyContextRulesToMenu(menuId);
      applyOrderRulesToMenu(menuId);
      applyNestedChildOrderRules(menuId);
      applyLabelRulesToMenu(menuId);
      restoreEdgeSeparators();
      cleanEdgeSeparators(menuId);
    }
  }

  // ===========================================================================
  // PASSIVE CONTEXT-MENU MONITOR
  //
  // Observe real popup lifecycles without changing their contents. A short-lived
  // MutationObserver is attached only while a context menu is open; each sample
  // compares the popup's real direct children with the rows returned by discover().
  // This makes entries that the editor did not recognize visible in diagnostics,
  // including entries inserted after popupshowing by an extension.
  //
  // The monitor does not hide, relabel, reorder, select, or remove anything. It
  // records plain metadata only (no page URL, selected text, link URL, or content).
  // ===========================================================================

  const MENU_MONITOR_MAX_HISTORY = 100;
  const MENU_MONITOR_SETTLE_DELAYS = Object.freeze([0, 35, 140]);
  const MENU_MONITOR_ENTRY_NAMES = new Set([
    "menuitem",
    "menu",
    "menuseparator",
  ]);
  const MENU_MONITOR_CONTEXT_ROOT_IDS = new Set(CONTEXT_MENU_ROOT_IDS);

  const menuMonitorSessions = new Map();
  const menuMonitorHistory = [];
  let menuMonitorSequence = 0;
  let menuMonitorEnabled = true;

  function monitorIsElement(node) {
    return !!node && node.nodeType === 1;
  }

  function monitorIsContextRoot(node) {
    if (!monitorIsElement(node)) return false;

    const id = trim(node.id);
    if (id && MENU_MONITOR_CONTEXT_ROOT_IDS.has(id)) return true;
    if (id && /contextmenu/i.test(id)) return true;

    const type = trim(node.getAttribute?.("type")).toLowerCase();
    if (type === "context") return true;

    const context = trim(node.getAttribute?.("context"));
    if (
      context &&
      (
        MENU_MONITOR_CONTEXT_ROOT_IDS.has(context) ||
        /contextmenu/i.test(context)
      )
    ) {
      return true;
    }

    return false;
  }

  function monitorFindContextRoot(popup) {
    for (
      let current = popup;
      current && current !== document;
      current = current.parentElement
    ) {
      if (monitorIsContextRoot(current)) return current;
    }

    return null;
  }

  function monitorMenuIdForPopup(popup, contextRoot) {
    // The popup ID is the most exact namespace when it exists. Otherwise an
    // XUL <menu> wrapper owns its direct <menupopup> and is the correct ID.
    const popupId = trim(popup?.id);
    if (popupId) return popupId;

    const parent = popup?.parentElement;
    if (
      String(parent?.localName || "").toLowerCase() === "menu" &&
      trim(parent.id)
    ) {
      return trim(parent.id);
    }

    for (
      let current = parent;
      current && current !== document;
      current = current.parentElement
    ) {
      const id = trim(current.id);
      const name = String(current.localName || "").toLowerCase();
      if (id && (name === "menu" || name === "menupopup")) return id;
    }

    return trim(contextRoot?.id);
  }

  function monitorLooksLikeUnknownMenuEntry(node) {
    if (!monitorIsElement(node)) return false;

    const localName = String(node.localName || "").toLowerCase();
    if (MENU_MONITOR_ENTRY_NAMES.has(localName)) return true;

    const role = trim(node.getAttribute?.("role")).toLowerCase();
    if (["menuitem", "menu", "separator", "option"].includes(role)) {
      return true;
    }

    const className = text(node.getAttribute?.("class"));
    if (/menuitem|menu-separator|menuseparator/i.test(className)) return true;
    if (/^(menuitem|menuseparator|menu)-/.test(localName)) return true;

    // Some extensions build HTML menu items instead of XUL menuitem nodes.
    // Only flag those when they carry an explicit menu-like semantic/label.
    return (
      node.hasAttribute?.("aria-label") ||
      node.hasAttribute?.("label") ||
      (node.hasAttribute?.("command") && localName !== "menupopup")
    );
  }

  function monitorNodeKey(entry) {
    if (entry.id) return `${entry.localName}#${entry.id}`;
    return `${entry.localName}|${entry.label}|${entry.index}`;
  }

  function monitorDescribeNode(node, index, captureStatus) {
    const localName = String(node?.localName || node?.nodeName || "node")
      .toLowerCase();
    const id = trim(node?.id);
    const label = trim(
      node?.getAttribute?.("label") ||
      node?.getAttribute?.("aria-label") ||
      node?.getAttribute?.("tooltiptext") ||
      node?.textContent
    ).replace(/\s+/g, " ").slice(0, 120);
    const extension = extensionMetaFromNode(node);

    return {
      index,
      localName,
      id: id || null,
      selector: id
        ? `#${escapeCss(id)}`
        : null,
      label,
      type: trim(node?.getAttribute?.("type")) || null,
      className: trim(node?.getAttribute?.("class")) || null,
      extensionId: extension.extensionId || null,
      extensionMenuId: extension.extensionMenuId || null,
      collapsedContainer: !!extension.collapsedContainer,
      hidden: !!(
        node?.hidden === true ||
        node?.hasAttribute?.("hidden") ||
        node?.getAttribute?.("collapsed") === "true"
      ),
      disabled: !!(
        node?.disabled === true ||
        node?.hasAttribute?.("disabled")
      ),
      captureStatus,
    };
  }

  function monitorPopupDiscovery(popup, menuId) {
    if (!menuId) {
      return {
        comparable: false,
        reason: "The popup has no stable menu ID.",
        rows: [],
      };
    }

    const menu = menuElement(menuId);
    const resolvedPopup = menu?.localName === "menu"
      ? menu.querySelector(":scope > menupopup")
      : menu;

    if (!resolvedPopup || resolvedPopup !== popup) {
      return {
        comparable: false,
        reason: `The menu ID ${menuId} does not resolve to this live popup.`,
        rows: [],
      };
    }

    try {
      const snapshot = discover(menuId, undefined, {
        includeEngine: false,
        includeRegistry: false,
        assignAnonymousKeys: false,
      });
      return {
        comparable: true,
        reason: null,
        rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [],
      };
    } catch (error) {
      return {
        comparable: false,
        reason: `Discovery threw: ${String(error)}`,
        rows: [],
      };
    }
  }

  function monitorSessionRecord(session) {
    const entries = Array.isArray(session.latestEntries)
      ? session.latestEntries
      : [];
    const missedEntries = [...session.missedEntries.values()].map(entry => ({
      ...entry.entry,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      resolved: !!entry.resolved,
      resolution: entry.resolution || null,
    }));

    return {
      sessionId: session.id,
      menuId: session.menuId || null,
      contextRootId: session.contextRootId || null,
      popupId: trim(session.popup?.id) || null,
      popupLabel: session.popupLabel || null,
      openedAt: session.openedAt,
      closedAt: session.closedAt || null,
      durationMs: session.closedAt
        ? Math.max(0, session.closedAt - session.openedAt)
        : null,
      closeReason: session.closeReason || null,
      samples: session.samples,
      mutationBatches: session.mutationBatches,
      entryCount: entries.length,
      capturedCount: entries.filter(entry => entry.captureStatus === "captured").length,
      missedCount: missedEntries.filter(entry => !entry.resolved).length,
      unverifiedCount: entries.filter(entry => entry.captureStatus === "unverified").length,
      entries,
      missedEntries,
      discoveryReason: session.discoveryReason || null,
    };
  }

  function monitorPublicClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function monitorCapture(session, phase = "sample") {
    if (!session || session.finalized) return null;

    const popup = session.popup;
    const children = Array.from(popup?.children || []).filter(monitorIsElement);
    const candidates = children.filter(monitorLooksLikeUnknownMenuEntry);
    const discovery = monitorPopupDiscovery(popup, session.menuId);
    const discoveredRows = discovery.rows || [];
    if (discovery.comparable && discoveredRows.length) {
      rememberObservedMenuRows(
        session.contextRootId || session.menuId,
        discoveredRows
      );
    }
    const discoveredNodes = new Set(
      discoveredRows.map(row => row?.el).filter(Boolean)
    );
    const discoveredIds = new Set(
      discoveredRows.map(row => trim(row?.id)).filter(Boolean)
    );

    session.discoveryReason = discovery.reason;
    session.samples++;
    session.lastSampleAt = Date.now();

    const entries = candidates.map((node, index) => {
      const localName = String(node.localName || node.nodeName || "node")
        .toLowerCase();
      const supportedNode = MENU_MONITOR_ENTRY_NAMES.has(localName);
      const id = trim(node.id);
      let captureStatus = "unverified";

      if (discovery.comparable) {
        if (!supportedNode) {
          captureStatus = "unsupported";
        } else if (
          discoveredNodes.has(node) ||
          (id && discoveredIds.has(id))
        ) {
          captureStatus = "captured";
        } else {
          captureStatus = "not-discovered";
        }
      } else if (!supportedNode) {
        captureStatus = "unsupported";
      }

      return monitorDescribeNode(node, index, captureStatus);
    });

    session.latestEntries = entries;
    session.lastPhase = phase;

    const now = Date.now();
    for (const entry of entries) {
      const key = monitorNodeKey(entry);
      const isMissed =
        entry.captureStatus === "not-discovered" ||
        entry.captureStatus === "unsupported";
      const existing = session.missedEntries.get(key);

      if (isMissed) {
        if (!existing) {
          session.missedEntries.set(key, {
            entry: { ...entry },
            firstSeenAt: now,
            lastSeenAt: now,
            resolved: false,
            resolution: null,
          });
          console.warn(
            "[menu-editor:monitor] possible uncaught context-menu entry",
            {
              menuId: session.menuId,
              popupId: trim(popup?.id) || null,
              phase,
              entry,
              discoveryReason: discovery.reason,
            }
          );
        } else {
          existing.entry = { ...entry };
          existing.lastSeenAt = now;
          existing.resolved = false;
          existing.resolution = null;
        }
      } else if (existing && !existing.resolved) {
        existing.lastSeenAt = now;
        existing.resolved = true;
        existing.resolution = "The entry appeared in the editor's discovery snapshot in a later sample.";
      }
    }

    return monitorSessionRecord(session);
  }

  function monitorScheduleSample(session, delay, phase) {
    if (!session || session.finalized) return;
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      monitorCapture(session, phase);
    }, delay);
    session.timers.add(timer);
  }

  function monitorStart(popup) {
    if (!menuMonitorEnabled || !popup) return;

    const contextRoot = monitorFindContextRoot(popup);
    if (!contextRoot) return;

    const existing = menuMonitorSessions.get(popup);
    if (existing) monitorFinish(popup, "reopened-before-hidden");

    const menuId = monitorMenuIdForPopup(popup, contextRoot);
    const rootLabel = trim(
      contextRoot.getAttribute?.("label") ||
      contextRoot.getAttribute?.("aria-label") ||
      contextRoot.id
    );

    const session = {
      id: ++menuMonitorSequence,
      popup,
      menuId,
      contextRootId: trim(contextRoot.id),
      popupLabel: rootLabel || menuId || "Context menu",
      openedAt: Date.now(),
      closedAt: null,
      closeReason: null,
      samples: 0,
      mutationBatches: 0,
      latestEntries: [],
      missedEntries: new Map(),
      discoveryReason: null,
      lastSampleAt: 0,
      lastPhase: null,
      timers: new Set(),
      mutationTimer: null,
      observer: null,
      finalized: false,
    };

    menuMonitorSessions.set(popup, session);

    try {
      session.observer = new MutationObserver(mutations => {
        if (session.finalized) return;
        session.mutationBatches++;

        const relevant = mutations.some(mutation =>
          mutation.type === "childList" || mutation.type === "attributes"
        );
        if (!relevant) return;

        if (session.mutationTimer !== null) {
          clearTimeout(session.mutationTimer);
        }
        session.mutationTimer = setTimeout(() => {
          session.mutationTimer = null;
          monitorCapture(session, "mutation-observer");
        }, 25);
      });

      session.observer.observe(popup, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "id",
          "label",
          "tooltiptext",
          "aria-label",
          "class",
          "ext-type",
          "hidden",
          "collapsed",
          "disabled",
          "type",
          "role",
        ],
      });
    } catch (error) {
      console.warn("[menu-editor:monitor] could not observe popup:", error);
    }

    // The first snapshot is synchronous and precedes this editor's own live-rule
    // pass. The settling samples then see entries added by later popup listeners
    // or by extension work deferred to a microtask/task.
    monitorCapture(session, "popupshowing");
    for (const delay of MENU_MONITOR_SETTLE_DELAYS) {
      monitorScheduleSample(session, delay, `settled-${delay}ms`);
    }
  }

  function monitorPopupShown(popup) {
    const session = menuMonitorSessions.get(popup);
    if (!session || session.finalized) return;

    monitorScheduleSample(session, 0, "popupshown");
    monitorScheduleSample(session, 45, "popupshown+45ms");
  }

  function monitorFinish(popup, reason = "popuphidden") {
    const session = menuMonitorSessions.get(popup);
    if (!session || session.finalized) return;

    monitorCapture(session, `final-${reason}`);
    session.finalized = true;
    session.closedAt = Date.now();
    session.closeReason = reason;

    if (session.observer) {
      session.observer.disconnect();
      session.observer = null;
    }
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (session.mutationTimer !== null) {
      clearTimeout(session.mutationTimer);
      session.mutationTimer = null;
    }

    const record = monitorSessionRecord(session);
    menuMonitorHistory.push(record);
    if (menuMonitorHistory.length > MENU_MONITOR_MAX_HISTORY) {
      menuMonitorHistory.splice(
        0,
        menuMonitorHistory.length - MENU_MONITOR_MAX_HISTORY
      );
    }
    menuMonitorSessions.delete(popup);

    const unresolved = record.missedEntries.filter(entry => !entry.resolved);
    const summary = {
      sessionId: record.sessionId,
      menuId: record.menuId,
      entryCount: record.entryCount,
      capturedCount: record.capturedCount,
      missedCount: unresolved.length,
      samples: record.samples,
      mutationBatches: record.mutationBatches,
    };

    if (unresolved.length) {
      console.warn(
        "[menu-editor:monitor] context-menu audit found possible missed entries",
        summary,
        unresolved
      );
    } else {
      console.info("[menu-editor:monitor] context-menu audit", summary);
    }
  }

  function monitorSetEnabled(enabled) {
    menuMonitorEnabled = !!enabled;
    if (!menuMonitorEnabled) {
      for (const popup of [...menuMonitorSessions.keys()]) {
        monitorFinish(popup, "monitor-disabled");
      }
    }
    return monitorStatusRecord();
  }

  function monitorStatusRecord() {
    const active = [...menuMonitorSessions.values()].map(monitorSessionRecord);
    const historyMisses = menuMonitorHistory.reduce(
      (total, record) =>
        total + record.missedEntries.filter(entry => !entry.resolved).length,
      0
    );
    const activeMisses = active.reduce(
      (total, record) =>
        total + record.missedEntries.filter(entry => !entry.resolved).length,
      0
    );

    return {
      enabled: menuMonitorEnabled,
      activePopups: active.length,
      recordedPopups: menuMonitorHistory.length,
      unresolvedMisses: historyMisses + activeMisses,
    };
  }

  function monitorReport() {
    return {
      monitor: "Context Menu Editor passive popup monitor",
      version: "1.0",
      status: monitorStatusRecord(),
      active: [...menuMonitorSessions.values()].map(monitorSessionRecord),
      history: menuMonitorHistory.slice(),
    };
  }

  function monitorClearHistory() {
    menuMonitorHistory.length = 0;
    return true;
  }

  // Some native submenus build their items only when the submenu is opened.
  // The popup lifecycle pass applies any saved child order immediately; if the
  // editor panel is also open, refresh its tree after the popup has finished
  // constructing so those newly materialized children become draggable rows.
  function refreshEditorTreeForPopup(popup) {
    // The panel may have auto-hidden when a native context menu opened. It
    // remains in the chrome document, though, so a nested submenu can still
    // refresh its lazily-created children for the next time the panel is shown.
    if (!rowContainer()) return;

    const root = menuScope(state.activeMenu);
    if (!root || !root.contains?.(popup)) return;

    // Do NOT rebuild the editor tree while the root context menu is opening.
    // Firefox/Zen can still be constructing context-dependent branches then.
    // A nested submenu is safe to refresh after its own popupshown event.
    const rootPopup = menuItemsContainer(state.activeMenu, root);
    if (popup === root || popup === rootPopup) return;

    renderRowsOnly();
  }

  // Root context menus are deliberately not rediscovered during popupshown:
  // doing so used to flatten transient parent/child relationships. Refresh once
  // the root popup has closed instead. At that point its popupshowing handlers
  // have completed, but persistent DOM-created entries (such as Zia's menu
  // items) remain available to discovery. WebExtension entries that Firefox
  // removes on close are still represented by the live ExtensionMenus registry.
  function refreshEditorTreeAfterRootPopupClosed(popup) {
    if (!rowContainer()) return;

    const menuId = state.activeMenu;
    const root = menuScope(menuId);
    if (!root) return;
    const rootPopup = menuItemsContainer(menuId, root);
    if (popup !== root && popup !== rootPopup) return;

    setTimeout(() => {
      if (!rowContainer() || state.activeMenu !== menuId) return;
      const currentRoot = menuScope(menuId);
      if (!currentRoot) return;
      const currentPopup = menuItemsContainer(menuId, currentRoot);
      if (popup !== currentRoot && popup !== currentPopup) return;
      renderRowsOnly();
    }, 0);
  }

  function installHiddenStyleWatcher() {
    if (state.hiddenWatcherInstalled) return;
    state.hiddenWatcherInstalled = true;

    for (const menuId of Object.keys(state.config?.menus || {})) {
      installHiddenObserver(menuId);
    }

    // The hamburger menu is a <panel>, not a <menupopup>. PanelMultiView may
    // materialize its main view during opening, so apply on both the panel and
    // the view's own lifecycle and re-resolve the root each time.
    const applyApplicationMenu = () => {
      if (!state.config?.menus?.[APP_MENU_VIEW_ID]) return;
      const view = menuScope(APP_MENU_VIEW_ID);
      if (!view) return;
      installHiddenObserver(APP_MENU_VIEW_ID);
      applyHiddenRulesToMenu(APP_MENU_VIEW_ID);
      applyOrderRulesToMenu(APP_MENU_VIEW_ID);
      applyLabelRulesToMenu(APP_MENU_VIEW_ID);
      restoreEdgeSeparators();
      cleanEdgeSeparators(APP_MENU_VIEW_ID);
    };

    document.addEventListener(
      "ViewShowing",
      event => {
        if (trim(event.target?.id) !== APP_MENU_VIEW_ID) return;
        queueMicrotask(applyApplicationMenu);
        setTimeout(applyApplicationMenu, 0);
      },
      true
    );

    for (const eventName of ["popupshowing", "popupshown"]) {
      document.addEventListener(
        eventName,
        event => {
          const popup = event.target;
          if (
            String(popup?.localName || "").toLowerCase() !== "panel" ||
            trim(popup.id) !== APP_MENU_PANEL_ID
          ) return;
          applyApplicationMenu();
          queueMicrotask(applyApplicationMenu);
          setTimeout(applyApplicationMenu, 0);
        },
        false
      );
    }

    // Bubble-phase popupshowing is intentional. Firefox's own context-menu
    // handlers get a chance to create/show/hide entries first; our pass then
    // applies the user's rules to the resulting XUL nodes.
    document.addEventListener(
      "popupshowing",
      event => {
        const popup = event.target;
        if (
          !popup ||
          String(popup.localName || "").toLowerCase() !== "menupopup"
        ) {
          return;
        }

        monitorStart(popup);
        applyRulesForPopup(popup);

        // Other popupshowing listeners registered after this one (or async
        // rebuilds queued during dispatch) still run after our pass above —
        // Zen rebuilds tabContextMenu on every opening, wiping the hidden
        // state we just set. This microtask runs once the whole event has
        // finished dispatching, still before the menu paints, so the rebuilt
        // entries are hidden without a flicker.
        queueMicrotask(() => applyRulesForPopup(popup));

        // Some Zen menu handlers defer their final state to the next task,
        // after popupshowing has completely unwound.  The observer above
        // covers node/attribute changes, while this final pass also covers a
        // replacement popup that arrives as part of that deferred work.
        setTimeout(() => applyRulesForPopup(popup), 0);
      },
      false
    );

    // Re-apply after the menu is fully shown. This catches rebuilds that land
    // between popupshowing and popupshown — the window where "we hid it but
    // the entry is still in the menu" comes from. The menu element may have
    // been swapped out entirely; applyRulesForPopup() re-resolves it by id,
    // so the pass and the observer both land on the live element.
    document.addEventListener(
      "popupshown",
      event => {
        const popup = event.target;
        if (
          !popup ||
          String(popup.localName || "").toLowerCase() !== "menupopup"
        ) {
          return;
        }

        monitorPopupShown(popup);
        applyRulesForPopup(popup);
        setTimeout(() => {
          monitorPopupShown(popup);
          applyRulesForPopup(popup);
          refreshEditorTreeForPopup(popup);
        }, 0);
      },
      false
    );

    document.addEventListener(
      "popuphidden",
      event => {
        const popup = event.target;
        if (
          !popup ||
          String(popup.localName || "").toLowerCase() !== "menupopup"
        ) {
          return;
        }

        monitorFinish(popup, "popuphidden");
        refreshEditorTreeAfterRootPopupClosed(popup);
      },
      false
    );

    console.info(
      "[menu-editor:monitor] passive context-menu monitoring enabled; " +
      "inspect __menuEditor.monitor.report() for captured sessions"
    );
  }

  // ===========================================================================
  // LIVE DISCOVERY
  // ===========================================================================

  const APP_MENU_L10N_FALLBACKS = Object.freeze({
    "appmenuitem-new-tab": "New Tab",
    "appmenuitem-new-window": "New Window",
    "appmenuitem-new-private-window": "New Private Window",
    "appmenuitem-new-blank-window": "New Blank Window",
    "appmenuitem-new-smart-window": "New Smart Window",
    "zen-appmenu-new-blank-window": "New Blank Window",
    "zen-appmenu-new-smart-window": "New Smart Window",
    "zen-appmenu-smart-window": "New Smart Window",
    "appmenuitem-new-ai-window": "New AI Window",
    "appmenuitem-new-classic-window": "New Classic Window",
    "appmenuitem-tab-groups": "Tab Groups",
    "library-bookmarks-menu": "Bookmarks",
    "appmenuitem-history": "History",
    "menu-history-chats": "Chat History",
    "appmenuitem-downloads": "Downloads",
    "appmenuitem-passwords": "Passwords",
    "appmenuitem-extensions-and-themes": "Extensions and Themes",
    "appmenuitem-extensions": "Extensions",
    "appmenuitem-print": "Print...",
    "appmenuitem-save-page": "Save Page As...",
    "appmenuitem-find-in-page": "Find in Page...",
    "appmenuitem-translate": "Translate",
    "appmenuitem-zoom": "Zoom",
    "appmenuitem-settings": "Settings",
    "appmenuitem-more-tools": "More Tools",
    "appmenuitem-report-broken-site": "Report Broken Site",
    "appmenuitem-help": "Help and Report",
    "appmenuitem-exit2": "Exit",
  });

  function applicationMenuRowLabel(node) {
    if (!node) return "";

    const localizedFallback = candidate => {
      const id = trim(candidate?.getAttribute?.("data-l10n-id"));
      if (!id) return "";
      if (APP_MENU_L10N_FALLBACKS[id]) return APP_MENU_L10N_FALLBACKS[id];
      return id.replace(/^appmenuitem-/, "").replace(/[-_]+/g, " ")
        .replace(/\b\w/g, character => character.toUpperCase());
    };

    const readAttributes = candidate => {
      if (!candidate) return "";
      return (
        trim(candidate.getAttribute?.("label")) ||
        trim(candidate.getAttribute?.("value")) ||
        trim(candidate.getAttribute?.("aria-label")) ||
        trim(candidate.getAttribute?.("tooltiptext")) ||
        trim(candidate.label) ||
        trim(candidate.value)
      );
    };

    // Prefer explicit attributes over textContent. A toolbarbutton can contain
    // badges (for example BETA) as well as its title, and those badges must not
    // become part of the editable menu label.
    const ownAttribute = readAttributes(node);
    if (ownAttribute) return ownAttribute;

    // Compound rows expose their editable title through a child label or
    // .toolbarbutton-text (the profile/account header and Zoom control row).
    const candidates = Array.from(
      node.querySelectorAll?.(".toolbarbutton-text, label, toolbarbutton") || []
    );
    for (const candidate of candidates) {
      const value = readAttributes(candidate) ||
        trim(candidate.textContent).replace(/\s+/g, " ") ||
        localizedFallback(candidate);
      if (value) return value;
    }

    const ownLocalized = localizedFallback(node);
    if (ownLocalized) return ownLocalized;

    return trim(node.textContent).replace(/\s+/g, " ");
  }

  // Discovery policy: a registered extension item is only a real candidate
  // while Firefox considers it visible. A saved selector without a live node or
  // active registry entry is not deleted; it is retained as an unverified rule
  // until a later menu opening proves that it is a dynamic/lazy item.
  // Kept as pure predicates so the policy can be regression-tested without
  // booting the whole browser-chrome userscript.
  const DISCOVERY_POLICY = Object.freeze({
    isRuntimeVisible(record) {
      return record?.runtimeVisible !== false;
    },
    savedRuleStatus({ registryConfirmed, previouslyObserved } = {}) {
      if (registryConfirmed) return "registered";
      if (previouslyObserved) return "dormant";
      return "unverified";
    },
    isRuntimeHidden(row) {
      const node = row?.disc?.el;
      if (!node?.isConnected) return false;

      // If any editor-owned hide reason changed a previously visible node to
      // hidden, do not confuse that state with a dynamic condition imposed by
      // Firefox or another mod. The shared original-state map covers both
      // unconditional hide rules and context-specific restrictions.
      const editorState = editorHiddenOriginalState.get(node);
      if (editorState && editorState.hidden === false) return false;

      return !!(
        node.hidden === true ||
        node.hasAttribute?.("hidden") ||
        node.getAttribute?.("collapsed") === "true"
      );
    },
    isStableIdentitySelector(selector) {
      return /^#[\w-]+$/.test(trim(selector));
    },
  });

  // DOM-created menu entries (including entries added by extensions outside the
  // WebExtension menus API) have no central registry. Remember entries actually
  // observed in this session so a lazy item can remain editable after its popup
  // closes. This is deliberately session-only evidence: we never infer that an
  // arbitrary old selector is still alive merely because it is in menu-config.
  const OBSERVED_MENU_SELECTOR_LIMIT = 512;
  const observedMenuRuleSelectors = new Map();

  function observedMenuSelectors(menuId, create = false) {
    const id = text(menuId);
    let selectors = observedMenuRuleSelectors.get(id);
    if (!selectors && create) {
      selectors = new Map();
      observedMenuRuleSelectors.set(id, selectors);
    }
    return selectors || null;
  }

  function rememberObservedSelector(menuId, selector, metadata = {}) {
    const key = trim(selector);
    if (!key) return;

    const selectors = observedMenuSelectors(menuId, true);
    const previous = selectors.get(key) || {};
    selectors.delete(key);
    selectors.set(key, {
      ...previous,
      ...metadata,
      lastSeenAt: Date.now(),
    });

    while (selectors.size > OBSERVED_MENU_SELECTOR_LIMIT) {
      selectors.delete(selectors.keys().next().value);
    }
  }

  function rememberObservedMenuRows(menuId, discoveredRows, parentSelector = "") {
    const liveRows = (discoveredRows || []).filter(
      row => row?.el && row.el.isConnected && row.type !== "separator"
    );
    if (!liveRows.length) return;

    const metadataFor = row => ({
      label: trim(row.label || row.el?.getAttribute?.("label") || row.el?.getAttribute?.("tooltiptext")),
      type: row.type === "menu" ? "menu" : "menuitem",
      id: trim(row.id || row.el?.id) || null,
      extensionName: trim(row.extensionName) || null,
      fromExtension: !!row.fromExtension,
      // A nested child that later becomes detached can still be reattached
      // under the same parent in the editor's dormant tree. Root discovery
      // does not overwrite this field because it has no parent selector.
      ...(trim(parentSelector) ? { parentSelector: trim(parentSelector) } : {}),
    });

    for (const row of liveRows) {
      const metadata = metadataFor(row);
      const canonical = suggestSelector(row);
      if (canonical) rememberObservedSelector(menuId, canonical, metadata);

      const id = trim(row.id || row.el?.id);
      if (id) rememberObservedSelector(menuId, `#${escapeCss(id)}`, metadata);
    }

    // A stored attribute selector may not be the editor's canonical #id selector.
    // Record it only after it has actually matched at least one live node.
    for (const rule of allRules(menuId)) {
      if (!rule?.selector || isSeparatorSelector(rule.selector)) continue;
      const matched = liveRows.find(row =>
        selectorMatchesNode(row.el, rule.selector)
      );
      if (matched) {
        rememberObservedSelector(
          menuId,
          rule.selector,
          metadataFor(matched)
        );
      }
    }
  }

  function wasRuleObserved(menuId, selector) {
    return !!observedMenuSelectors(menuId)?.has(trim(selector));
  }

  function observedRuleMetadata(menuId, selector) {
    return observedMenuSelectors(menuId)?.get(trim(selector)) || null;
  }

  function discover(menuId, capturedRows, options = {}) {
    const applicationMenu = isApplicationMenu(menuId);

    // The hamburger menu is a PanelMultiView browser-chrome surface, not a
    // WebExtension context menu. The shared menu engine's fallback discovery
    // can contain context-menu registrations captured for another popup. Never
    // ask it to populate this surface; discover its actual panelview DOM only.
    const e =
      options?.includeEngine === false || applicationMenu
        ? null
        : engine();
    const engineSnapshot = e?.discover
      ? safeCall(() => e.discover(menuId, capturedRows), { rows: [], total: 0 })
      : { rows: [], total: 0 };

    const menu = menuElement(menuId);
    const popup = menuItemsContainer(menuId, menu);

    const engineRows = Array.isArray(engineSnapshot?.rows)
      ? engineSnapshot.rows
      : [];

    // Engine snapshots are a fallback for chrome surfaces whose live container
    // is not available yet. Never let an unscoped extension registration travel
    // through that fallback: registry-only extension rows are synthesized below
    // from ExtensionMenus only for an explicitly supported context root.
    const isExtensionEngineRow = row => {
      if (
        row?.fromExtension || row?.registryOnly || row?.extensionId ||
        row?.extensionKey || row?.extensionMenuId != null
      ) {
        return true;
      }
      const identity = [row?.id, row?.elementId, row?.selector]
        .map(value => text(value))
        .join(" ");
      return /-menuitem-[^\s#]+/.test(identity);
    };
    const safeEngineFallbackRows = engineRows.filter(
      row => !isExtensionEngineRow(row)
    );

    // The engine may intentionally filter out extension-created nodes. For the
    // editor, that filter is undesirable: every direct child that Firefox can
    // actually display is a reorderable entry.
    // The root-level entries of the menu.
    //
    // Only direct children are collected in this pass. buildRows() later walks
    // each live <menu>'s direct <menupopup> so native nested items can become
    // child rows without flattening them into the root menu order.
    const liveRows = [];
    let separatorIndex = 0;

    if (popup) {
      if (options?.assignAnonymousKeys !== false) {
        prepareAnonymousNodeKeys(menuId, popup);
      }

      for (const node of Array.from(popup.children)) {
        const localName = String(node.localName || "").toLowerCase();

        const isSeparator = isMenuSeparatorNode(node, menuId);
        const isEntry = isMenuEntryNode(node, menuId);
        if (!isSeparator && !isEntry) continue;

        const extensionMeta = extensionMetaFromNode(node);

        // WebExtension context-menu items do not belong in Zen's hamburger
        // main view. If an extension-generated node is present in a stale,
        // shared, or incorrectly resolved container, do not present it as an
        // editable Application-menu row.
        if (applicationMenu && extensionMeta.fromExtension) continue;

        const index = liveRows.length;

        if (isSeparator) {
          const stableSeparatorIndex = separatorRuleIndexForNode(
            node,
            popup,
            separatorIndex
          );
          separatorIndex++;
          liveRows.push({
            type: "separator",
            index,
            separatorIndex: stableSeparatorIndex,
            id: node.id || null,
            label: node.getAttribute("label") || "",
            hidden: !!node.hidden,
            el: node,
            ...extensionMeta,
          });
          continue;
        }

        const id = trim(node.id);
        const label = applicationMenu
          ? applicationMenuRowLabel(node)
          : (
              trim(node.getAttribute("label")) ||
              trim(node.getAttribute("tooltiptext")) ||
              trim(node.getAttribute("aria-label"))
            );

        // The main view contains an intentionally empty toolbaritem placeholder
        // (appMenu-menu-message). Do not expose it as an editable row until Zen
        // or Firefox actually populates it with meaningful content.
        if (applicationMenu && !label) {
          // Includes the empty appMenu-menu-message placeholder and hidden
          // banners with no user-facing title. A later structural mutation will
          // cause discovery to run again if one becomes a real menu row.
          continue;
        }

        const ownPopup = node.querySelector?.(":scope > menupopup");

        liveRows.push({
          // Toolbaritems are atomic app-menu rows (for example, Zoom controls),
          // not submenus whose internal buttons should be reordered separately.
          type: localName === "menu" ? "menu" : "menuitem",
          index,
          id: id || null,
          label,
          tooltiptext: trim(node.getAttribute("tooltiptext")),
          hidden: !!node.hidden,
          disabled: !!node.hasAttribute?.("disabled"),
          childCount: ownPopup ? ownPopup.children.length : 0,
          el: node,
          ...extensionMeta,
        });
      }
    }

    // Prefer the complete live DOM snapshot whenever the menu has been built.
    // Keep engine metadata for nodes the engine knows about (for example a more
    // specific extensionMenuId discovered by the executor).
    const byId = new Map(
      engineRows
        .filter(row => row?.id)
        .map(row => [String(row.id), row])
    );

    for (const row of liveRows) {
      const engineRow = row.id ? byId.get(row.id) : null;
      if (engineRow) {
        const extensionMeta = extensionMetaFromNode(row.el);

        Object.assign(row, engineRow, {
          el: row.el,
          index: row.index,
          hidden: row.hidden,
          ...extensionMeta,
        });
      }
    }

    // A resolved live container is authoritative even when empty. Falling back
    // to engineRows for an empty popup can resurrect extension registrations
    // from another context. The Application menu is stricter: it never consumes
    // engine rows, even when its PanelMultiView body is still lazy/unavailable.
    const discoveredRows = applicationMenu
      ? liveRows
      : (popup ? liveRows : safeEngineFallbackRows);

    // This also runs for the passive popup monitor (includeEngine:false and
    // includeRegistry:false), so short-lived root entries are remembered even
    // though the editor intentionally avoids rebuilding its tree mid-popup.
    if (popup) rememberObservedMenuRows(menuId, discoveredRows);

    return {
      ...engineSnapshot,
      rows: discoveredRows,
      total: discoveredRows.length,
      registry:
        applicationMenu || options?.includeRegistry === false
          ? []
          : extensionMenuRegistry(menuId),
    };
  }

  function menuElement(menuId) {
    const live = document.getElementById(menuId);
    if (live) return live;

    // Before the hamburger menu has been opened, PanelMultiView may still keep
    // the main view in its inert template cache. Use that source as a fallback;
    // popup/ViewShowing lifecycle hooks reapply the same rules to its live view.
    if (isApplicationMenu(menuId)) {
      // PanelMultiView documents getViewNode() as the supported way to resolve
      // lazily cached views. Not every Zen/Firefox build exposes it globally, so
      // retain direct template/panel fallbacks for older chrome implementations.
      try {
        const resolved = globalThis.PanelMultiView?.getViewNode?.(document, menuId);
        if (resolved) return resolved;
      } catch (error) {
        console.debug("[menu-editor] PanelMultiView view lookup fallback:", error);
      }

      const cache = document.getElementById("appMenu-viewCache");
      return (
        cache?.content?.querySelector?.(`#${APP_MENU_VIEW_ID}`) ||
        document.getElementById(APP_MENU_PANEL_ID)?.querySelector?.(`#${APP_MENU_VIEW_ID}`) ||
        null
      );
    }

    return null;
  }

  let extensionInternals = null;
  let extensionInternalsAttempted = false;
  let extensionInternalsRetryAt = 0;

  function loadExtensionInternals() {
    // Cache a successful import, but do not turn a startup race into a
    // permanent failure. Extension modules can become available after the
    // browser window and this userscript have started.
    if (extensionInternals) return extensionInternals;
    if (
      extensionInternalsAttempted &&
      Date.now() < extensionInternalsRetryAt
    ) {
      return null;
    }

    extensionInternalsAttempted = true;

    try {
      const { ExtensionParent } = ChromeUtils.importESModule(
        "resource://gre/modules/ExtensionParent.sys.mjs"
      );
      const { ExtensionMenus } = ChromeUtils.importESModule(
        "resource://gre/modules/ExtensionMenus.sys.mjs"
      );

      extensionInternals = { ExtensionParent, ExtensionMenus };
      extensionInternalsRetryAt = 0;
    } catch (error) {
      // Avoid hammering module loading on every render, while still retrying
      // soon enough to recover from an early-window startup race.
      extensionInternalsRetryAt = Date.now() + 2000;
      extensionInternals = null;
      console.warn(
        "[menu-editor] extension menu internals unavailable; will retry:",
        error
      );
    }

    return extensionInternals;
  }

  function makeExtensionElementId(extensionId, menuItemId) {
    // Firefox uses ExtensionCommon.makeWidgetId() for the extension prefix.
    // Reproducing the small transformation here avoids relying on private
    // globals, while matching the IDs Firefox creates for context-menu items.
    const widgetId = text(extensionId)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");

    let id = menuItemId;
    if (typeof id !== "number") id = `_${id}`;

    return `${widgetId}-menuitem-${id}`;
  }

  function extensionMetaFromNode(node) {
    const id = trim(node?.id);
    if (!id) return {};

    // Match the Firefox-generated extension menu-item ID shape:
    // <makeWidgetId(extensionId)>-menuitem-<id>.
    const match = id.match(/^(.*)-menuitem-(.+)$/);
    if (!match) return {};

    const rawMenuItemId = match[2];
    const stringMenuItemId = rawMenuItemId.startsWith("_");

    return {
      fromExtension: true,
      extensionId: match[1],
      extensionKey: match[0],

      // Firefox prefixes string menu item ids with "_" in the DOM. Keep the
      // normalized text for selectors/legacy config, but also retain the ID
      // type: numeric 7 and string "7" are different WebExtension IDs and
      // must never be merged just because their text is equal.
      extensionMenuId: stringMenuItemId
        ? rawMenuItemId.slice(1)
        : rawMenuItemId,
      extensionMenuIdType: stringMenuItemId ? "string" : "number",
      extensionMenuIdRaw: rawMenuItemId,

      // Firefox may collapse multiple context-eligible extension items into
      // ONE parent <menu> (buildTopLevelElements with maxCount 1). That element
      // is built from the extension's synthetic root,
      // so its id tail is a generated number that matches NO registered item.
      // The attribute is what identifies it, and the widget-id prefix is what
      // ties it back to the owning extension.
      collapsedContainer:
        node.getAttribute?.("ext-type") === "top-level-menu" || undefined,
    };
  }

  function extensionMenuRegistry(menuId) {
    // The WebExtension menus registry describes entries that can appear in
    // specific extension context menus (page, tab, bookmark, action, etc.).
    // It is NOT a catalogue of entries that belong in every browser-chrome
    // surface. In particular, the hamburger menu, More Tools, toolbar menus,
    // Downloads, History, and other chrome panels must never receive page
    // registrations merely because their IDs do not contain the word "tab".
    // Live extension nodes are still discovered from the actual menu DOM by
    // discover(); this guard prevents synthetic registry-only rows from
    // leaking into unrelated menus.
    if (!supportsExtensionRegistryMenu(menuId)) return [];

    const internals = loadExtensionInternals();
    if (!internals) return [];

    const { ExtensionParent, ExtensionMenus } = internals;
    const result = [];
    const targetMenuNode = menuElement(menuId);
    const targetMenuId = trim(targetMenuNode?.id || menuId);
    const targetWidgetPrefix = targetMenuId.split("-menuitem-")[0];
    const targetLooksLikeExtensionMenu = targetMenuId.includes("-menuitem-");
    const targetIsCollapsedRoot =
      targetMenuNode?.getAttribute?.("ext-type") === "top-level-menu";

    const normalizeContexts = value => {
      if (Array.isArray(value)) return value.map(text).filter(Boolean);
      if (typeof value === "string") return value ? [value] : [];
      try {
        if (value && typeof value[Symbol.iterator] === "function") {
          return [...value].map(text).filter(Boolean);
        }
      } catch (_) {}
      return [];
    };

    try {
      const extensions =
        ExtensionParent.GlobalManager?.extensionMap?.values?.();
      if (!extensions) return [];

      for (const extension of extensions) {
        let menus;
        try {
          menus = ExtensionMenus.getMenus(extension);
        } catch (_) {
          continue;
        }

        // ExtensionMenus' map belongs to a different JS realm. Deliberately use
        // its Map-like interface instead of an instanceof check.
        if (!menus || typeof menus.entries !== "function") continue;

        const widgetPrefix = makeExtensionElementId(
          extension.id,
          "__probe__"
        ).split("-menuitem-")[0];
        const targetIsThisExtensionMenu =
          !!targetMenuId && targetWidgetPrefix === widgetPrefix;

        if (targetLooksLikeExtensionMenu && !targetIsThisExtensionMenu) {
          continue;
        }

        const recordsById = new Map();
        const recordsByStringId = new Map();
        const records = [];
        const typedIdKey = value => `${typeof value}\u0000${String(value)}`;
        const findRecordById = value => {
          const exact = recordsById.get(typedIdKey(value));
          if (exact) return exact;
          const candidates = recordsByStringId.get(String(value)) || [];
          return candidates.length === 1 ? candidates[0] : null;
        };

        for (const [menuItemId, properties] of menus.entries()) {
          if (!properties) continue;
          const idKey = typedIdKey(menuItemId);
          // WebExtension IDs may be strings or integers. Preserve the type so
          // numeric 7 and string "7" do not collapse into one logical item.
          if (recordsById.has(idKey)) continue;

          const selectorId = makeExtensionElementId(
            extension.id,
            menuItemId
          );
          const record = {
            menuItemId,
            parentId: properties.parentId ?? null,
            extensionId: extension.id,
            extensionName: extension.name || extension.id,
            title: trim(properties.title) || extension.name || String(menuItemId),
            type: text(properties.type || "normal").toLowerCase(),
            runtimeVisible: properties.visible !== false,
            selector: `#${escapeCss(selectorId)}`,
            elementId: selectorId,
            children: [],
            _properties: properties,
            _contextsResolved: false,
            contexts: [],
          };
          recordsById.set(idKey, record);
          if (!recordsByStringId.has(String(menuItemId))) {
            recordsByStringId.set(String(menuItemId), []);
          }
          recordsByStringId.get(String(menuItemId)).push(record);
          records.push(record);
        }

        // Resolve inherited contexts before filtering. Firefox's MenuItem
        // defaults a root registration to ["all"]; a child without its own
        // contexts inherits its parent's effective contexts. Firefox's runtime
        // context set includes "all" for page/frame contexts, but not for tab,
        // bookmark, or tools-menu contexts, which contextsFitMenu() models below.
        const resolveContexts = (record, visiting = new Set()) => {
          if (record._contextsResolved) return record.contexts;
          const key = typedIdKey(record.menuItemId);
          if (visiting.has(key)) return ["page"];
          const nextVisiting = new Set(visiting);
          nextVisiting.add(key);

          const own = normalizeContexts(record._properties?.contexts);
          if (own.length) {
            record.contexts = own;
          } else if (record.parentId != null) {
            const parent = findRecordById(record.parentId);
            record.contexts = parent
              ? [...resolveContexts(parent, nextVisiting)]
              : ["page"];
          } else {
            // Mirrors MenuItem.setDefaults() in Firefox's ext-menus.js:
            // a root item without an explicit contexts field defaults to "all".
            record.contexts = ["all"];
          }

          record._contextsResolved = true;
          return record.contexts;
        };
        for (const record of records) resolveContexts(record);

        const roots = [];
        for (const record of records) {
          if (record.parentId == null) {
            roots.push(record);
            continue;
          }
          const parent = findRecordById(record.parentId);
          let cursor = parent;
          const visited = new Set();
          let wouldCycle = false;
          while (cursor && !visited.has(cursor)) {
            if (cursor === record) {
              wouldCycle = true;
              break;
            }
            visited.add(cursor);
            cursor = cursor.parentId == null
              ? null
              : findRecordById(cursor.parentId);
          }
          if (!parent || parent === record || wouldCycle) {
            // Keep orphaned/cyclic registrations visible rather than silently
            // losing them or recursing forever. The broken relationship remains
            // available for diagnostics in orphanedParentId.
            record.orphanedParentId = record.parentId;
            roots.push(record);
          } else {
            parent.children.push(record);
          }
        }

        let selectedRoots = roots;
        let isSubmenuScope = false;

        if (targetIsThisExtensionMenu && !targetIsCollapsedRoot) {
          let parentRecord = null;
          for (const record of records) {
            if (
              makeExtensionElementId(extension.id, record.menuItemId) ===
              targetMenuId
            ) {
              parentRecord = record;
              break;
            }
          }

          if (!parentRecord || !contextsFitMenu(parentRecord.contexts, menuId)) continue;
          selectedRoots = parentRecord.children;
          isSubmenuScope = true;
        }

        // Clone only context-eligible branches. The parent must be eligible for
        // this menu before its children can appear; descendants remain nested
        // under their registered parent regardless of title or DOM position.
        const cloneEligible = record => {
          // Firefox's MenuItem.enabledForContext() rejects visible:false before
          // checking contexts. A hidden parent suppresses its entire branch.
          if (
            !DISCOVERY_POLICY.isRuntimeVisible(record) ||
            !contextsFitMenu(record.contexts, menuId)
          ) return null;
          const children = [];
          for (const child of record.children || []) {
            const clone = cloneEligible(child);
            if (clone) children.push(clone);
          }
          const {
            _properties,
            _contextsResolved,
            ...publicRecord
          } = record;
          return {
            ...publicRecord,
            children,
            registrySubmenu: isSubmenuScope,
          };
        };

        for (const record of selectedRoots) {
          const clone = cloneEligible(record);
          if (clone) result.push(clone);
        }
      }
    } catch (error) {
      console.warn(
        "[menu-editor] extension registry discovery failed:",
        error
      );
    }

    return result;
  }

  // A stable selector for a collapsed extension parent.
  //
  // Firefox builds that <menu> from the extension's synthetic root, whose id
  // tail is gNextMenuItemID — a counter that advances as extensions register
  // items, so the exact id changes between sessions and a rule written against
  // it would quietly stop matching. The widget-id prefix IS stable, and
  // ext-type="top-level-menu" is what marks the element, so the selector keys on
  // those instead of the number.
  // Whether a node is the collapsed parent an extension's entries sit inside.
  //
  // The widget id is compared because Firefox derives both the parent's id and
  // every registered item's element id from it, while the id tails differ: the
  // parent's tail is a counter and the items' tails are their menu ids. The raw
  // extension id (with braces) is deliberately not used here, since the DOM only
  // ever exposes the lowercased, underscored form.
  function widgetIdOf(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
  }

  function collapsedParentSelector(discoveredRow) {
    const id = trim(discoveredRow?.id);
    const marker = id.indexOf("-menuitem-");

    if (marker < 0) return "";

    const prefix = id.slice(0, marker);
    if (!prefix) return "";

    return `menu[ext-type="top-level-menu"][id^="${escapeCss(
      prefix
    )}-menuitem-"]`;
  }

  function suggestSelector(discoveredRow) {
    if (discoveredRow?.collapsedContainer) {
      const stable = collapsedParentSelector(discoveredRow);
      if (stable) return stable;
    }

    // Prefer the exact DOM ID when it exists. Firefox generates extension menu
    // IDs from the extension ID plus the menu item ID, so this is collision-free.
    const id = trim(discoveredRow?.id);

    if (id) {
      return `#${escapeCss(id)}`;
    }

    const elementId = trim(discoveredRow?.elementId);

    if (elementId) {
      return `#${escapeCss(elementId)}`;
    }

    const anonymousKey = trim(
      discoveredRow?.el?.getAttribute?.(ANONYMOUS_KEY_ATTR)
    );
    if (anonymousKey) {
      return `[${ANONYMOUS_KEY_ATTR}="${anonymousKey}"]`;
    }

    const extensionKey = trim(discoveredRow?.extensionKey);

    if (extensionKey) {
      return `[id*="${escapeCss(extensionKey)}"]`;
    }

    const menuItemId = trim(discoveredRow?.extensionMenuId);

    if (menuItemId) {
      // Firefox writes "-menuitem-_<id>" for string ids but "-menuitem-<n>"
      // for the auto-generated numeric ones, so both spellings are offered.
      const escaped = escapeCss(menuItemId);

      return (
        `[id*="menuitem-_${escaped}"], ` +
        `[id*="menuitem-${escaped}"]`
      );
    }

    const label = trim(discoveredRow?.label);

    if (label) {
      const escaped = label
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      const localName = String(discoveredRow?.el?.localName || "menuitem").toLowerCase();
      const selectorTag = /^[a-z][a-z0-9-]*$/.test(localName) ? localName : "menuitem";
      return `${selectorTag}[label="${escaped}"]`;
    }

    return "";
  }

  function rowMatchesRule(menuId, discoveredRow, entry) {
    if (!entry || !entry.selector) return false;

    if (isSeparatorSelector(entry.selector)) {
      return (
        discoveredRow.type === "separator" &&
        discoveredRow.separatorIndex !== undefined &&
        Number(discoveredRow.separatorIndex) ===
          Number(entry.selector.split(":")[1])
      );
    }

    const e = engine();
    const menu = menuElement(menuId);

    // Match the actual live XUL node first.  The old engine-free path compared
    // only suggestSelector(row) with the saved selector.  That loses valid
    // rules which intentionally use an attribute selector (for example
    // menuitem[label="Share"]): the item appeared once as unmanaged and once
    // again as an offline saved rule.  It also made the editor look as though a
    // hide rule had not been saved.  Node.matches() is available independently
    // of __menuEngine, and is the authoritative answer for a live row.
    const node =
      discoveredRow?.el ||
      (
        menu
          ? menu.children[discoveredRow?.index]
          : null
      );

    const boundNode = orderNodeBindings.get(
      orderBindingKey(menuId, entry.selector)
    );
    if (node && boundNode === node && node.isConnected) {
      return true;
    }

    if (node && selectorMatchesOrderEntry(node, entry)) {
      return true;
    }

    // Engine-free matching. This profile has no __menuEngine, and the early
    // "return false" below used to mean no rule ever matched a live row: after
    // adopting a menu every entry existed but buildRows() still reported them
    // unmanaged, which is what made drag/drop fail to remap its rows.
    //
    // Entries are written with the selector suggestSelector() produces for the
    // row, so comparing against that is the engine-independent equivalent.
    if (!e) {
      if (!discoveredRow) return false;

      const suggested = suggestSelector(discoveredRow);
      if (!suggested) return false;

      return splitSelectorList(suggested).some(
        part => part === entry.selector
      );
    }

    // The row carries the node it was built from, so the rule is matched against
    // that exact element. Falling back to an index is unsafe here: the menu is
    // rebuilt and asynchronously extended between the discovery snapshot and
    // this call, so the same index can point at a different entry by now.
    if (node && e.parts && e.matchElement) {
      try {
        return e
          .parts(entry.selector)
          .some(part => e.matchElement(node, part));
      } catch (_) {
        // Fall through to ID comparison.
      }
    }

    if (discoveredRow.id && e.parts) {
      try {
        return e
          .parts(entry.selector)
          .includes(`#${escapeCss(discoveredRow.id)}`);
      } catch (_) {
        return false;
      }
    }

    // A registry-only extension row has no DOM node. Its selector is generated
    // from the same element ID Firefox will use when the menu is opened.
    if (
      discoveredRow.registryOnly &&
      discoveredRow.elementId
    ) {
      return (
        entry.selector ===
        `#${escapeCss(discoveredRow.elementId)}`
      );
    }

    return false;
  }

  // Old config files can contain different selectors that all target the same
  // live entry (for example #context-copy and menuitem[label="Copy"]). If left
  // alone, one rule was attached to the live row and the other reappeared as an
  // offline row. Canonicalize one-to-one matches to the row's stable selector,
  // merging their settings and preserving pinned-tail placement.
  // Recognize the simple label selectors written by older editor versions.
  // They are inherently ambiguous when several items share a title, and an old
  // selector can also name the wrong XUL element type after the fallback logic
  // was corrected. Returning null keeps arbitrary CSS selectors untouched.
  function legacyLabelSelectorText(selector) {
    const match = trim(selector).match(
      /^(?:menu|menuitem)\s*\[\s*label\s*=\s*(["'])([\s\S]*?)\1\s*\]$/
    );
    if (!match) return null;
    return match[2].replace(/\\(["'\\])/g, "$1");
  }

  // A saved label selector may have been generated for <menuitem> even though
  // the live entry is a <menu> (or vice versa). Only use this compatibility
  // lookup when the original selector has no live matches at all.
  function liveRowsForRule(liveRows, selector) {
    const exact = liveRows.filter(row =>
      selectorMatchesNode(row.el, selector)
    );
    if (exact.length) return exact;

    const label = legacyLabelSelectorText(selector);
    if (label === null) return exact;

    return liveRows.filter(row => {
      const node = row?.el;
      const name = String(node?.localName || "").toLowerCase();
      return (
        (name === "menu" || name === "menuitem") &&
        node.getAttribute?.("label") === label
      );
    });
  }

  function cloneRuleForSelector(rule, selector) {
    return {
      ...rule,
      selector,
      ...(Array.isArray(rule.contexts)
        ? { contexts: [...rule.contexts] }
        : {}),
    };
  }

  function reconcileLiveRuleSelectors(menuId, discoveredRows) {
    const menu = menuConfig(menuId, false);
    if (!menu) return false;

    const liveRows = (discoveredRows || []).filter(
      row => row?.el && row.type !== "separator"
    );
    if (!liveRows.length) return false;

    let changed = false;
    const rules = [...menu.entries, ...menu.pinnedTail];

    for (const rule of rules) {
      if (!rule?.selector || isSeparatorSelector(rule.selector)) continue;

      const matches = liveRowsForRule(liveRows, rule.selector);
      if (!matches.length) continue;

      const canonicalPairs = matches.map(row => ({
        row,
        selector: suggestSelector(row),
      }));
      const canonicalSelectors = canonicalPairs.map(item => item.selector);

      // A migration is safe only when each generated selector identifies this
      // exact live node and no other node in the menu tree.
      const selectorsAreUnique =
        canonicalSelectors.every(Boolean) &&
        new Set(canonicalSelectors).size === canonicalSelectors.length;
      const selectorsAreExact = selectorsAreUnique && canonicalPairs.every(item => {
        const canonicalMatches = liveRows.filter(row =>
          selectorMatchesNode(row.el, item.selector)
        );
        return (
          canonicalMatches.length === 1 &&
          canonicalMatches[0].el === item.row.el
        );
      });
      if (!selectorsAreExact) continue;

      // A legacy label selector can match several real entries. Leaving it in
      // place binds the rule to only the first row in buildRows(), while the
      // remaining rows appear unmanaged and create yet more rules when edited.
      // Expand it into one stable rule per actual node, carrying the original
      // settings (including hidden:true) to every match.
      if (canonicalPairs.length > 1) {
        const sourcePinned = menu.pinnedTail.includes(rule);
        const sourceList = sourcePinned ? menu.pinnedTail : menu.entries;
        const sourceIndex = sourceList.indexOf(rule);
        const template = cloneRuleForSelector(rule, rule.selector);
        const replacements = [];

        for (const item of canonicalPairs) {
          const existing = findRule(menuId, item.selector);
          if (existing && existing !== rule) {
            const targetPinned = menu.pinnedTail.includes(existing);
            mergeEntryFields(existing, template);

            if (sourcePinned && !targetPinned) {
              removeRule(menuId, existing);
              menu.pinnedTail.push(existing);
            }
          } else {
            replacements.push(
              cloneRuleForSelector(template, item.selector)
            );
          }
        }

        removeRule(menuId, rule);
        const destination = sourcePinned ? menu.pinnedTail : menu.entries;
        destination.splice(
          Math.max(0, Math.min(sourceIndex, destination.length)),
          0,
          ...replacements
        );
        changed = true;
        continue;
      }

      const canonical = canonicalSelectors[0];
      if (!canonical || canonical === rule.selector) continue;

      const existing = findRule(menuId, canonical);
      const sourcePinned = menu.pinnedTail.includes(rule);

      if (existing && existing !== rule) {
        const targetPinned = menu.pinnedTail.includes(existing);
        mergeEntryFields(existing, rule);
        removeRule(menuId, rule);

        if (sourcePinned && !targetPinned) {
          removeRule(menuId, existing);
          menu.pinnedTail.push(existing);
        }
      } else {
        rule.selector = canonical;
      }

      changed = true;
    }

    if (changed) {
      const normalized = dedupeMenu(menu);
      menu.entries = normalized.entries;
      menu.pinnedTail = normalized.pinnedTail;
      // This is a lossless config migration; mark it as pending save so the old
      // alias selectors do not return on the next browser restart.
      state.dirty = true;
      // The migration replaces broad selectors with exact node selectors.
      // Re-run the live executor now so an already-open popup stays hidden
      // during the transition instead of waiting for its next popupshowing.
      applyHiddenStyles();
    }

    return changed;
  }

  // Include currently materialized descendants as well as root rows. A Share
  // entry can live inside a submenu, and reconciling only the first popup leaves
  // its old broad rule in place for the nested copy.
  function collectLiveRowsForReconciliation(menuId, rootRows) {
    const result = (rootRows || []).filter(
      row => row?.el && row.type !== "separator"
    );
    const visitedPopups = new Set();

    const visitMenu = (menuNode, parentSelector) => {
      const popup = menuNode?.querySelector?.(":scope > menupopup");
      if (!popup || visitedPopups.has(popup)) return;
      visitedPopups.add(popup);

      prepareAnonymousNodeKeys(menuId, popup, parentSelector);

      for (const childNode of Array.from(popup.children || [])) {
        const localName = String(childNode.localName || "").toLowerCase();
        if (localName !== "menu" && localName !== "menuitem") continue;

        const discovered = {
          ...extensionMetaFromNode(childNode),
          type: localName,
          id: trim(childNode.id) || null,
          label: trim(
            childNode.getAttribute?.("label") ||
            childNode.getAttribute?.("tooltiptext") ||
            childNode.getAttribute?.("aria-label")
          ),
          tooltiptext: trim(childNode.getAttribute?.("tooltiptext")),
          hidden: !!childNode.hidden,
          disabled: !!childNode.disabled,
          el: childNode,
        };
        result.push(discovered);

        if (localName === "menu") {
          const selector = suggestSelector(discovered);
          if (selector) visitMenu(childNode, selector);
        }
      }
    };

    for (const row of rootRows || []) {
      if (String(row?.el?.localName || "").toLowerCase() !== "menu") continue;
      const selector = suggestSelector(row);
      if (selector) visitMenu(row.el, selector);
    }

    return result;
  }

  // Collapse duplicate representations without collapsing two actual live XUL
  // nodes. Live identity is the DOM node itself; offline identity is the
  // canonical selector. This prevents a registry row and a saved/offline rule
  // for the same extension item from appearing twice.
  function dedupeBuiltRows(rows) {
    const result = [];
    const liveByNode = new Map();
    const liveByStableSelector = new Map();
    const offlineByIdentity = new Map();

    const mergeMetadata = (target, source) => {
      if (!target.entry && source.entry) {
        target.entry = source.entry;
        target.managed = true;
      }
      if (!target.disc && source.disc) target.disc = source.disc;
      if (!target.extensionName && source.extensionName) {
        target.extensionName = source.extensionName;
      }
      if (!target.contexts && source.contexts) target.contexts = source.contexts;
      target.childCount = Math.max(
        Number(target.childCount) || 0,
        Number(source.childCount) || 0
      );
      target.pinned = !!(target.pinned || source.pinned);
      const hasLiveNode = !!target.disc?.el?.isConnected;
      target.offline = hasLiveNode
        ? false
        : !!(target.offline && source.offline);
      // A live or registry-backed representation always wins over an
      // unverified/offline duplicate of the same stable ID.
      target.unverified = hasLiveNode
        ? false
        : !!(target.unverified && source.unverified);
      target.dormant = hasLiveNode
        ? false
        : !!(target.dormant && source.dormant);
      target.registryOnly = hasLiveNode
        ? false
        : !!(target.registryOnly || source.registryOnly);
      return target;
    };

    for (const row of rows) {
      const node = row?.disc?.el;
      const selector = trim(row?.entry?.selector || row?.selector);
      const identity = `${row?.menuId || ""}\u0000${row?.kind || "entry"}\u0000${selector}`;
      const stableId = DISCOVERY_POLICY.isStableIdentitySelector(selector)
        ? identity
        : "";

      let existing = node ? liveByNode.get(node) : null;
      if (!existing && node && stableId) {
        const existingLive = liveByStableSelector.get(identity);
        if (existingLive?.disc?.el && existingLive.disc.el !== node) {
          // Duplicate IDs in the same menu scope are invalid DOM identity, but
          // both nodes are real and connected. Keep both rows (reordering them
          // independently may be ambiguous) and make the collision explicit.
          existingLive.identityCollision = true;
          row.identityCollision = true;
        }

        // A previous config-only row with the same exact #id must be replaced
        // by the live row. Broad selectors are intentionally excluded because
        // they can legitimately match several different native menu entries.
        existing = offlineByIdentity.get(identity);
        if (existing) {
          const index = result.indexOf(existing);
          if (index >= 0) result.splice(index, 1, row);
          offlineByIdentity.delete(identity);
          liveByNode.set(node, row);
          liveByStableSelector.set(identity, row);
          mergeMetadata(row, existing);
          continue;
        }
      }
      if (!existing && !node) {
        existing = offlineByIdentity.get(identity) ||
          (stableId ? liveByStableSelector.get(identity) : null);
      }

      if (!existing) {
        result.push(row);
        if (node) {
          liveByNode.set(node, row);
          if (stableId && !liveByStableSelector.has(identity)) {
            liveByStableSelector.set(identity, row);
          }
        } else {
          offlineByIdentity.set(identity, row);
        }
        continue;
      }

      // Never collapse two distinct live DOM nodes, even if a broad selector or
      // duplicated ID happens to point at both. Only the exact same node, or a
      // config-only row shadowed by a live exact-ID row, is coalesced.
      if (node && existing.disc?.el && existing.disc.el !== node) {
        result.push(row);
        continue;
      }
      mergeMetadata(existing, row);
    }

    return result;
  }

  // Orders the rows by the SAVED configuration rather than by the live menu DOM.
//
// Without this a reorder is invisible even though it succeeded: buildRows
// discovers rows by walking the live menu, and nothing here rewrites that menu
// (this profile has no __menuEngine), so re-rendering straight after a drop put
// every row back where the DOM had it. The rule really moved in the config; the
// list just refused to show it.
//
// Applied only when every row is managed — i.e. the menu has genuinely been
// taken control of, which is exactly when the user is rearranging it. A
// partially managed menu keeps its live order, because inventing a position for
// the unmanaged rows would shuffle those around for no reason.
function sortRowsByConfig(rows, menu) {
  if (!menu?.entries?.length || !rows.length) return rows;

  // Rows with no rule at all mean the menu is only partly adopted.
  if (rows.some(row => !row.entry)) return rows;

  const order = new Map();

  menu.entries.forEach(
    (entry, index) => order.set(entry, index)
  );

  // Pinned items keep their own order, after everything else.
  const pinnedBase = menu.entries.length + 1;

  (menu.pinnedTail || []).forEach(
    (entry, index) =>
      order.set(entry, pinnedBase + index)
  );

  const rank = row =>
    order.has(row.entry)
      ? order.get(row.entry)
      : Number.MAX_SAFE_INTEGER;

  return [...rows].sort(
    (a, b) => rank(a) - rank(b)
  );
  }

  // Preserve only recoverable descendants when a parent submenu is currently
  // hidden by its own runtime logic. Some mods keep the previous child nodes in
  // the menupopup instead of clearing them (Zia's Multiview Replace menu does
  // this when the current click no longer qualifies). Those nodes are connected,
  // but they are not currently reachable from the menu and must not be treated
  // as live entries. Saved rules remain available in Dormant / Unverified.
  function preserveUnavailableSubmenuTree(row, menuId) {
    const visit = child => {
      if (!child) return null;

      const selector = trim(child.entry?.selector || child.selector);
      const registered = !!(
        child.registryOnly ||
        child.disc?.registryOnly
      );
      const children = (child.children || [])
        .map(visit)
        .filter(Boolean);
      const hasRule = !!child.entry;

      if (child.disc?.el) {
        child.disc = {
          ...child.disc,
          el: null,
          staleNode: true,
        };
      }

      // An unmanaged DOM-only entry has no saved state to recover. If it has
      // registered or saved descendants, keep the structural parent instead.
      if (!hasRule && !registered && !children.length) return null;

      child.children = children;
      child.childCount = children.length;
      child.isGroupParent = children.length > 0 || !!child.isGroupParent;
      child.offline = true;
      child.registryOnly = registered;

      if (hasRule && !registered) {
        const observed = wasRuleObserved(menuId, selector);
        child.dormant = observed;
        child.unverified = !observed;
      } else {
        child.dormant = false;
        child.unverified = false;
      }

      return child;
    };

    return (row.children || []).map(visit).filter(Boolean);
  }

  // Rebuild parent/child links for saved children that were observed inside a
  // submenu earlier in this session. This is especially important when a mod
  // hides its parent but leaves stale child nodes attached: the saved child
  // rules stay nested and dormant instead of leaking into the root list.
  function attachObservedDormantChildren(rows, menuId, menu) {
    for (const row of [...rows]) {
      if (!row?.entry || !row.offline) continue;
      const selector = trim(row.entry.selector || row.selector);
      const observed = observedRuleMetadata(menuId, selector);
      const childOrderParent = (menu?.childOrders || []).find(record =>
        (record?.order || []).some(item => trim(item) === selector)
      )?.parentSelector;
      const parentSelector = trim(
        observed?.parentSelector || row.entry?.parentSelector || childOrderParent
      );
      if (!parentSelector) continue;

      const parent = rows.find(candidate =>
        candidate !== row &&
        trim(candidate?.selector || candidate?.entry?.selector) === parentSelector
      );
      if (!parent) continue;

      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);

      row.parentSelector = parentSelector;
      row.childOrderParentSelector = parentSelector;
      row.isGroupChild = true;
      row.offline = true;
      row.dormant = true;
      row.unverified = false;
      row.disc = row.disc ? { ...row.disc, el: null, staleNode: true } : null;
      parent.children ||= [];
      if (!parent.children.some(child => child.entry === row.entry)) {
        parent.children.push(row);
      }
      parent.childCount = parent.children.length;
      parent.isGroupParent = parent.childCount > 0 || !!parent.isGroupParent;
      if (parent.disc) parent.disc.childCount = parent.childCount;
    }

    for (const parent of rows) {
      if (!parent?.children?.length) continue;
      parent.children = sortChildRowsByConfig(
        parent.children,
        menu,
        trim(parent.selector || parent.entry?.selector)
      );
    }
  }

  // Attach live XUL submenu contents to their parent rows. The extension
  // registry already supplies a tree for WebExtension menu entries, but native
  // Firefox menus (for example #context_moveTabToGroup) only appeared as a
  // single parent row. Reading the parent's direct <menupopup> children makes
  // the same drag/order model work for native and extension-created submenus.
  //
  // Existing registry rows are reused when possible, preserving their typed
  // ExtensionMenus metadata and any rules. Saved rules for submenu children
  // are pulled out of the temporary root/offline list and reattached beneath
  // the actual parent instead of being displayed at the wrong level.
  function attachLiveSubmenuRows(rows, menuId, menu, makeUniqueKey) {
    const takeExisting = (list, node, suggestedSelector) => {
      if (!Array.isArray(list)) return null;

      // Preserve identity before considering CSS matches. Two registered
      // extension items can share a broad selector, so a broad earlier match
      // must never steal the row whose actual DOM node is this exact node.
      let index = list.findIndex(candidate => candidate?.disc?.el === node);
      if (index < 0 && suggestedSelector) {
        index = list.findIndex(candidate =>
          trim(candidate?.entry?.selector || candidate?.selector) === suggestedSelector
        );
      }

      if (index < 0) {
        index = list.findIndex(candidate => {
          const candidateSelector = trim(
            candidate?.entry?.selector || candidate?.selector
          );
          if (
            candidateSelector &&
            selectorMatchesNode(node, candidateSelector)
          ) {
            return true;
          }
          return !!(
            candidate?.entry &&
            selectorMatchesOrderEntry(node, candidate.entry)
          );
        });
      }

      return index >= 0 ? list.splice(index, 1)[0] : null;
    };

    const attach = row => {
      if (!row) return;

      const node = row.disc?.el || null;
      const popup = node
        ? Array.from(node.children || []).find(
            child => String(child.localName || "").toLowerCase() === "menupopup"
          ) || null
        : null;
      const parentSelector = trim(
        row.childOrderParentSelector || row.selector || row.entry?.selector
      );
      const runtimeHidden = DISCOVERY_POLICY.isRuntimeHidden(row);

      if (runtimeHidden) {
        row.children = preserveUnavailableSubmenuTree(row, menuId);

        // Some extensions/mods hide a submenu parent but leave its previous
        // children attached to the popup. Those nodes are stale, not active.
        // Use them only as evidence for linking already-saved child rules back
        // to this parent; store no live node reference and mark the rows dormant.
        if (popup && parentSelector) {
          const knownEntries = new Set(
            row.children.map(child => child?.entry).filter(Boolean)
          );
          for (const childNode of Array.from(popup.children || [])) {
            const localName = String(childNode.localName || "").toLowerCase();
            if (!["menuitem", "menu"].includes(localName)) continue;

            const discovered = {
              ...extensionMetaFromNode(childNode),
              type: localName,
              id: trim(childNode.id) || null,
              label: trim(
                childNode.getAttribute?.("label") ||
                childNode.getAttribute?.("tooltiptext") ||
                childNode.getAttribute?.("aria-label")
              ),
              tooltiptext: trim(childNode.getAttribute?.("tooltiptext")),
              hidden: !!childNode.hidden,
              disabled: !!childNode.disabled,
              el: childNode,
            };

            const matchingEntry = allRules(menuId).find(entry =>
              !knownEntries.has(entry) && selectorMatchesOrderEntry(childNode, entry)
            );
            if (!matchingEntry) continue;
            if (
              matchingEntry.parentSelector &&
              trim(matchingEntry.parentSelector) !== parentSelector
            ) continue;

            rememberObservedMenuRows(menuId, [discovered], parentSelector);
            knownEntries.add(matchingEntry);
            row.children.push({
              key: makeUniqueKey(
                `${menuId}|dormant|${parentSelector}|${matchingEntry.selector}`
              ),
              kind: "entry",
              menuId,
              disc: {
                ...discovered,
                el: null,
                staleNode: true,
                registryOnly: false,
              },
              entry: matchingEntry,
              selector: matchingEntry.selector,
              managed: true,
              offline: true,
              dormant: true,
              unverified: false,
              parentSelector,
              childOrderParentSelector: parentSelector,
              isGroupChild: true,
              children: [],
              childCount: 0,
              isGroupParent: false,
              pinned: menu.pinnedTail.includes(matchingEntry),
            });
          }
        }

        row.children = sortChildRowsByConfig(
          row.children,
          menu,
          parentSelector
        );
        row.childCount = row.children.length;
        row.isGroupParent = row.childCount > 0 || !!row.isGroupParent;
        if (row.disc) row.disc.childCount = row.childCount;
        return;
      }

      if (!popup || !parentSelector) {
        for (const child of row.children || []) attach(child);
        row.isGroupParent = !!row.children?.length || !!row.isGroupParent;
        return;
      }

      prepareAnonymousNodeKeys(menuId, popup, parentSelector);

      const existingChildren = Array.isArray(row.children)
        ? [...row.children]
        : [];
      const liveChildren = [];

      for (const childNode of Array.from(popup.children || [])) {
        const localName = String(childNode.localName || "").toLowerCase();
        if (!["menuitem", "menu", "menuseparator"].includes(localName)) continue;

        const extensionMeta = extensionMetaFromNode(childNode);
        const discovered = {
          ...extensionMeta,
          type: localName === "menuseparator"
            ? "separator"
            : localName === "menu"
              ? "menu"
              : "menuitem",
          id: trim(childNode.id) || null,
          label: trim(
            childNode.getAttribute?.("label") ||
            childNode.getAttribute?.("tooltiptext") ||
            childNode.getAttribute?.("aria-label")
          ),
          tooltiptext: trim(childNode.getAttribute?.("tooltiptext")),
          hidden: !!childNode.hidden,
          disabled: !!childNode.disabled,
          el: childNode,
        };
        const suggestedSelector = suggestSelector(discovered);
        if (!suggestedSelector) continue;

        const existing =
          takeExisting(existingChildren, childNode, suggestedSelector) ||
          takeExisting(rows, childNode, suggestedSelector);
        const entry = existing?.entry || null;
        const selector = trim(
          existing?.selector || entry?.selector || suggestedSelector
        );
        if (!selector) continue;

        const previousDisc = existing?.disc || {};
        const disc = {
          ...previousDisc,
          ...extensionMeta,
          type: discovered.type,
          id: discovered.id || previousDisc.id || null,
          label: discovered.label || previousDisc.label || "",
          tooltiptext: discovered.tooltiptext || previousDisc.tooltiptext || "",
          hidden: !!childNode.hidden,
          disabled: !!childNode.disabled,
          registryOnly: false,
          el: childNode,
        };

        const childRow = {
          ...(existing || {}),
          key: existing?.key || makeUniqueKey(
            `${menuId}|nested|${parentSelector}|${selector}`
          ),
          kind: discovered.type === "separator" ? "separator" : "entry",
          menuId,
          disc,
          entry,
          selector,
          managed: !!entry,
          offline: false,
          registryOnly: false,
          // A cached dormant row becomes live again when its submenu is built.
          dormant: false,
          unverified: false,
          extensionName: existing?.extensionName || extensionMeta.extensionName || "",
          elementId: discovered.id || existing?.elementId || null,
          parentId: existing?.parentId ?? null,
          isGroupChild: true,
          parentSelector,
          children: existing?.children || [],
          childCount: Number(existing?.childCount) || 0,
          isGroupParent: !!existing?.isGroupParent,
          pinned: !!entry && menu.pinnedTail.includes(entry),
        };

        rememberObservedMenuRows(menuId, [discovered], parentSelector);
        attach(childRow);
        liveChildren.push(childRow);
      }

      // Keep registry-only children that Firefox has not materialized in this
      // popup context. A stale DOM pointer is dropped, but the registration and
      // its saved selector remain available to the editor.
      const remainingChildren = existingChildren.filter(child => {
        const oldNode = child?.disc?.el;
        return !oldNode || oldNode.parentNode !== popup;
      });

      for (const child of remainingChildren) {
        if (child?.disc?.el && child.disc.el.parentNode !== popup) {
          child.disc = {
            ...child.disc,
            el: null,
            registryOnly: !!child.disc.fromExtension,
          };
          child.offline = !child.disc.fromExtension;
          child.registryOnly = !!child.disc.fromExtension;
        }
        attach(child);
      }

      row.children = sortChildRowsByConfig(
        [...liveChildren, ...remainingChildren],
        menu,
        parentSelector
      );
      row.childCount = row.children.length;
      row.isGroupParent = row.childCount > 0;
      if (row.disc) row.disc.childCount = row.childCount;
    };

    // A copy is important: takeExisting() can splice offline child rules out of
    // this root array while the traversal is running.
    for (const row of [...rows]) attach(row);
  }

  // A human-readable title for a rule that has no live menu item behind it.
//
// Adopting a menu writes a rule for every entry, including extension items that
// Firefox has not built yet. Those rows carry no discovery data at all, so the
// name fell back to the raw CSS selector — "#archive-extension_save_com-menuitem-
// _archive-page" — which tells the reader nothing. The extension registry still
// knows what the entry is called, so the title is recovered from there.
//
// Returns { title, childCount }, or null when the registry cannot improve the
// selector. The count is deliberately not concatenated into the editable title.
function registryTitleFor(
  registry,
  selector
) {
  if (
    !Array.isArray(registry) ||
    !registry.length ||
    !selector
  ) {
    return null;
  }

  const exact =
    registry.find(
      item =>
        item.selector ===
        selector
    );

  if (exact) {
    return {
      title: trim(exact.title),
      childCount: 0,
    };
  }

  // An extension item written by suggestSelector() is often addressed loosely:
  //   [id*="menuitem-_archive-page"], [id*="menuitem-archive-page"]
  // Firefox uses "-menuitem-_id" for string ids and "-menuitem-<n>" for the
  // auto-generated numeric ones, so the leading underscore is part of the real
  // id for some extensions and absent for others. Both spellings are tried
  // rather than assuming one.
  const containsMatch =
    /\[id\*="menuitem-([^"\]]+)"\]/.exec(
      selector
    );

  if (containsMatch) {
    const captured =
      containsMatch[1];

    const candidates = [
      captured,
      captured.replace(
        /^_/,
        ""
      ),
      `_${captured.replace(/^_/, "")}`,
    ];

    const hit =
      registry.find(
        item =>
          candidates.includes(
            String(item.menuItemId)
          )
      );

    if (hit) {
      return {
        title: trim(hit.title),
        childCount: 0,
      };
    }
  }

  // A collapsed extension parent is addressed by its widget-id prefix:
  //   menu[ext-type="top-level-menu"][id^="some_extension-menuitem-"]
  const prefixMatch =
    /\[id\^="?([^"\]]+)"?\]/.exec(
      selector
    );

  if (!prefixMatch) return null;

  const prefix = prefixMatch[1];

  const group =
    registry.filter(
      item =>
        String(
          item.elementId || ""
        ).startsWith(prefix)
    );

  if (group.length === 1) {
    return {
      title: trim(group[0].title),
      childCount: 0,
    };
  }

  if (group.length > 1) {
    // Several registrations share one collapsed parent. Keep the editable
    // title and the informational child count as separate data: putting the
    // count in the title made it look as though it could be renamed too.
    const name = trim(group[0].extensionName);

    if (name) {
      return {
        title: name,
        childCount: group.length,
      };
    }
  }

  return null;
  }

  function buildRows(menuId) {
    const snapshot = discover(menuId);
    const liveRows = collectLiveRowsForReconciliation(
      menuId,
      snapshot.rows || []
    );
    reconcileLiveRuleSelectors(menuId, liveRows);
    const menu = menuConfig(menuId, true);

    const rows = [];
    const consumed = new Set();
    const usedKeys = new Set();
    let separatorIndex = 0;

    // Keys must be unique or selection and drag/drop address the wrong row, and
    // several rows legitimately share a selector (two extension entries under one
    // id prefix, or the label fallback used for items with no id at all).
    const uniqueKey = candidate => {
      let key = candidate;
      let n = 2;

      while (usedKeys.has(key)) {
        key = `${candidate}#${n++}`;
      }

      usedKeys.add(key);
      return key;
    };


    for (const discoveredRow of snapshot.rows || []) {
      if (discoveredRow.type === "separator") {
        const selector =
          discoveredRow.fromExtension &&
          discoveredRow.id
            ? suggestSelector(discoveredRow)
            : SEP(
                Number.isFinite(Number(discoveredRow.separatorIndex))
                  ? Number(discoveredRow.separatorIndex)
                  : separatorIndex
              );
        separatorIndex++;

        let entry = findRule(menuId, selector);

        if (
          !entry &&
          discoveredRow.fromExtension &&
          discoveredRow.elementId
        ) {
          entry = findRule(
            menuId,
            `#${escapeCss(discoveredRow.elementId)}`
          );
        }

        rows.push({
          key: uniqueKey(`${menuId}|${selector}`),
          kind: "separator",
          menuId,
          disc: discoveredRow,
          entry,
          selector,
          managed: !!entry,
          offline: false,
          pinned: entry
            ? menu.pinnedTail.includes(entry)
            : false,
        });

        if (entry) consumed.add(entry);
        continue;
      }

      let entry = null;

      for (const candidate of menu.entries) {
        if (consumed.has(candidate)) continue;

        if (
          rowMatchesRule(
            menuId,
            discoveredRow,
            candidate
          )
        ) {
          entry = candidate;
          break;
        }
      }

      if (!entry) {
        for (const candidate of menu.pinnedTail) {
          if (consumed.has(candidate)) continue;

          if (
            rowMatchesRule(
              menuId,
              discoveredRow,
              candidate
            )
          ) {
            entry = candidate;
            break;
          }
        }
      }

      if (entry) consumed.add(entry);

      rows.push({
        key: uniqueKey(
          `${menuId}|${
            entry?.selector ||
            suggestSelector(discoveredRow)
          }`
        ),
        kind: "entry",
        menuId,
        disc: discoveredRow,
        entry,
        selector:
          entry?.selector ||
          suggestSelector(discoveredRow),
        managed: !!entry,
        offline: false,
        // Carried from the discovery row so a collapsed parent can report how
        // many entries it stands for.
        childCount:
          Number(discoveredRow?.childCount) || 0,
        pinned:
          !!entry &&
          menu.pinnedTail.includes(entry),
      });
    }

    // Rules are considered verified when a live DOM node currently matches,
    // the active WebExtension registry confirms the selector, or this session
    // has observed the selector on a real node. The third case is important for
    // DOM-created/lazy entries (for example extension UI that only exists while
    // a particular submenu is open).
    //
    // Anything else is retained in config but placed in the dedicated
    // "Unverified saved" filter instead of being presented as a real menu item.
    // We never delete such a rule automatically: it may belong to a conditional
    // menu that has not been opened yet, or it may genuinely be stale.
    const registrySelectors = new Set(
      (snapshot.registry || []).map(item => text(item?.selector)).filter(Boolean)
    );

    for (const entry of allRules(menuId)) {
      if (consumed.has(entry)) continue;
      if (isSeparatorSelector(entry.selector)) continue;

      // Exact selectors are the normal case. registryTitleFor() also recognises
      // the editor's stable prefix/contains selectors for Firefox's synthetic
      // extension wrappers, so those must count as registered too.
      const inferred = registryTitleFor(snapshot.registry, entry.selector);
      const registryConfirmed =
        registrySelectors.has(text(entry.selector)) || !!inferred;
      const previouslyObserved = wasRuleObserved(menuId, entry.selector);
      const savedStatus = DISCOVERY_POLICY.savedRuleStatus({
        registryConfirmed,
        previouslyObserved,
      });
      const unverified = savedStatus === "unverified";
      const dormant = savedStatus === "dormant";
      const inferredTitle = trim(inferred?.title);
      const observed = observedRuleMetadata(menuId, entry.selector);
      const fallbackTitle = inferredTitle || trim(observed?.label);

      rows.push({
        key: uniqueKey(
          `${menuId}|offline|${entry.selector}`
        ),
        kind: "entry",
        menuId,
        disc: fallbackTitle
          ? {
              type: inferred?.childCount > 0
                ? "menu"
                : observed?.type || "menuitem",
              id: observed?.id || null,
              label: fallbackTitle,
              // The registry label is inferred; the cached label was captured
              // from a real XUL node earlier in this browser session.
              inferred: !!inferredTitle,
            }
          : null,
        entry,
        selector: entry.selector,
        managed: true,
        offline: true,
        unverified,
        dormant,
        nameInferred: !!inferredTitle,
        extensionName: observed?.extensionName || undefined,
        parentSelector: trim(
          observed?.parentSelector || entry.parentSelector
        ) || undefined,
        childOrderParentSelector: trim(
          observed?.parentSelector || entry.parentSelector
        ) || undefined,
        childCount: Number(inferred?.childCount) || 0,
        isGroupParent: Number(inferred?.childCount) > 0,
        pinned: menu.pinnedTail.includes(entry),
      });
      consumed.add(entry);
    }

    // Reconcile Firefox's extension registry as a real tree. The registry is
    // authoritative for parentId relationships; live DOM rows only supply the
    // actual node and current label/state. This replaces the old mix of separate
    // live-row, synthetic-group, and offline-child paths that could flatten the
    // same registration twice.
    const registryGroups = new Map();

    for (const item of snapshot.registry || []) {
      if (!item || !contextsFitMenu(item.contexts, menuId)) continue;
      const groupKey = String(item.extensionId);
      if (!registryGroups.has(groupKey)) registryGroups.set(groupKey, []);
      registryGroups.get(groupKey).push(item);
    }

    const extensionWidgetId = value =>
      widgetIdOf(value).split("-menuitem-")[0];

    const registryIdentityMatches = (row, item) => {
      const disc = row?.disc || {};
      const sameExtension =
        extensionWidgetId(disc.extensionId) ===
        extensionWidgetId(item.extensionId);
      const discIdType =
        disc.extensionMenuIdType ||
        (typeof disc.extensionMenuId === "number" ? "number" : null);
      const sameRegisteredId =
        disc.extensionMenuId !== undefined &&
        disc.extensionMenuId !== null &&
        String(disc.extensionMenuId) === String(item.menuItemId) &&
        (!discIdType || discIdType === typeof item.menuItemId);
      return sameExtension && sameRegisteredId;
    };

    // Build one row per registration, recursively. All top-level snapshots and
    // saved/offline rules that identify this registration are consumed together;
    // two separate DOM nodes for the same extension+menuItemId cannot survive as
    // duplicate rows. Different IDs with identical titles remain distinct.
    const makeRegistryRow = (
      item,
      isGroupChild = false,
      ancestry = new Set(),
      parentSelector = ""
    ) => {
      const identity =
        `${extensionWidgetId(item.extensionId)}\u0000${typeof item.menuItemId}\u0000${String(item.menuItemId)}`;
      if (ancestry.has(identity)) return null;

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(identity);

      const matchingRows = rows.filter(row =>
        registryIdentityMatches(row, item) ||
        row?.disc?.el?.id === item.elementId ||
        row?.disc?.id === item.elementId ||
        row?.selector === item.selector ||
        row?.entry?.selector === item.selector
      );

      const existing =
        matchingRows.find(row => row?.disc?.el) ||
        matchingRows.find(row => row?.entry) ||
        matchingRows[0] ||
        null;

      // Remove every representation, not merely the first matching row. This is
      // the key duplicate fix for extensions whose live and registry snapshots
      // both describe the same menu item (or whose DOM contains duplicate clones).
      for (const duplicate of matchingRows) {
        const index = rows.indexOf(duplicate);
        if (index >= 0) rows.splice(index, 1);
        if (duplicate?.entry) consumed.add(duplicate.entry);
      }

      let element = existing?.disc?.el || null;
      if (!element && item.elementId) {
        try {
          element = document.getElementById(item.elementId) || null;
        } catch (_) {}
      }

      let entry = existing?.entry || findRule(menuId, item.selector);
      if (!entry && existing?.selector) {
        entry = findRule(menuId, existing.selector);
      }
      if (entry) consumed.add(entry);

      const selector = existing?.selector || entry?.selector || item.selector;
      const children = [];
      for (const child of item.children || []) {
        const childRow = makeRegistryRow(
          child,
          true,
          nextAncestry,
          selector
        );
        if (childRow) children.push(childRow);
      }
      const orderedChildren = sortChildRowsByConfig(
        children,
        menu,
        selector
      );

      const isSeparator = item.type === "separator";
      const isMenu = !isSeparator && orderedChildren.length > 0;
      const previousDisc = existing?.disc || {};
      const disc = {
        ...previousDisc,
        type: isSeparator ? "separator" : isMenu ? "menu" : "menuitem",
        id: previousDisc.id || item.elementId || null,
        label: previousDisc.label || item.title,
        hidden: !!(entry?.hidden || previousDisc.hidden),
        registryOnly: !element,
        extensionMenuId: item.menuItemId,
        extensionMenuIdType: typeof item.menuItemId,
        extensionId: item.extensionId,
        extensionName: item.extensionName,
        fromExtension: true,
        elementId: item.elementId,
        el: element,
      };

      return {
        key: uniqueKey(
          `${menuId}|extension-item|${extensionWidgetId(item.extensionId)}|${String(item.menuItemId)}`
        ),
        kind: isSeparator ? "separator" : "entry",
        menuId,
        disc,
        entry,
        selector,
        managed: !!entry,
        offline: !element,
        registryOnly: !element,
        extensionName: item.extensionName,
        contexts: mergedContexts([item]),
        elementId: item.elementId,
        parentId: item.parentId ?? null,
        isGroupChild,
        parentSelector: trim(parentSelector) || undefined,
        children: orderedChildren,
        childCount: orderedChildren.length,
        isGroupParent: orderedChildren.length > 0,
        pinned: !!entry && menu.pinnedTail.includes(entry),
      };
    };

    for (const group of registryGroups.values()) {
      if (!group.length) continue;
      const first = group[0];

      // A submenu opened from a registered parent already has its parent outside
      // the current editor view. Its children must be shown directly here, not
      // wrapped in another extension-name submenu.
      if (first.registrySubmenu) {
        for (const item of group) {
          const row = makeRegistryRow(item, false);
          if (row) rows.push(row);
        }
        continue;
      }

      const widgetPrefix = extensionWidgetId(first.extensionId);
      const registeredRootIds = new Set(
        group.map(item => String(item.elementId || "")).filter(Boolean)
      );
      const isSyntheticExtensionParent = row => {
        const disc = row?.disc || {};
        const node = disc.el;
        if (!node) return false;
        if (
          disc.collapsedContainer &&
          extensionWidgetId(disc.extensionId || disc.id) === widgetPrefix
        ) {
          return true;
        }

        // ext-type="top-level-menu" is Firefox's explicit marker, but retain a
        // structural fallback for forks/builds that omit or rename that marker:
        // the generated extension wrapper is a live XUL <menu> whose ID has the
        // extension widget prefix but does not identify any registered root
        // menu item. A real extension-created submenu always has its own exact
        // registered element ID, so it cannot be mistaken for this wrapper.
        const localName = String(node.localName || "").toLowerCase();
        const rowId = String(disc.id || node.id || "");
        if (
          localName !== "menu" ||
          !rowId ||
          registeredRootIds.has(rowId) ||
          extensionWidgetId(disc.extensionId || rowId) !== widgetPrefix
        ) {
          return false;
        }

        return true;
      };
      const container = rows.find(isSyntheticExtensionParent);

      // When Firefox has materialized its synthetic extension header, keep that
      // exact live parent and attach every registered root item below it.
      if (container) {
        const parentSelector =
          container.selector ||
          container.entry?.selector ||
          collapsedParentSelector({
            id: first.elementId,
            collapsedContainer: true,
          });
        const children = [];
        for (const item of group) {
          const row = makeRegistryRow(item, true, new Set(), parentSelector);
          if (row) children.push(row);
        }
        const parentEntry = container.entry || (parentSelector
          ? findRule(menuId, parentSelector)
          : null);
        if (parentEntry) consumed.add(parentEntry);

        container.selector = container.selector || parentEntry?.selector || parentSelector;
        container.entry = parentEntry;
        container.managed = !!parentEntry;
        container.extensionName = first.extensionName;
        container.contexts = mergedContexts(group);
        container.children = sortChildRowsByConfig(
          children,
          menu,
          parentSelector
        );
        container.childOrderParentSelector = parentSelector;
        container.childCount = container.children.length;
        container.isGroupParent = container.children.length > 0;
        container.registryOnly = false;
        container.offline = false;
        container.disc = {
          ...container.disc,
          type: "menu",
          extensionId: first.extensionId,
          extensionName: first.extensionName,
          fromExtension: true,
          collapsedContainer: true,
          childCount: children.length,
        };
        continue;
      }

      // If Firefox has exposed one or more registered root items directly,
      // that live shape is more authoritative than a synthetic extension group.
      // This happens when runtime filters leave only a subset of an extension's
      // roots eligible for the current click. Keep the real roots as siblings;
      // do not invent a second extension-name parent around them.
      const hasLiveRegisteredRoot = group.some(item =>
        rows.some(row =>
          row?.disc?.el && (
            registryIdentityMatches(row, item) ||
            row?.disc?.el?.id === item.elementId ||
            row?.disc?.id === item.elementId
          )
        )
      );
      if (hasLiveRegisteredRoot) {
        for (const item of group) {
          const row = makeRegistryRow(item, false);
          if (row) rows.push(row);
        }
        continue;
      }

      // Firefox groups multiple eligible root registrations beneath one
      // extension-labelled menu. Recreate that parent only when the registry
      // scope is the browser menu itself and more than one root item applies.
      // Every root item keeps its own recursively nested children.
      if (group.length > 1) {
        const parentSelector = collapsedParentSelector({
          id: first.elementId,
          collapsedContainer: true,
        });
        const children = [];
        for (const item of group) {
          const row = makeRegistryRow(item, true, new Set(), parentSelector);
          if (row) children.push(row);
        }
        const matchingParents = rows.filter(row =>
          row?.selector === parentSelector ||
          row?.entry?.selector === parentSelector
        );
        const existingParent = matchingParents.find(row => row.entry) || matchingParents[0] || null;
        for (const duplicate of matchingParents) {
          const index = rows.indexOf(duplicate);
          if (index >= 0) rows.splice(index, 1);
        }

        const parentEntry = existingParent?.entry || (parentSelector
          ? findRule(menuId, parentSelector)
          : null);
        if (parentEntry) consumed.add(parentEntry);
        const parentName = trim(first.extensionName) || "Extension menu";
        const parentDisc = {
          ...(existingParent?.disc || {}),
          type: "menu",
          id: existingParent?.disc?.id || first.elementId,
          label: existingParent?.disc?.label || parentName,
          hidden: !!(parentEntry?.hidden || existingParent?.disc?.hidden),
          collapsedContainer: true,
          childCount: children.length,
          extensionId: first.extensionId,
          extensionName: parentName,
          fromExtension: true,
          registryOnly: !existingParent?.disc?.el,
          el: existingParent?.disc?.el || null,
        };

        rows.push({
          key: uniqueKey(`${menuId}|extension-group|${widgetPrefix}`),
          kind: "entry",
          menuId,
          disc: parentDisc,
          entry: parentEntry,
          selector: existingParent?.selector || parentEntry?.selector || parentSelector,
          childOrderParentSelector: parentSelector,
          managed: !!parentEntry,
          offline: !parentDisc.el,
          registryOnly: !parentDisc.el,
          extensionName: parentName,
          contexts: mergedContexts(group),
          childCount: children.length,
          children: sortChildRowsByConfig(
            children,
            menu,
            parentSelector
          ),
          isGroupParent: children.length > 0,
          pinned: !!parentEntry && menu.pinnedTail.includes(parentEntry),
        });
        continue;
      }

      // A single registered root item is its own parent row. If it has a
      // parentId-derived child tree, the normal + control exposes that tree.
      const row = makeRegistryRow(first, false);
      if (row) rows.push(row);
    }

    // Reattach session-observed saved children before reading current DOM.
    // If a parent is hidden, attachLiveSubmenuRows() will keep these rows
    // dormant; if it is visible again, the live nodes reclaim the same rules.
    attachObservedDormantChildren(rows, menuId, menu);

    // Native Firefox/Zen submenu items are not all represented in the
    // WebExtension registry. Attach the direct live <menupopup> children to
    // their parent rows before final deduplication/sorting, so they participate
    // in the same recursive tree and parent-scoped order model.
    attachLiveSubmenuRows(rows, menuId, menu, uniqueKey);

    return sortRowsByConfig(dedupeBuiltRows(rows), menu);
  }

  // Extension menu registrations are scoped to WebExtension ContextType
  // values, not to every browser-chrome menu. The old implementation treated
  // every non-tab menu as a content menu, which made default "page" entries
  // appear as invented/offline rows in the hamburger menu, toolbar menus,
  // Downloads, History, and unrelated panels.
  //
  // Keep the mapping explicit. For unlisted chrome surfaces, the live DOM is
  // authoritative: real extension nodes still appear through discover(), but
  // registry-only entries are never synthesized there.
  const PAGE_CONTEXTS = new Set([
    "page",
    "selection",
    "link",
    "editable",
    "image",
    "video",
    "audio",
    "password",
  ]);
  const FRAME_CONTEXTS = new Set([
    "frame",
    "selection",
    "link",
    "editable",
    "image",
    "video",
    "audio",
    "password",
  ]);

  const EXTENSION_CONTEXTS_BY_MENU = new Map([
    ["contentAreaContextMenu", PAGE_CONTEXTS],
    ["subFrameContextMenu", FRAME_CONTEXTS],
    ["tabContextMenu", new Set(["tab"])],
    ["placesContext", new Set(["bookmark"])],
    ["sidebarBookmarksMenu", new Set(["bookmark"])],
    ["pageActionContextMenu", new Set(["page_action"])],
    ["unifiedExtensionsContextMenu", new Set(["action", "browser_action"])],
    ["unified-extensions-context-menu", new Set(["action", "browser_action"])],
    ["menu_ToolsPopup", new Set(["tools_menu"])],
  ]);

  // Extension submenu popups have IDs generated from the owning extension and
  // menu-item ID. They are not context roots themselves: their parent already
  // determines where the submenu can be opened, so retain the full registered
  // child tree while editing that submenu.
  function isExtensionSubmenuScope(menuId) {
    return /-menuitem-/.test(text(menuId));
  }

  function supportsExtensionRegistryMenu(menuId) {
    return EXTENSION_CONTEXTS_BY_MENU.has(text(menuId)) ||
      isExtensionSubmenuScope(menuId);
  }

  // "all" is a WebExtension meta-context for every context except bookmark,
  // tab, and tools_menu. Do not reinterpret it as "all non-tab browser menus";
  // that was the source of cross-menu leakage.
  const CONTEXTS_EXCLUDED_FROM_ALL = new Set([
    "bookmark",
    "tab",
    "tools_menu",
  ]);

  function mergedContexts(items) {
    const merged = [];

    for (const item of items) {
      const contexts = Array.isArray(item?.contexts)
        ? item.contexts
        : [];

      for (const context of contexts) {
        const normalized = text(context).toLowerCase();
        if (!normalized || merged.includes(normalized)) continue;
        merged.push(normalized);
      }
    }

    return merged;
  }

  function contextsFitMenu(contexts, menuId) {
    const id = text(menuId);

    // A specific registered submenu inherits its root's context. This editor
    // view is already scoped to that parent, so all child registrations remain
    // visible, with their individual contexts shown as badges.
    if (isExtensionSubmenuScope(id)) return true;

    const allowed = EXTENSION_CONTEXTS_BY_MENU.get(id);
    if (!allowed) return false;
    if (!Array.isArray(contexts) || !contexts.length) return false;

    return contexts.some(context => {
      const normalized = text(context).toLowerCase();
      if (normalized === "all") {
        return [...allowed].some(value => !CONTEXTS_EXCLUDED_FROM_ALL.has(value));
      }
      return allowed.has(normalized);
    });
  }

  // ===========================================================================
  // LAYOUT COMMANDS
  // ===========================================================================

  function captureMenuState(menuId) {
    return deepClone(
      menuConfig(menuId, true)
    );
  }

  function restoreMenuState(menuId, snapshot) {
    state.config.menus[menuId] =
      deepClone(snapshot);
  }

  function markDirty() {
    state.dirty = true;

    // Every mutating path (command/undo/redo) funnels through here, so this is
    // the one place that has to keep the live menus in sync with the model.
    applyHiddenStyles();

    updateSaveButton();
  }

  function command(
    menuId,
    label,
    mutator,
    options = {}
  ) {
    const before =
      captureMenuState(menuId);

    try {
      mutator(menuConfig(menuId));
    } catch (error) {
      restoreMenuState(
        menuId,
        before
      );

      console.error(
        `[menu-editor] ${label} failed:`,
        error
      );

      status(
        `${label} failed: ${error}`,
        "error"
      );

      return false;
    }

    const after =
      captureMenuState(menuId);

    if (
      JSON.stringify(before) ===
      JSON.stringify(after)
    ) {
      return false;
    }

    if (options.history !== false) {
      state.history.push({
        menuId,
        label,
        before,
        after,
      });

      if (
        state.history.length >
        CONFIG.historyLimit
      ) {
        state.history.shift();
      }

      state.future.length = 0;
    }

    markDirty();
    return true;
  }

  function undo() {
    const action =
      state.history.pop();

    if (!action) return false;

    const current =
      captureMenuState(
        action.menuId
      );

    state.future.push({
      ...action,
      before: current,
      after: action.after,
    });

    restoreMenuState(
      action.menuId,
      action.before
    );

    state.activeMenu =
      action.menuId;

    state.selectedMenu =
      action.menuId;

    clearSelection();

    markDirty();
    render();

    status(
      `Undid: ${action.label}`,
      "ok"
    );

    return true;
  }

  function redo() {
    const action =
      state.future.pop();

    if (!action) return false;

    const current =
      captureMenuState(
        action.menuId
      );

    state.history.push({
      ...action,
      before: current,
      after: action.after,
    });

    restoreMenuState(
      action.menuId,
      action.after
    );

    state.activeMenu =
      action.menuId;

    state.selectedMenu =
      action.menuId;

    clearSelection();

    markDirty();
    render();

    status(
      `Redid: ${action.label}`,
      "ok"
    );

    return true;
  }

  function enableReorder(menuId) {
    return command(
      menuId,
      "Enable custom order",
      menu => {
        menu.reorder = true;
      }
    );
  }

  function disableReorder(menuId) {
    return command(
      menuId,
      "Restore browser order",
      menu => {
        menu.reorder = false;
      }
    );
  }

  function releaseRule(menuId, entry) {
    return command(
      menuId,
      "Release rule",
      () => {
        removeRule(menuId, entry);
      }
    );
  }

  // Whether Reset would actually change anything. Used to grey the action out
  // rather than offering a no-op that silently does nothing.
  function ruleIsResettable(
    menuId,
    entry,
    row = null
  ) {
    const menu =
      menuConfig(menuId, false);

    const parentSelectors = new Set([
      trim(entry?.selector),
      trim(row?.selector),
      trim(row?.childOrderParentSelector),
    ].filter(Boolean));
    const hasChildOrder = !!menu?.childOrders?.some(
      item => parentSelectors.has(trim(item?.parentSelector)) && item.order?.length
    );

    return !!(
      hasChildOrder ||
      (
        entry && (
          entryLabel(entry) ||
          entry.hidden ||
          entry.originalLabel ||
          (Array.isArray(entry.contexts) && entry.contexts.length) ||
          entry.contextReference ||
          menu?.pinnedTail?.includes(entry)
        )
      )
    );
  }

  // Undo every customisation on ONE entry, while keeping it under management.
  //
  // Deliberately distinct from releaseRule(), which deletes the rule entirely
  // and hands the row back to the browser. Reset keeps the row managed — so it
  // stays exactly where the user dragged it — and discards only the per-entry
  // changes: the custom title, the hidden flag, and the pinned-to-tail state.
  //
  // originalLabel is cleared too. Once the custom title is gone it records a
  // default that is no longer being overridden, and leaving it behind would
  // keep a stale entry in the search index forever.
  function resetRule(
    menuId,
    entry,
    parentSelector = ""
  ) {
    const menu =
      menuConfig(menuId, false);

    if (!menu || !entry) {
      return false;
    }

    return command(
      menuId,
      "Reset item",
      () => {
        setEntryLabel(entry, "");

        delete entry.originalLabel;

        if (entry.hidden) {
          delete entry.hidden;
        }

        delete entry.contexts;
        delete entry.contextReference;

        // A parent row owns the order of its immediate children. Resetting that
        // parent therefore resets its nested layout as well.
        const parentSelectors = new Set([
          trim(entry.selector),
          trim(parentSelector),
        ].filter(Boolean));
        menu.childOrders = (menu.childOrders || []).filter(
          item => !parentSelectors.has(trim(item?.parentSelector))
        );

        // Reset means "forget everything I did to this row", which includes the
        // pin. Leaving it in pinnedTail would report success while the row
        // stayed pinned, which is the kind of lie that erodes trust in a Reset.
        const pinnedAt =
          menu.pinnedTail.indexOf(entry);

        if (pinnedAt >= 0) {
          menu.pinnedTail.splice(
            pinnedAt,
            1
          );
        }
      }
    );
  }

  // Synthetic extension group parents do not always have a normal entry rule.
  // Their child order is still a first-class customization, so expose a way to
  // clear it without manufacturing a top-level rule just to make Reset work.
  function resetChildOrder(menuId, parentSelector) {
    const parent = trim(parentSelector);
    if (!parent) return false;

    return command(
      menuId,
      "Reset child order",
      menu => {
        menu.childOrders = (menu.childOrders || []).filter(
          item => trim(item?.parentSelector) !== parent
        );
      }
    );
  }

  // Resolve the current selection for a visibility action. A selected row acts
  // on the whole selected group; clicking an unselected row acts only on that
  // row. Separators are deliberately excluded because their visibility control
  // is not available in the editor.
  function rowsForVisibilityAction(row) {
    if (
      row &&
      state.selectedKeys.size > 1 &&
      state.selectedKeys.has(row.key)
    ) {
      const selected = getSelectedRows().filter(
        candidate =>
          candidate.menuId === row.menuId &&
          candidate.kind !== "separator"
      );

      if (selected.some(candidate => candidate.key === row.key)) {
        return selected;
      }
    }

    return row ? [row] : [];
  }

  // Apply a visibility change as ONE command, so a group hide/show is one
  // undo step rather than a stack of unrelated single-row changes. This accepts
  // either discovered rows or config entries (the latter is used by the test API).
  function setHiddenForRows(menuId, rowOrEntries, hidden) {
    const inputs = Array.isArray(rowOrEntries)
      ? rowOrEntries
      : [rowOrEntries];
    const targets = [];
    const seen = new Set();

    for (const target of inputs) {
      if (!target) continue;

      const selector = trim(
        target.selector || target.entry?.selector
      );
      const identity = selector
        ? `selector:${selector}`
        : target;

      if (seen.has(identity)) continue;
      seen.add(identity);
      targets.push(target);
    }

    if (!targets.length) return false;

    const actionLabel = hidden ? "Hide" : "Show";
    const label = targets.length === 1
      ? `${actionLabel} item`
      : `${actionLabel} ${targets.length} items`;

    return command(
      menuId,
      label,
      () => {
        for (const target of targets) {
          // Rows carry "kind"; raw config entries do not. Never pass a config
          // entry to ensureRuleForRow(), because that would create entry.entry
          // self-references and make the JSON snapshot cyclic.
          const entry = target?.kind !== undefined
            ? ensureRuleForRow(menuId, target)
            : target;

          if (!entry) continue;

          if (hidden) entry.hidden = true;
          else delete entry.hidden;
        }
      }
    );
  }

  function setHidden(menuId, rowOrEntry, hidden) {
    return setHiddenForRows(
      menuId,
      [rowOrEntry],
      hidden
    );
  }

  // The context filter is tag-based. Choosing a tag toggles it without
  // replacing the others; "Default" clears every tag. Rules match if any selected
  // tag matches the active right-click context (OR semantics).
  const CONTEXT_FILTER_OPTIONS = Object.freeze([
    Object.freeze({ value: "all", label: "Default" }),
    Object.freeze({ value: "page", label: "Page" }),
    Object.freeze({ value: "link", label: "Link" }),
    Object.freeze({ value: "image", label: "Image" }),
    Object.freeze({ value: "media", label: "Media" }),
    Object.freeze({ value: "video", label: "Video" }),
    Object.freeze({ value: "audio", label: "Audio" }),
    Object.freeze({ value: "selection", label: "Selection" }),
    Object.freeze({ value: "editable", label: "Editable" }),
    Object.freeze({ value: "frame", label: "Frame" }),
    Object.freeze({ value: "custom", label: "Custom reference…" }),
  ]);

  function contextListForEntry(entry) {
    return Array.isArray(entry?.contexts)
      ? [...new Set(entry.contexts.map(value => text(value).toLowerCase()).filter(Boolean))]
      : [];
  }

  // Older configs represented "Media" as the pair ["video", "audio"].
  // Keep it readable as one tag until the user edits it; the next individual
  // tag toggle migrates that legacy pair to the explicit "media" tag.
  function contextTagSelected(entry, value) {
    const contexts = contextListForEntry(entry);
    if (value === "media") {
      return contexts.includes("media") ||
        (!contexts.includes("media") && contexts.includes("video") && contexts.includes("audio"));
    }
    if (value === "video" || value === "audio") {
      return contexts.includes(value) &&
        !(contexts.includes("video") && contexts.includes("audio") && !contexts.includes("media"));
    }
    return contexts.includes(value);
  }

  function contextFilterSummary(entry) {
    const contexts = contextListForEntry(entry);
    if (!contexts.length) return "Default";

    const shown = new Set(contexts);
    if (!shown.has("media") && shown.has("video") && shown.has("audio")) {
      shown.delete("video");
      shown.delete("audio");
      shown.add("media");
    }

    const labelByValue = new Map(
      CONTEXT_FILTER_OPTIONS
        .filter(option => option.value !== "all")
        .map(option => [option.value, option.label.replace(/…$/, "")])
    );
    return CONTEXT_FILTER_OPTIONS
      .filter(option => option.value !== "all" && shown.has(option.value))
      .map(option => labelByValue.get(option.value) || option.value)
      .join(" + ") || "Default";
  }

  function contextFilterHasRestriction(entry) {
    return contextListForEntry(entry).length > 0;
  }

  function toggleContextTag(entry, value) {
    let contexts = contextListForEntry(entry);

    // Treat old video+audio pairs as the combined Media tag on edit. That lets
    // users add "Audio" to an older Media-only rule and get the explicit
    // "Media + Audio" combination instead of accidentally removing Media.
    if (
      !contexts.includes("media") &&
      contexts.includes("video") &&
      contexts.includes("audio")
    ) {
      contexts = contexts.filter(context => context !== "video" && context !== "audio");
      contexts.push("media");
    }

    if (value === "media") {
      if (contexts.includes("media")) {
        contexts = contexts.filter(context => context !== "media");
      } else {
        contexts.push("media");
      }
    } else if (contexts.includes(value)) {
      contexts = contexts.filter(context => context !== value);
    } else {
      contexts.push(value);
    }

    // Stable storage order makes the config readable in a text editor and keeps
    // summaries predictable regardless of the order tags were clicked.
    const order = new Map(CONTEXT_FILTER_OPTIONS.map((option, index) => [option.value, index]));
    contexts = [...new Set(contexts)].sort(
      (a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999)
    );

    if (contexts.length) entry.contexts = contexts.slice(0, 16).map(value => value.slice(0, 64));
    else delete entry.contexts;
  }

  // A filter row always displays its current tag summary. Individual options
  // carry a check mark when active, and selecting one toggles just that tag.
  function contextFilterValue(_entry) {
    return "__current__";
  }

  function setContextForRows(menuId, rowOrEntries, value) {
    const inputs = Array.isArray(rowOrEntries)
      ? rowOrEntries
      : [rowOrEntries];
    const targets = [];
    const seen = new Set();

    for (const target of inputs) {
      if (!target) continue;
      const selector = trim(target.selector || target.entry?.selector);
      const identity = selector ? `selector:${selector}` : target;
      if (seen.has(identity)) continue;
      seen.add(identity);
      targets.push(target);
    }

    if (!targets.length) return false;

    const normalized = text(value).toLowerCase();
    const option = CONTEXT_FILTER_OPTIONS.find(candidate => candidate.value === normalized);
    const label = option ? option.label : normalized;
    const isClear = normalized === "all";

    return command(
      menuId,
      isClear ? "Clear context tags" : `Toggle context tag: ${label}`,
      () => {
        for (const target of targets) {
          // Clearing a tag filter on an unmanaged row should not create an empty
          // management rule just to store the absence of a restriction.
          if (isClear && !target.entry) continue;

          const entry = target?.kind !== undefined
            ? ensureRuleForRow(menuId, target)
            : target;
          if (!entry) continue;

          if (isClear) {
            delete entry.contexts;
            delete entry.contextReference;
          } else {
            toggleContextTag(entry, normalized);
          }
        }
      }
    );
  }

  function setContext(menuId, rowOrEntry, value) {
    return setContextForRows(menuId, [rowOrEntry], value);
  }

  function closeCustomReferenceDialog() {
    const dialog = state.customReferenceDialog;
    if (!dialog) return;

    state.customReferenceDialog = null;
    dialog.remove();
  }

  // Native window.confirm() dialogs use the browser/OS dialog theme, so they
  // cannot match this editor's own controls. Keep confirmations inside the
  // panel instead, using the same theme tokens and button treatment as the
  // rest of the studio.
  function closeConfirmDialog(accepted = false) {
    const pending = state.confirmDialog;
    if (!pending) return;

    state.confirmDialog = null;
    pending.backdrop.remove();

    if (pending.previousFocus?.isConnected) {
      try {
        pending.previousFocus.focus();
      } catch (_) {
        // The previous control may have been replaced by a render.
      }
    }

    pending.resolve(!!accepted);
  }

  function confirmInPanel(message, options = {}) {
    const panel = state.panel || buildPanel();

    // Only one modal may be active at a time. A new confirmation safely
    // dismisses an older one as a cancellation.
    closeConfirmDialog(false);
    closeCustomReferenceDialog();

    const previousFocus = document.activeElement;
    const titleText = options.title || "Confirm action";
    const confirmLabel = options.confirmLabel || "Continue";
    const cancelLabel = options.cancelLabel || "Cancel";
    const isDanger = options.danger !== false;

    const backdrop = el("div", {
      class: "confirm-backdrop",
      role: "presentation",
    });
    const dialog = el("div", {
      class: "confirm-dialog",
      role: "alertdialog",
      "aria-modal": "true",
      "aria-labelledby": `${CONFIG.panelId}-confirm-title`,
      "aria-describedby": `${CONFIG.panelId}-confirm-message`,
      tabindex: "-1",
    });
    const title = el("div", {
      class: "confirm-title",
      id: `${CONFIG.panelId}-confirm-title`,
      text: titleText,
    });
    const body = el("p", {
      class: "confirm-message",
      id: `${CONFIG.panelId}-confirm-message`,
      text: String(message ?? ""),
    });
    const actions = el("div", {
      class: "confirm-actions",
    });

    let resolvePromise;
    const promise = new Promise(resolve => {
      resolvePromise = resolve;
    });

    const cancel = button(
      cancelLabel,
      "Keep the current changes",
      () => closeConfirmDialog(false),
      { class: "confirm-cancel" }
    );
    const confirm = button(
      confirmLabel,
      titleText,
      () => closeConfirmDialog(true),
      { class: isDanger ? "confirm-danger" : "confirm-primary" }
    );

    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeConfirmDialog(false);
        return;
      }

      if (event.key === "Tab") {
        if (event.shiftKey && document.activeElement === cancel) {
          event.preventDefault();
          confirm.focus();
        } else if (!event.shiftKey && document.activeElement === confirm) {
          event.preventDefault();
          cancel.focus();
        }
      }
    });

    backdrop.addEventListener("pointerdown", event => {
      if (event.target === backdrop) {
        closeConfirmDialog(false);
      }
    });

    dialog.append(title, body, actions);
    actions.append(cancel, confirm);
    backdrop.appendChild(dialog);
    panel.appendChild(backdrop);

    state.confirmDialog = {
      backdrop,
      previousFocus,
      resolve: resolvePromise,
    };

    // Focus the safe action by default: Enter/Escape cannot accidentally
    // discard edits just because the confirmation appeared.
    cancel.focus();
    return promise;
  }

  function setCustomContextReference(menuId, row) {
    const panel = state.panel || buildPanel();
    closeCustomReferenceDialog();

    const currentReference = trim(row?.entry?.contextReference);
    const backdrop = el("div", {
      class: "custom-reference-backdrop",
      role: "presentation",
    });
    const dialog = el("div", {
      class: "custom-reference-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Custom context reference",
    });
    const title = el("div", {
      class: "custom-reference-title",
      text: "Custom context reference",
    });
    const help = el("p", {
      class: "custom-reference-help",
      text: "Enter another item’s original ID (recommended) or a CSS selector. This entry will appear only while the referenced item is visible. Leave blank to remove the Custom tag.",
    });
    const input = el("input", {
      type: "text",
      class: "custom-reference-input",
      value: currentReference,
      placeholder: "e.g. context-savepage or #context-savepage",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Original menu item ID or CSS selector",
    });
    const actions = el("div", {
      class: "custom-reference-actions",
    });

    const cancel = button(
      "Cancel",
      "Keep the existing context reference unchanged",
      () => {
        closeCustomReferenceDialog();
        render();
      }
    );

    const applyReference = () => {
      if (!state.customReferenceDialog) return;

      const reference = trim(input.value);
      closeCustomReferenceDialog();

      if (!reference && !row?.entry) {
        render();
        return;
      }

      command(
        menuId,
        reference ? "Set custom context reference" : "Remove custom context reference",
        () => {
          const entry = row?.kind !== undefined
            ? (reference || row.entry ? ensureRuleForRow(menuId, row) : null)
            : row;
          if (!entry) return;

          const contexts = contextListForEntry(entry).filter(context => context !== "custom");
          if (reference) {
            contexts.push("custom");
            entry.contextReference = reference;
          } else {
            delete entry.contextReference;
          }

          if (contexts.length) entry.contexts = [...new Set(contexts)];
          else delete entry.contexts;
        }
      );

      render();
    };

    const apply = button(
      "Apply",
      "Use this custom reference",
      applyReference,
      { class: "primary-button" }
    );

    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyReference();
      }
    });

    backdrop.addEventListener("pointerdown", event => {
      if (event.target === backdrop) {
        closeCustomReferenceDialog();
        render();
      }
    });

    dialog.append(title, help, input, actions);
    actions.append(cancel, apply);
    backdrop.appendChild(dialog);
    panel.appendChild(backdrop);

    state.customReferenceDialog = backdrop;
    input.focus();
    input.select();
  }

  // The title Firefox or the extension itself provides for a row, before any
  // custom rename. This is the "classic" name a user remembers.
  function rowDefaultLabel(row) {
    return (
      trim(row?.disc?.label) ||
      trim(row?.disc?.tooltiptext) ||
      ""
    );
  }

  function rename(
    menuId,
    row,
    value
  ) {
    return command(
      menuId,
      "Rename item",
      () => {
        const entry =
          ensureRuleForRow(
            menuId,
            row
          );

        if (!entry) return;

        // Seed the original before overwriting it. setEntryLabel can only see a
        // previous CUSTOM title, which is empty on the first rename. When that
        // is the case the live menu is the authority on the real default, so
        // prefer it whenever it differs from the custom title — otherwise the
        // live node may already carry the applied rename, and reading it would
        // record the custom title as if it were the original.
        const live =
          rowDefaultLabel(row);

        const current =
          entryLabel(entry);

        rememberOriginalLabel(
          entry,
          live && live !== current
            ? live
            : current
        );

        setEntryLabel(
          entry,
          value
        );
      }
    );
  }

  function moveRule(
    menuId,
    entry,
    targetEntry,
    after
  ) {
    return command(
      menuId,
      "Move item",
      menu => {
        const fromLocation =
          findRuleLocation(
            menuId,
            entry
          );

        if (!fromLocation) return;

        const targetLocation =
          findRuleLocation(
            menuId,
            targetEntry
          );

        if (!targetLocation) return;

        // Crossing the pinned boundary changes the item's section.
        if (
          fromLocation.pinned !==
          targetLocation.pinned
        ) {
          fromLocation.list.splice(
            fromLocation.list.indexOf(
              entry
            ),
            1
          );

          const targetList =
            targetLocation.list;

          const targetIndex =
            targetList.indexOf(
              targetEntry
            );

          targetList.splice(
            targetIndex +
              (after ? 1 : 0),
            0,
            entry
          );

          return;
        }

        const list =
          fromLocation.list;

        const fromIndex =
          list.indexOf(entry);

        const targetIndex =
          list.indexOf(
            targetEntry
          );

        if (
          fromIndex < 0 ||
          targetIndex < 0 ||
          entry === targetEntry
        ) {
          return;
        }

        list.splice(
          fromIndex,
          1
        );

        const adjustedTarget =
          list.indexOf(
            targetEntry
          );

        list.splice(
          adjustedTarget +
            (after ? 1 : 0),
          0,
          entry
        );
      }
    );
  }

  // Move several entries as ONE block, keeping their existing relative order.
  //
  // This is deliberately NOT moveRule() called N times: repeating it would move
  // each entry relative to the previous one's new position, so dragging A and B
  // together could leave them in either order depending on how the loop ran.
  // Lifting the whole group out first and reinserting it once is what makes the
  // group behave like a single item.
  function moveRuleGroup(
    menuId,
    entries,
    targetEntry,
    after
  ) {
    const group =
      Array.isArray(entries)
        ? entries.filter(Boolean)
        : [];

    if (!group.length) {
      return false;
    }

    const targetLocation =
      findRuleLocation(
        menuId,
        targetEntry
      );

    if (!targetLocation) {
      return false;
    }

    // A target inside the group means "put it back where it came from". Treating
    // it as a real drop would drop the group into itself.
    if (
      group.includes(
        targetEntry
      )
    ) {
      return false;
    }

    // Sort the group by where it currently sits, so the caller does not have to
    // get the order right. beginDrag() already passes list order, but relying on
    // that silently makes the function order-DEPENDENT: hand it [b, a] instead
    // of [a, b] and the group lands reversed, which is a bug that only shows up
    // for whoever calls this next. Entries sort ahead of pinnedTail, matching the
    // order the rows are rendered in.
    const rank = entry => {
      const location =
        findRuleLocation(
          menuId,
          entry
        );

      if (!location) {
        return Number.MAX_SAFE_INTEGER;
      }

      const index =
        location.list.indexOf(
          entry
        );

      if (index < 0) {
        return Number.MAX_SAFE_INTEGER;
      }

      return (
        (location.pinned ? 1 : 0) * 1e9 +
        index
      );
    };

    const ordered = [
      ...group,
    ].sort(
      (a, b) =>
        rank(a) - rank(b)
    );

    return command(
      menuId,
      group.length === 1
        ? "Move item"
        : `Move ${group.length} items`,
      () => {
        // Detach every member first, so the target's index is measured against
        // the list the group is actually being inserted into — not one that
        // still contains the rows being moved.
        for (const entry of group) {
          const location =
            findRuleLocation(
              menuId,
              entry
            );

          if (!location) continue;

          const index =
            location.list.indexOf(
              entry
            );

          if (index < 0) continue;

          location.list.splice(
            index,
            1
          );
        }

        const list =
          targetLocation.list;

        const targetIndex =
          list.indexOf(
            targetEntry
          );

        if (targetIndex < 0) {
          return;
        }

        list.splice(
          targetIndex +
            (after ? 1 : 0),
          0,
          ...ordered
        );
      }
    );
  }

  // Return the full sibling list for a parent, including children hidden by
  // the editor's collapsed disclosure control. Their current order is already
  // sorted by the parent's saved childOrders record when one exists.
  function childSiblingsForParent(menuId, parentSelector) {
    const parent = trim(parentSelector);
    if (!parent) return [];

    const siblings = [];
    const visit = rows => {
      for (const row of rows || []) {
        if (trim(row.parentSelector) === parent) siblings.push(row);
        visit(row.children);
      }
    };
    visit(buildRows(menuId));
    return siblings;
  }

  // Context-menu nudge / edge actions for a nested row use the same parent-
  // scoped order table as drag-and-drop. They must never call nudge() or
  // moveEdge(), which operate on the root menu's entries array.
  function reorderChildRow(menuId, row, actionName, delta = 0) {
    const parent = trim(row?.parentSelector);
    if (!parent || !row) return false;

    return command(
      menuId,
      actionName,
      menu => {
        const siblings = childSiblingsForParent(menuId, parent);
        const index = siblings.findIndex(candidate =>
          candidate.key === row.key ||
          (
            trim(candidate.selector) === trim(row.selector) &&
            trim(candidate.parentSelector) === parent
          )
        );
        if (index < 0) {
          throw new Error("Could not resolve this child in its parent submenu.");
        }

        const reordered = [...siblings];
        const [moving] = reordered.splice(index, 1);
        const targetIndex = actionName === "Move child to top"
          ? 0
          : actionName === "Move child to bottom"
            ? reordered.length
            : Math.max(0, Math.min(reordered.length, index + (delta < 0 ? -1 : 1)));

        // A nudge at either edge is a genuine no-op. Do not create an empty
        // customization record merely because the user clicked the disabled
        // edge action in the row menu.
        if (targetIndex === index) return;
        reordered.splice(targetIndex, 0, moving);

        const order = reordered
          .map(candidate => trim(candidate.entry?.selector || candidate.selector))
          .filter(Boolean);
        if (order.length !== reordered.length) {
          throw new Error("A child entry has no stable selector and cannot be saved in the order.");
        }
        if (new Set(order).size !== order.length) {
          throw new Error("The submenu contains duplicate selectors; refusing an ambiguous child order.");
        }

        const record = childOrderRecord(menu, parent, true);
        record.order = order;
        // `reorder` gates both root and nested live-order executors. A nested
        // reorder explicitly retakes layout control after Reset/Release.
        menu.reorder = true;
      }
    );
  }

  // Reorder children inside one specific submenu. This is intentionally a
  // separate operation from moveRuleGroup(): nested items are not direct
  // children of the browser's root popup and must never enter the top-level
  // `entries` array.
  function moveChildRowGroup(
    menuId,
    parentSelector,
    sourceRows,
    targetRow,
    after
  ) {
    const parent = trim(parentSelector);
    const sources = Array.isArray(sourceRows)
      ? sourceRows.filter(Boolean)
      : sourceRows
        ? [sourceRows]
        : [];
    if (!parent || !sources.length || !targetRow) return false;

    // Resolve by selector identity, not render-time row keys. Native submenu
    // children are reconstructed from live XUL on every render, and anonymous
    // children can receive a fresh row key if an extension rebuilds their popup
    // between pointer-down and pointer-up. A selector is the persisted identity
    // used by childOrders itself.
    const selectorOf = row => trim(row?.entry?.selector || row?.selector);
    const sourceSelectors = sources.map(selectorOf).filter(Boolean);
    const targetSelector = selectorOf(targetRow);
    if (
      sourceSelectors.length !== sources.length ||
      !targetSelector ||
      new Set(sourceSelectors).size !== sourceSelectors.length
    ) {
      status("These child entries do not have unique stable selectors, so they cannot be reordered safely.", "error");
      return false;
    }

    return command(
      menuId,
      sources.length === 1
        ? "Move child item"
        : `Move ${sources.length} child items`,
      menu => {
        // Rebuild from the current model, not stale row object references. The
        // recursive tree contains collapsed children too, so every sibling is
        // included even when the user has not expanded another branch.
        const siblings = childSiblingsForParent(menuId, parent);
        const siblingSelectors = siblings.map(selectorOf);
        if (new Set(siblingSelectors).size !== siblingSelectors.length) {
          throw new Error("The submenu contains duplicate selectors; refusing an ambiguous child order.");
        }

        const sourceSet = new Set(sourceSelectors);
        const moving = siblings.filter(row => sourceSet.has(selectorOf(row)));
        if (moving.length !== sourceSet.size) {
          throw new Error("Could not resolve every dragged child in its parent menu.");
        }
        if (sourceSet.has(targetSelector)) return;

        const movingSet = new Set(moving.map(selectorOf));
        const remaining = siblings.filter(row => !movingSet.has(selectorOf(row)));
        const targetIndex = remaining.findIndex(row => selectorOf(row) === targetSelector);
        if (targetIndex < 0) {
          throw new Error("The drop target is not a child of the same parent.");
        }

        // `moving` already follows the current sibling order because it was
        // filtered from `siblings`; the block therefore retains its relative
        // order during multi-select drags.
        remaining.splice(
          targetIndex + (after ? 1 : 0),
          0,
          ...moving
        );

        const order = remaining.map(selectorOf);

        if (order.length !== remaining.length) {
          throw new Error("A child entry has no stable selector and cannot be saved in the order.");
        }

        const uniqueOrder = [...new Set(order)];
        if (uniqueOrder.length !== order.length) {
          throw new Error("The submenu contains duplicate selectors; refusing an ambiguous child order.");
        }

        const record = childOrderRecord(menu, parent, true);
        record.order = order;
        menu.reorder = true;
      }
    );
  }

  function nudge(
    menuId,
    entry,
    delta
  ) {
    const location =
      findRuleLocation(
        menuId,
        entry
      );

    if (!location) return false;

    const list =
      location.list;

    const index =
      list.indexOf(entry);

    if (index < 0) return false;

    const target = Math.max(
      0,
      Math.min(
        list.length - 1,
        index + delta
      )
    );

    if (target === index) return false;

    return command(
      menuId,
      delta < 0
        ? "Move up"
        : "Move down",
      () => {
        list.splice(
          index,
          1
        );

        list.splice(
          target,
          0,
          entry
        );
      }
    );
  }

  function moveEdge(
    menuId,
    entry,
    toEnd
  ) {
    const location =
      findRuleLocation(
        menuId,
        entry
      );

    if (!location) return false;

    return command(
      menuId,
      toEnd
        ? "Move to bottom"
        : "Move to top",
      () => {
        const list =
          location.list;

        const index =
          list.indexOf(entry);

        if (index < 0) return;

        list.splice(
          index,
          1
        );

        list.splice(
          toEnd
            ? list.length
            : 0,
          0,
          entry
        );
      }
    );
  }

  // ===========================================================================
  // FULL-CONTROL / SNAPSHOT COMMANDS
  // ===========================================================================

  function adoptBrowserOrder(menuId, options = {}) {
    const rows =
      buildRows(menuId);

    return command(
      menuId,
      "Adopt current browser order",
      menu => {
        const liveEntries = [];
        const known = new Set();
        const knownSelectors = new Set();

        for (const row of rows) {
          const selector = trim(row.selector);
          if (!selector || knownSelectors.has(selector)) continue;

          const entry = row.entry || ensureRuleForRow(menuId, row);
          if (!entry) continue;

          const canonicalSelector = trim(entry.selector || selector);
          if (known.has(entry) || knownSelectors.has(canonicalSelector)) continue;

          known.add(entry);
          knownSelectors.add(canonicalSelector);
          liveEntries.push(entry);
        }

        // Preserve each offline rule once, including extension rules that have
        // not been built into a live popup yet.
        const offline = [];
        for (const entry of [...menu.entries, ...menu.pinnedTail]) {
          const selector = trim(entry?.selector);
          if (!selector || known.has(entry) || knownSelectors.has(selector)) continue;
          known.add(entry);
          knownSelectors.add(selector);
          offline.push(entry);
        }

        menu.entries = [...liveEntries, ...offline];

        menu.pinnedTail = [];
        menu.reorder = true;
      },

      // Adoption is an ordinary command by default, so it lands in undo/redo.
      // The automatic path (assumeControl) passes history:false so merely
      // OPENING a menu never plants an undo step.
      options
    );
  }

  function ensureFullControl(
    menuId,
    options = {}
  ) {
    const menu = menuConfig(menuId, true);
    const rows = buildRows(menuId);

    const missingManagedRow = rows.some(
      row => row.kind !== "separator" && !row.entry
    );

    if (menu.reorder !== false && !missingManagedRow) {
      return false;
    }

    const alreadyHasLayout =
      menu.entries.length > 0 ||
      menu.pinnedTail.length > 0;

    // Initial adoption may copy Firefox's current order. Once a saved layout
    // exists, however, a new/context-specific extension node must not reset it.
    // Track missing rows at the end while retaining the existing custom order.
    if (alreadyHasLayout && menu.reorder !== false) {
      return command(
        menuId,
        "Track newly discovered entries",
        () => {
          for (const row of rows) {
            if (row.entry || !row.selector) continue;
            ensureRuleForRow(menuId, row);
          }
          menu.reorder = true;
        },
        options
      );
    }

    return adoptBrowserOrder(menuId, options);
  }

  // ===========================================================================
  // TAKE CONTROL IS THE DEFAULT, NOT A MODE
  // ===========================================================================
  // There used to be a "Take control" button, a confirmation dialog and a row
  // menu item — three ways to ask permission for something the editor now just
  // does. The panel always runs in take-control mode: the first time a menu is
  // shown or switched to, its browser order is adopted silently and every row
  // gets a rule behind it.
  //
  // history:false because this is a state the editor ASSUMES, not an edit the
  // user made. Pushing it onto the undo stack would make Ctrl+Z — pressed right
  // after opening a menu — rip out the very snapshot the next operation needs.
  // state.dirty still flips when something actually changed, so Save tells the
  // truth about it.
  function assumeControl(menuId) {
    try {
      return ensureFullControl(
        menuId,
        { history: false }
      );
    } catch (error) {
      console.error(
        "[menu-editor] automatic take-control failed:",
        error
      );

      return false;
    }
  }

  function resetLayout(menuId) {
    return command(
      menuId,
      "Reset menu layout",
      menu => {
        for (const entry of [
          ...menu.entries,
          ...menu.pinnedTail,
        ]) {
          delete entry.label;
          delete entry.hidden;
        }

        menu.entries = [];
        menu.pinnedTail = [];
        menu.childOrders = [];
        menu.reorder = false;
      }
    );
  }

  // ===========================================================================
  // MENU DISCOVERY / PICKER
  // ===========================================================================

  function friendlyMenuName(
    id,
    node = null
  ) {
    if (FALLBACK_MENU_NAMES[id]) {
      return FALLBACK_MENU_NAMES[id];
    }

    const own =
      trim(
        node?.getAttribute?.(
          "label"
        )
      ) ||
      trim(
        node
          ?.closest?.(
            "menu"
          )
          ?.getAttribute?.(
            "label"
          )
      );

    if (own) return own;

    const derived =
      text(id)
        .replace(
          /ContextMenu$|Context$|Menu$|-menu$/g,
          ""
        )
        .replace(
          /^context[-_]?/i,
          ""
        )
        .replace(
          /([a-z])([A-Z])/g,
          "$1 $2"
        )
        .replace(
          /[-_]+/g,
          " "
        )
        .trim();

    return derived
      ? derived.charAt(0).toUpperCase() +
          derived.slice(1)
      : id;
  }

  function menuHasSavedRules(menuId) {
    const menu = state.config?.menus?.[menuId];
    return !!(
      menu &&
      (
        (Array.isArray(menu.entries) && menu.entries.length) ||
        (Array.isArray(menu.pinnedTail) && menu.pinnedTail.length) ||
        (Array.isArray(menu.childOrders) && menu.childOrders.length) ||
        menu.reorder === false
      )
    );
  }

  function isContextMenuCandidate(node, referencedContextIds = null) {
    const id = trim(node?.id);
    if (!id) return false;

    if (CONTEXT_MENU_ROOT_IDS.has(id)) return true;

    const type = trim(node?.getAttribute?.("type")).toLowerCase();
    if (type === "context") return true;

    return !!referencedContextIds?.has(id);
  }

  function availableMenus() {
    const map = new Map();

    for (const item of CONFIG.primaryMenus) {
      map.set(item.id, {
        id: item.id,
        label: item.label,
        primary: true,
        saved: false,
      });
    }

    // The main hamburger panel is editable as an additional browser menu, not
    // as another context menu. Its contents are handled by the PanelMultiView
    // adapter above.
    if (document.getElementById(APP_MENU_PANEL_ID) || menuElement(APP_MENU_VIEW_ID)) {
      map.set(APP_MENU_VIEW_ID, {
        id: APP_MENU_VIEW_ID,
        label: FALLBACK_MENU_NAMES[APP_MENU_VIEW_ID],
        primary: false,
        application: true,
        saved: false,
      });
    }

    // A context attribute is another reliable way for browser chrome to point
    // at a context popup. Read its value, rather than guessing from an ID's
    // spelling (nested context_* submenus are not roots).
    const referencedContextIds = new Set();
    for (const target of document.querySelectorAll("[context]")) {
      const contextId = trim(target.getAttribute?.("context"));
      if (contextId) referencedContextIds.add(contextId);
    }

    for (const node of document.querySelectorAll(
      "menupopup[id], menu[id]"
    )) {
      const id = trim(node.id);

      if (
        !id || map.has(id) ||
        !isContextMenuCandidate(node, referencedContextIds)
      ) {
        continue;
      }

      map.set(id, {
        id,
        label: friendlyMenuName(
          id,
          node
        ),
        primary: false,
        saved: false,
      });
    }

    // Do not discard access to a legacy/non-context menu that was intentionally
    // configured in an earlier version. Keep only menus with an actual saved
    // rule set, and put them in a separate group so they cannot clutter the
    // everyday context-menu list. Unconfigured menu-bar entries and nested
    // submenu popups are no longer surfaced.
    for (const id of Object.keys(state.config?.menus || {})) {
      if (map.has(id) || !menuHasSavedRules(id)) continue;

      map.set(id, {
        id,
        label: friendlyMenuName(id, document.getElementById(id)),
        primary: false,
        saved: true,
      });
    }

    // In XUL, a menu and its direct child menupopup are one user-facing menu:
    // the <menu> supplies the label while the <menupopup> supplies the entries.
    // If both IDs are context-root candidates or one has saved legacy rules,
    // prefer the ID whose existing config has
    // rules; otherwise prefer the visible <menu> wrapper. If both IDs already
    // have independent saved state, keep both but disambiguate their labels —
    // silently discarding either configuration would be unsafe.
    for (const popup of document.querySelectorAll("menupopup[id]")) {
      const parent = popup.parentElement;
      const popupId = trim(popup.id);
      const parentId = trim(parent?.id);

      if (
        String(parent?.localName || "").toLowerCase() !== "menu" ||
        !popupId || !parentId || popupId === parentId ||
        !map.has(popupId) || !map.has(parentId)
      ) {
        continue;
      }

      const popupHasRules = menuHasSavedRules(popupId);
      const parentHasRules = menuHasSavedRules(parentId);
      const sharedLabel = friendlyMenuName(parentId, parent);

      if (popupHasRules && parentHasRules) {
        // Two config namespaces exist for the same live menu. Keep both
        // selectable, but make their IDs visible so users can tell them apart.
        map.get(popupId).label = `${sharedLabel} — #${popupId}`;
        map.get(parentId).label = `${sharedLabel} — #${parentId}`;
        continue;
      }

      if (popupHasRules) {
        // Keep the alias only when it is the one carrying saved rules, while
        // retaining the natural label users see on the actual menu wrapper.
        map.get(popupId).label = sharedLabel;
        map.delete(parentId);
      } else {
        // Either only the wrapper has rules or neither ID has any saved rules.
        map.get(parentId).label = sharedLabel;
        map.delete(popupId);
      }
    }

    // A few menus can still share a label without being a direct menu/popup
    // pair (for example, separately registered extension menus). Keep these
    // accessible, but never leave two indistinguishable options in the picker.
    const sameLabel = new Map();
    for (const menu of map.values()) {
      const key = trim(menu.label).replace(/\s+/g, " ").toLocaleLowerCase();
      if (!key) continue;
      if (!sameLabel.has(key)) sameLabel.set(key, []);
      sameLabel.get(key).push(menu);
    }
    for (const duplicates of sameLabel.values()) {
      if (duplicates.length < 2) continue;
      for (const menu of duplicates) {
        // The ID is stable and actionable; array positions and DOM order are not.
        if (!menu.label.includes(`— #${menu.id}`)) {
          menu.label = `${menu.label} — #${menu.id}`;
        }
      }
    }

    // Primary ("Main menus") keep the order they are declared in
    // CONFIG.primaryMenus — Page / content, Tab strip, then Sidebar / toolbar.
    // Genuine secondary context menus and saved legacy menus remain alphabetic.
    // Previously everything was localeCompare'd, which
    // floated "Bookmarks / History" ahead of the tab menu because its label
    // starts with a "B"; the studio's own order should decide the main menus.
    const primaryOrder = new Map(
      CONFIG.primaryMenus.map(
        (item, index) => [item.id, index]
      )
    );

    return [...map.values()].sort(
      (a, b) => {
        if (a.primary !== b.primary) {
          return a.primary ? -1 : 1;
        }

        if (!a.primary && a.saved !== b.saved) {
          return a.saved ? 1 : -1;
        }

        if (!a.primary && a.application !== b.application) {
          return a.application ? 1 : -1;
        }

        if (a.primary && b.primary) {
          const ai = primaryOrder.has(a.id)
            ? primaryOrder.get(a.id)
            : Number.MAX_SAFE_INTEGER;

          const bi = primaryOrder.has(b.id)
            ? primaryOrder.get(b.id)
            : Number.MAX_SAFE_INTEGER;

          return ai - bi;
        }

        return a.label.localeCompare(
          b.label
        );
      }
    );
  }

  async function selectMenu(menuId) {
    if (
      menuId ===
      state.activeMenu
    ) {
      return;
    }

    if (
      state.dirty &&
      !(await confirmInPanel(
        "Discard unsaved changes?",
        {
          title: "Unsaved changes",
          confirmLabel: "Discard changes",
          cancelLabel: "Keep editing",
          danger: true,
        }
      ))
    ) {
      const picker = state.panel?.querySelector(".menu-picker");
      if (picker) picker.value = state.activeMenu;
      return;
    }

    state.activeMenu =
      menuId;

    state.selectedMenu =
      menuId;

    clearSelection();


    state.filter = "";

    state.dirty = false;
    state.history.length = 0;
    state.future.length = 0;

    // Switching menu = already in control of it. This is the whole of the old
    // "Take control" step: no button, no confirmation.
    assumeControl(menuId);

    render();
  }

  // ===========================================================================
  // FILTERING
  // ===========================================================================

  // ===========================================================================
  // DISPLAY TOGGLES
  // ===========================================================================

  // Cute names are a presentation-only layer. Set this to false to display raw
  // selector fallbacks everywhere. Custom labels and real browser/extension
  // labels are never rewritten, and the rename field always receives the raw
  // value from getRowName() rather than this display-only form.
  const CUTE_NAMES = true;

  // Words that naive splitting gets wrong. Firefox writes these as separate
  // words, so the display should too.
  //
  // Deliberately small: this covers the recurring cases, not every awkward id.
  // See the note on prettifySelector() for what is left imperfect.
  const PRETTY_ID_WORDS = new Map([
    ["viewsource", "View Source"],
    ["selectall", "Select All"],
    ["imagetext", "Image Text"],
    ["bidi", "BiDi"],
    ["pdfjs", "PDF"],
  ]);

  // Small exceptions for well-known IDs whose wording cannot be recovered by
  // mechanically splitting punctuation/camelCase. Map avoids special object
  // keys such as "__proto__" being mistaken for inherited properties.
  const PRETTY_SELECTOR_OVERRIDES = new Map([
    // Password manager — toolbar and places menus, not the content menu.
    ["#fill-login", "Fill Login"],
    ["#fill-login-generated-password", "Fill Login / New Password"],
    ["#manage-saved-logins", "Manage Saved Logins"],

    // Selection search. Verified against this build's browser.xhtml: both items
    // carry NO data-l10n-id, so the browser sets their titles at runtime and
    // there is nothing in the markup to read them from.
    ["#context-searchselect", "Search Selection"],
    ["#context-searchselect-private", "Search Selection (Private)"],
    ["#context_askChatSummarize", "Ask Chat Summarize"],

    // Zen's AI entry, also runtime-labelled. The split already produced
    // "Ask Chat", so this is here to pin the wording rather than to fix it.
    ["#context-ask-chat", "Ask Chat"],

    // View Source submenu. The split handles these ids correctly but
    // capitalises the "to", which reads wrong.
    ["#context-viewsource-goToLine", "View Source Go to Line"],
    ["#context-viewsource-highlightSyntax", "View Source Highlight Syntax"],
    ["#context-viewsource-wrapLongLines", "View Source Wrap Long Lines"],
  ]);

  // Turn a selector fallback into a readable display name. Supports ordinary
  // IDs, camelCase IDs, extension-generated `-menuitem-` IDs, and Firefox's
  // synthetic extension-parent selector. Unrecognized CSS selectors are left
  // alone rather than being guessed into misleading words.
  function prettifySelector(value, row = null) {
    const raw = trim(value);
    if (!CUTE_NAMES || !raw) return text(value);

    const explicit = PRETTY_SELECTOR_OVERRIDES.get(raw);
    if (explicit) return explicit;

    let identifier = "";
    let syntheticParent = false;

    const synthetic = raw.match(
      /^menu\s*\[\s*ext-type\s*=\s*(["'])top-level-menu\1\s*\]\s*\[\s*id\^\s*=\s*(["'])(.*?)\2\s*\]$/i
    );

    if (synthetic) {
      identifier = synthetic[3];
      syntheticParent = true;
    } else if (/^#[\w-]+$/.test(raw)) {
      identifier = raw.slice(1);
    } else {
      return raw;
    }

    if (syntheticParent) {
      const registeredName = trim(
        row?.extensionName || row?.disc?.extensionName
      );
      if (registeredName && registeredName.toLowerCase() !== identifier.toLowerCase()) {
        return registeredName;
      }

      identifier = identifier.replace(/-menuitem-.*$/i, "");
      // Example: `the-tab-suspender_tabsuspender_internal` -> `the-tab-suspender`.
      if (identifier.includes("-")) {
        identifier = identifier.replace(/_[a-z0-9]+_internal$/i, "");
      }
    } else {
      // The useful identity is the extension prefix, not its WebExtension menu
      // item ID. For LanguageTool, drop the generated build/version suffix too.
      identifier = identifier.replace(/-menuitem-.*$/i, "");
      identifier = identifier.replace(/-modified(?:[-_].*)?$/i, "");
    }

    // Keep the established title for classic hyphenated Firefox IDs, where
    // `context-` is a namespace rather than a visible word. Underscore-form IDs
    // remain literal, so `#context_moveTabToGroup` becomes "Context Move Tab To Group".
    if (/^#context-[a-zA-Z0-9_-]+$/.test(raw)) {
      identifier = identifier.replace(/^context-/i, "");
    }

    if (/^context_askChatSummarize$/i.test(identifier)) {
      return "Ask Chat Summarize";
    }

    const words = identifier
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[-_\s]+/)
      .filter(Boolean);

    if (!words.length) return raw;

    return words.map(word => {
      const fixed = PRETTY_ID_WORDS.get(word.toLowerCase());
      if (fixed) return fixed;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(" ");
  }

  // The title shown for a row: the custom one when there is one, otherwise what
  // the browser or the extension provided.
  //
  // NOT prettified, and that is load-bearing. startInlineRename() seeds its
  // input from this function, so a prettified value here would be written back
  // as a CUSTOM label the moment the user confirmed the edit — turning a
  // cosmetic display concern into a real config change. Display prettification
  // belongs at the call site, not in the model's name.
  function getRowName(row) {
    return (
      entryLabel(row.entry) ||
      trim(row.disc?.label) ||
      trim(row.disc?.tooltiptext) ||
      trim(row.selector)
    );
  }

  // Every string a row should be findable by.
  //
  // This is deliberately the UNION of all the row's names, not just the one
  // currently displayed. Renaming an entry hides its old name from the list, so
  // if the haystack only ever held the displayed title, a renamed entry would
  // become unfindable by the very name most people remember: searching
  // "View Page Source" must still surface the entry now called "Banana".
  //
  // The sources, in order of reliability:
  //   entryOriginalLabel - the default captured at the first rename, and the
  //                        only one that survives the live menu being
  //                        relabelled.
  //   rowDefaultLabel    - what the live menu/extension says right now, which
  //                        covers entries whose original was never recorded
  //                        (config written by an older build, or hand-edited).
  //   entryLabel         - the custom title.
  //   selector / id      - so "#context-viewsource" also works.
  function rowSearchText(row) {
    const own = [
      entryOriginalLabel(row.entry),
      rowDefaultLabel(row),
      entryLabel(row.entry),
      trim(row.disc?.tooltiptext),
      trim(row.extensionName),
      ...(row.contexts || row.disc?.contexts || nativeContextsForRow(row) || []),
      ...contextTokens(row.contexts || row.disc?.contexts || nativeContextsForRow(row) || []).flat(),
      trim(row.selector),
      trim(row.disc?.id),
    ].filter(Boolean);

    const descendants = [];
    const visit = children => {
      for (const child of children || []) {
        descendants.push(
          entryOriginalLabel(child.entry),
          rowDefaultLabel(child),
          entryLabel(child.entry),
          trim(child.selector),
          ...(child.contexts || [])
        );
        visit(child.children);
      }
    };
    visit(row.children);

    return [...own, ...descendants]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
  }

  function rowMatchesOwnFilter(row) {
    if (row?.unverified && state.filterMode !== "unverified") return false;
    if (!row?.unverified && state.filterMode === "unverified") return false;
    if (row?.dormant && state.filterMode !== "dormant") return false;
    if (!row?.dormant && state.filterMode === "dormant") return false;

    if (
      state.filter &&
      ![
        entryOriginalLabel(row.entry),
        rowDefaultLabel(row),
        entryLabel(row.entry),
        trim(row.disc?.tooltiptext),
        trim(row.extensionName),
        ...(row.contexts || row.disc?.contexts || nativeContextsForRow(row) || []),
        ...contextTokens(row.contexts || row.disc?.contexts || nativeContextsForRow(row) || []).flat(),
        trim(row.selector),
        trim(row.disc?.id),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(state.filter.toLocaleLowerCase())
    ) {
      return false;
    }

    switch (state.filterMode) {
      case "visible":
        return row.kind === "separator" || !row.entry?.hidden;
      case "hidden":
        return row.kind !== "separator" && !!row.entry?.hidden;
      case "changed":
        return row.kind !== "separator" && (ruleIsChanged(row.entry) || rowHasChildOrder(row));
      case "unmanaged":
        return row.kind !== "separator" && !row.entry;
      case "extension":
        return isExtensionRow(row);
      case "unverified":
        return !!row.unverified;
      case "dormant":
        return !!row.dormant;
      default:
        return true;
    }
  }

  function rowMatchesFilter(row) {
    if (rowMatchesOwnFilter(row)) return true;
    return (row.children || []).some(rowMatchesFilter);
  }

  // ===========================================================================
  // STATUS / SAVE BUTTON
  // ===========================================================================

  function status(
    message,
    kind = ""
  ) {
    const node =
      document.getElementById(
        `${CONFIG.panelId}-status`
      );

    if (!node) return;

    node.textContent =
      message;

    node.className =
      `status ${kind}`.trim();
  }

  function updateSaveButton() {
    const save =
      document.getElementById(
        `${CONFIG.panelId}-save`
      );

    const undoButton =
      document.getElementById(
        `${CONFIG.panelId}-undo`
      );

    const redoButton =
      document.getElementById(
        `${CONFIG.panelId}-redo`
      );

    if (save) {
      save.disabled =
        !state.dirty ||
        state.saveInProgress;
    }

    if (undoButton) {
      undoButton.disabled =
        state.history.length === 0;
    }

    if (redoButton) {
      redoButton.disabled =
        state.future.length === 0;
    }
  }

  // ===========================================================================
  // ROW SELECTION
  // ===========================================================================

  function rowContainer() {
    return document.getElementById(
      `${CONFIG.panelId}-rows`
    );
  }

  // Replace the whole selection with the given rows. The first is the primary.
  function applySelection(rows) {
    state.selectedKeys =
      new Set(
        rows.map(row => row.key)
      );

    const primary = rows[rows.length - 1] || null;

    state.selectedKey =
      primary
        ? primary.key
        : null;

    state.selectedMenu =
      primary
        ? primary.menuId
        : null;

    paintSelection();
  }

  // Repaint only the selection classes, without a full re-render.
  //
  // Kept separate so a click does not rebuild the list: rebuilding would
  // replace the very node the click event is still propagating through, which
  // is what used to make shift-click ranges collapse after the first row.
  function paintSelection() {
    const many =
      state.selectedKeys.size > 1;

    for (
      const node of
      rowContainer()
        ?.querySelectorAll(
          ".cm-row"
        ) || []
    ) {
      const selected =
        !!node._row &&
        state.selectedKeys.has(
          node._row.key
        );

      node.classList.toggle(
        "selected",
        selected
      );

      // "multi" is only meaningful while several rows are held at once, so it is
      // cleared on every paint rather than being a one-way add.
      node.classList.toggle(
        "multi",
        selected && many
      );
    }
  }

  function clearSelection() {
    state.selectedKeys =
      new Set();

    state.selectedKey = null;
    state.selectedMenu = null;
    state.selectionAnchor = null;

    paintSelection();
  }

  // The rows currently selected, in LIST order.
  //
  // Order comes from the visible list rather than from click order, because a
  // multi-row drag has to preserve the order the rows already sit in — dropping
  // a group must not silently reverse it.
  function getSelectedRows() {
    if (!state.selectedKeys.size) {
      return [];
    }

    return getRowsForRender().filter(
      row =>
        state.selectedKeys.has(
          row.key
        )
    );
  }

  // Ctrl/Cmd-click toggles one row, Shift-click extends a range from the anchor,
  // and a plain click selects just that row.
  function toggleSelection(row) {
    if (state.selectedKeys.has(row.key)) {
      state.selectedKeys.delete(row.key);

      if (
        state.selectedKey ===
        row.key
      ) {
        state.selectedKey =
          [...state.selectedKeys].pop() ||
          null;

        state.selectedMenu =
          state.selectedKey
            ? row.menuId
            : null;
      }
    } else {
      state.selectedKeys.add(
        row.key
      );

      state.selectedKey =
        row.key;

      state.selectedMenu =
        row.menuId;
    }

    paintSelection();
  }

  function selectRange(row) {
    const rows =
      getRowsForRender();

    const anchorIndex =
      rows.findIndex(
        candidate =>
          candidate.key ===
          state.selectionAnchor
      );

    const targetIndex =
      rows.findIndex(
        candidate =>
          candidate.key ===
          row.key
      );

    // No usable anchor (the row it pointed at is filtered out or gone), so this
    // degrades to a plain selection rather than selecting the whole list.
    if (
      anchorIndex < 0 ||
      targetIndex < 0
    ) {
      applySelection([row]);
      state.selectionAnchor =
        row.key;

      return;
    }

    const from =
      Math.min(
        anchorIndex,
        targetIndex
      );

    const to =
      Math.max(
        anchorIndex,
        targetIndex
      );

    applySelection(
      rows.slice(from, to + 1)
    );

    // The anchor deliberately does not move: repeated Shift-clicks keep
    // extending the same range instead of ratcheting it around.
    state.selectionAnchor =
      state.selectionAnchor || row.key;
  }

  // The elements that begin a drag: the grip and the whole name cell.
  //
  // A press that lands on one of these has to be told apart from a press on the
  // row background — see selectRow().
  const DRAG_SURFACE_SELECTOR =
    ".drag-handle, .name-cell";

  function isDragSurfacePress(
    rowElement,
    event
  ) {
    const target =
      event?.target;

    if (
      !target ||
      !rowElement?.contains?.(
        target
      )
    ) {
      return false;
    }

    return !!target.closest?.(
      DRAG_SURFACE_SELECTOR
    );
  }

  function selectRow(
    rowElement,
    row,
    event = null
  ) {
    const additive =
      !!event &&
      (event.ctrlKey ||
        event.metaKey);

    const ranged =
      !!event &&
      event.shiftKey;

    if (additive) {
      // Ctrl toggles one row and RE-ANCHORS, so a Ctrl-click then Shift-click
      // extends from the row that was just toggled — the behaviour every file
      // manager has trained users to expect.
      toggleSelection(row);
      state.selectionAnchor =
        row.key;

      return;
    }

    if (ranged) {
      selectRange(row);
      return;
    }

    // A press that starts on a drag surface of a row that is ALREADY selected
    // must not collapse the selection.
//
// The grip's "pointerdown" and the row's "mousedown" are the SAME physical
    // press, and mousedown is the single place that changes the selection.
// Replacing the set with [row] unconditionally meant that selecting three
    // rows and then pressing the grip on one of them dropped the other two
    // before the pointer had even cleared the 4px drag threshold — which is
    // exactly the "I selected a group and dragging it lost the selection"
// report.
//
// Preserving the group is also what every file manager does: grabbing the
    // grip of a selected row picks up the whole selection.
//
// A non-primary button (a right-click, which opens the action menu) is treated
    // the same way: right-clicking inside a group keeps the group, so the menu
    // acts on what is actually highlighted. Right-clicking OUTSIDE the group
    // selects just that row first, which is the other half of the convention.
    if (
      state.selectedKeys.size > 1 &&
      state.selectedKeys.has(
        row.key
      ) &&
      (
        isDragSurfacePress(
          rowElement,
          event
        ) ||
        event?.button > 0
      )
    ) {
      // The grabbed row becomes primary, but every other selected row stays
      // selected. No repaint is needed: nothing visible changed.
      state.selectedKey =
        row.key;

      state.selectedMenu =
        row.menuId;

      state.selectionAnchor =
        row.key;

      return;
    }

    applySelection([row]);
    state.selectionAnchor =
      row.key;

    // rowElement is still passed for the caller's benefit, but the class is
    // applied through paintSelection() so every selected row is marked, not
    // just this one.
    void rowElement;
  }

  function getSelectedRow() {
    if (!state.selectedKey) {
      return null;
    }

    return (
      buildRows(
        state.activeMenu
      ).find(
        row =>
          row.key ===
          state.selectedKey
      ) || null
    );
  }

  // Move the selection to the first or last entry currently listed.
  //
  // "Listed" means after the active filter: Home/End should jump to the ends of
  // what the user can actually see, not to entries hidden by the filter.
  //
  // Returns true when a row was selected, so the caller can decide whether the
  // key press was consumed.
  function selectEdgeRow(
    which
  ) {
    const rows =
      getRowsForRender();

    if (!rows.length) {
      return false;
    }

    const row =
      which === "first"
        ? rows[0]
        : rows[rows.length - 1];

    if (!row) {
      return false;
    }

    state.selectedKey =
      row.key;

    state.selectedMenu =
      row.menuId;

    // Home/End mean "the selection is now exactly this one row". Leaving a stale
    // multi-selection behind would make the next drag pick up rows the user can
    // no longer see highlighted.
    state.selectedKeys =
      new Set([row.key]);

    state.selectionAnchor =
      row.key;

    // Re-render rather than toggling the class in place: renderRow() is what
    // marks the selected row, so this keeps the highlight correct no matter how
    // the row got here.
    renderRowsOnly();

    // Look the node up only after rendering — renderRowsOnly() rebuilt the
    // list, so any reference captured earlier is stale.
    const node = [
      ...(
        rowContainer()
          ?.querySelectorAll(
            ".cm-row"
          ) || []
      ),
    ].find(
      item =>
        item._row?.key ===
        row.key
    );

    // "nearest" keeps the list still when the row is already on screen, and
    // only scrolls the minimum needed when it is not.
    node?.scrollIntoView({
      block: "nearest",
    });

    return true;
  }

  // ===========================================================================
  // INLINE RENAME
  // ===========================================================================

  // Grow the rename field to fit its text.
  //
  // CSS `field-sizing: content` does this natively, but only from Firefox 121 and
  // this script supports 100+. So the width is measured here and applied
  // explicitly, which also covers older versions — and measuring is needed
  // anyway to keep the field from ever exceeding the space available.
  //
  // A hidden mirror span is used rather than canvas measureText because the
  // panel's font comes from theme variables and inherited chrome styles; cloning
  // the real input's computed font is the only way to get a width that matches
  // what the user actually sees.
  function fitInputToContent(
    input
  ) {
    const parent = input.parentElement;

    if (!parent) {
      return;
    }

    const probe =
      el(
        "span",
        {
          style:
            "position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden;pointer-events:none;",
        },
        []
      );

    // Mirror the input's own typography, otherwise the probe measures a
    // different font and the field ends up the wrong width.
    const computed =
      getComputedStyle(input);

    for (const property of [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "letterSpacing",
      "textTransform",
    ]) {
      probe.style[property] =
        computed[property];
    }

    // A zero-length value measures nothing, which would collapse the field to
    // its minimum and make it impossible to click into an emptied field.
    probe.textContent =
      input.value || " ";

    parent.appendChild(probe);

    const textWidth =
      probe.getBoundingClientRect()
        .width;

    probe.remove();

    if (!textWidth) {
      // The measurement failed (row not laid out yet, panel hidden, probe
      // collapsed). Falling through without setting a width leaves the CSS
      // minimum in charge, which collapses the field to a sliver and scrolls
      // the selected text out of sight. Leaving the browser's own content-based
      // sizing alone is far safer than pinning a width we could not measure.
      input.style.removeProperty(
        "width"
      );

      return;
    }

    // box-sizing is border-box, so the width we assign is the WHOLE box. Setting
    // it to the bare text width therefore makes the content area narrower than the
    // text and clips it — which is exactly what made the title look deleted.
    // Add the horizontal chrome back on.
    const computedStyle =
      getComputedStyle(input);

    const chrome = [
      "paddingLeft",
      "paddingRight",
      "borderLeftWidth",
      "borderRightWidth",
    ].reduce(
      (total, property) =>
        total +
        (parseFloat(
          computedStyle[property]
        ) || 0),
      0
    );

    // Never overflow the column: a long title has to ellipsize inside the row
    // rather than push the visibility toggle off the edge of the panel.
    const available =
      parent.getBoundingClientRect()
        .width;

    const capped =
      available > 0
        ? Math.min(
            textWidth + chrome,
            available
          )
        : textWidth + chrome;

    input.style.width =
      `${Math.ceil(capped)}px`;
  }

  // The editor-wide Escape shortcut runs in the window capture phase. Inline
  // rename must get first refusal so its own key handler can cancel the edit
  // instead of letting the panel's global shortcut close the whole editor.
  function isInlineRenameInput(node) {
    if (!node) return false;

    try {
      return !!(
        node.matches?.(".cm-name-input") ||
        node.closest?.(".cm-name-input")
      );
    } catch (_) {
      return false;
    }
  }

  // After cancelling a rename, render() rebuilds the row DOM. Put focus back on
  // the same row's title so the user is no longer stuck on a removed input and
  // the next Escape has its normal panel-closing meaning.
  function focusRowTitleAfterRender(row) {
    const container = rowContainer();
    const candidates =
      container?.querySelectorAll?.(".cm-row");

    if (!candidates) return false;

    for (const candidate of candidates) {
      if (candidate?._row?.key !== row?.key) continue;

      const title =
        candidate.querySelector?.(".cm-name");

      if (!title) return false;

      title.focus?.();
      return true;
    }

    return false;
  }

  function startInlineRename(
    rowElement,
    row
  ) {
    const name =
      rowElement.querySelector(
        ".cm-name"
      );

    if (
      !name ||
      name.classList.contains(
        "editing"
      )
    ) {
      return;
    }

    // The input lives inside the same cell that owns the dblclick, so a second
    // double-click while the field is open would land on the cell again. The
    // ".editing" check above already handles the name, but it is replaced by the
    // input, so this is the guard that actually holds.
    if (
      rowElement.querySelector(
        ".cm-name-input"
      )
    ) {
      return;
    }

    const entry =
      ensureRuleForRow(
        row.menuId,
        row
      );

    if (!entry) {
      status(
        "This entry has no usable selector.",
        "error"
      );
      return;
    }

    // Seeded from getRowName(), NOT getRowDisplayName().
    //
    // These used to be two different chains. The row showed
    // label -> disc.label -> disc.tooltiptext -> selector, while the field was
    // seeded from label -> disc.label only. Any row that had to fall back past
    // disc.label — an offline rule with no live node, or one with no label but a
    // tooltip — therefore displayed a name and then opened an EMPTY field, as if
    // the entry had no name at all. Going through getRowName() makes that
    // divergence impossible by construction.
    //
    // The row now DISPLAYS getRowDisplayName(), which prettifies the selector
    // fallback. The divergence is deliberate and one-directional: this seeds from
    // the raw value, so a row shown as "Ask Chat" opens the editor holding
    // "#context-ask-chat". Saving that would write a prettified string into the
    // config as a CUSTOM label the user never typed. A row with no name of its own
    // should open empty, so the first keystroke defines it deliberately.
    const oldValue =
      getRowName(row);

    const input = el(
      "input",
      {
        type: "text",
        class:
          "cm-name-input",
        value: oldValue,
        title:
          "Type a new title. Enter applies, Escape cancels.",
      }
    );

    let finished = false;

    const finish = commit => {
      if (finished) return;
      finished = true;

      const value =
        trim(input.value);

      input.remove();
      name.classList.remove(
        "editing"
      );

      if (!commit) {
        render();
        focusRowTitleAfterRender(row);
        return;
      }

      if (
        !value ||
        value === oldValue
      ) {
        render();
        return;
      }

      const changed =
        rename(
          row.menuId,
          row,
          value
        );

      if (changed) {
        status(
          "Title changed. Save to apply.",
          "ok"
        );
      }

      render();
    };

    name.classList.add(
      "editing"
    );

    name.replaceWith(
      input
    );

    input.addEventListener(
      "keydown",
      event => {
        event.stopPropagation();

        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();
          finish(true);
        } else if (
          event.key ===
          "Escape"
        ) {
          event.preventDefault();
          finish(false);
        }
      }
    );

    input.addEventListener(
      "blur",
      () => finish(true)
    );

    // Size BEFORE selecting, and re-select after every resize.
    //
    // The order matters and was the cause of the title appearing to vanish.
    // Selecting inside a field that is still at its minimum width scrolls the
    // input so the END of the text sits under the caret — the beginning, which is
    // what you want to read, moves off the left edge. Widening the field afterwards
    // does not scroll it back, so the box grew while the text stayed hidden and it
    // looked as though the name had been deleted.
    input.focus();

    // Selects the whole value and scrolls it back to the start, so a field that
    // was too narrow to show the text becomes readable again.
    const revealText = () => {
      if (finished) return;

      input.scrollLeft = 0;

      try {
        input.setSelectionRange(
          0,
          input.value.length
        );
      } catch (_) {
        // Some input types do not support selection ranges.
      }
    };

    fitInputToContent(input);
    revealText();

    // Measured again on the next frame: :focus-visible can change the font after
    // focus, and the row may only have been laid out by then. Without this second
    // pass the field can keep its fallback minimum for the whole edit.
    requestAnimationFrame(() => {
      if (finished) return;

      fitInputToContent(input);
      revealText();
    });

    // Grow and shrink as the title is typed. The field is no longer full width,
    // so without this the text would scroll inside a box that no longer fits it.
    //
    // revealText() must NOT run here. It selects the WHOLE value, so the caret
    // lands on a full-selection and the next keystroke replaces everything —
    // which is what made the field stick at exactly one character. Selection is
    // only for the initial reveal; while typing the caret must be left alone.
    input.addEventListener(
      "input",
      () => {
        const caret = input.selectionStart;
        const caretEnd = input.selectionEnd;

        fitInputToContent(input);

        try {
          // Restoring after the resize keeps the caret where the user typed it
          // (and scrolls it back into view if narrowing the box moved it).
          input.setSelectionRange(caret, caretEnd);
        } catch (_) {
          // Some input types do not support selection ranges.
        }
      }
    );
  }

  // ===========================================================================
  // ROW RENDERING
  // ===========================================================================

  // Whether the row is one an extension contributed.
  //
  // A live extension row carries the flag on its discovered node, while a row the
  // registry recovered before Firefox has built it is flagged registryOnly. Both
  // are extension entries and both are worth filtering and tagging.
  function isExtensionRow(row) {
    return !!(
      row &&
      (
        row.fromExtension ||
        row.registryOnly ||
        row.disc?.fromExtension
      )
    );
  }

  // Short, class-safe names for the contexts a registered item is bound to.
  //
  // Each entry is [badgeText, readableLabel]: the badge text doubles as a CSS class
  // (the badge renderer uses the same string for both), so it must stay a plain
  // lowercase token, while the label is what the tooltip explains.
  const CONTEXT_TOKENS = Object.freeze({
    all: ["all", "any context"],
    page: ["page", "page"],
    frame: ["frame", "frame"],
    selection: ["sel", "selected text"],
    link: ["link", "link"],
    image: ["img", "image"],
    // Both media contexts share one badge now: "media" answers "why does this
    // entry appear" as clearly as the split did, without spending two chips
    // and two hues on a distinction almost nobody acts on. contextTokens()
    // dedupes by token, so an item bound to BOTH (the media controls are)
    // still gets exactly one badge.
    video: ["media", "media"],
    audio: ["media", "media"],
    editable: ["edit", "editable field"],
    custom: ["custom", "custom reference"],
    tab: ["tab", "tab"],
    bookmark: ["bookmark", "bookmark"],
    browser_action: ["toolbar", "toolbar button"],
    page_action: ["pagebtn", "address-bar button"],
    action: ["action", "extension button"],
  });

  // Normalised [token, label] pairs for a registry item's context list.
  //
  // "all" subsumes everything else, so listing it beside the specifics would only
  // be noise: an item registered for "all" gets the single "all" badge instead.
  function contextTokens(contexts) {
    const list = Array.isArray(contexts)
      ? [
          ...new Set(
            contexts
              .map(value =>
                text(value)
                  .toLowerCase()
              )
              .filter(Boolean)
          ),
        ]
      : [];

    if (!list.length) {
      return [];
    }

    if (list.includes("all")) {
      return [CONTEXT_TOKENS.all];
    }

    // One badge per TOKEN, not per raw context: since video and audio both
    // resolve to "media", an item bound to both must not render the same
    // badge twice (and the "+N more" count must not inflate either).
    const seen = new Set();
    const tokens = [];

    for (const context of list) {
      const pair = CONTEXT_TOKENS[context]
        ? [...CONTEXT_TOKENS[context]]
        : [
            context.replace(/[^a-z0-9_-]/g, "-"),
            context,
          ];

      if (seen.has(pair[0])) continue;
      seen.add(pair[0]);
      tokens.push(pair);
    }

    return tokens;
  }

  // Contexts for Firefox's OWN context-menu entries, keyed by element id WITHOUT
  // the "context-" prefix.
  //
  // Extensions report their own contexts through the contextMenus registration,
  // so they never need a table. Firefox's built-in items have no such
  // registration: which of them appear is decided imperatively by the browser's
  // own menu code at popup time, and nothing on the node records why. So the only
  // way to say "Paste only shows up in a text field" is to state it here.
  //
  // Every id below was verified to exist in the installed browser's
  // browser.xhtml, so these are real entries rather than guesses. A key that no
  // longer exists is harmless (nothing looks it up), and an id this build adds
  // later simply gets no tag until the table is extended.
  //
  // "page" is the bare-page context and "frame" the sub-frame one; both are
  // content contexts, matching CONTENT_CONTEXTS above. The live matcher treats
  // Page as active only when no more specific context is active.
  // NOTE: deliberately NOT frozen yet. The media controls and the second group are
  // merged in below, and this file runs in strict mode, where writing to a frozen
  // object throws. It is frozen once, at the end of the definition.
  const NATIVE_CONTEXTS = {
    // ---- selection / editable ----
    undo: ["editable"],
    redo: ["editable"],
    cut: ["selection", "editable"],
    copy: ["selection"],
    paste: ["editable"],
    "paste-no-formatting": ["editable"],
    delete: ["selection"],
    selectall: ["selection", "editable", "page"],
    "reveal-password": ["editable"],

    // ---- page / frame ----
    savepage: ["page"],
    reload: ["page", "frame", "link"],
    stop: ["page"],
    inspect: ["page", "frame", "image", "video", "audio", "link"],
    "inspect-a11y": ["page"],
    "take-screenshot": ["page"],
    sendpagetodevice: ["page"],
    bookmarkpage: ["page"],
    "visual-search": ["page"],
    "ask-chat": ["page"],
    "add-engine": ["page"],
    reloadframe: ["frame"],
    viewframesource: ["frame"],
    saveframe: ["frame"],
    printframe: ["frame"],
    openframe: ["frame"],
    openframeintab: ["frame"],
    bookmarkframe: ["frame"],
    showonlythisframe: ["frame"],

    // ---- link ----
    openlink: ["link"],
    openlinkintab: ["link"],
    openlinkincurrent: ["link"],
    openlinkincontainertab: ["link"],
    openlinkprivate: ["link"],
    openlinksmartwindow: ["link"],
    openlinkinsplitview: ["link"],
    "openlinkinusercontext-menu": ["link"],
    previewlink: ["link"],
    bookmarklink: ["link"],
    savelink: ["link"],
    copylink: ["link"],
    copyemail: ["link"],
    copyphone: ["link"],
    sendlinktodevice: ["link"],
    stripOnShareLink: ["link"],

    // ---- image ----
    viewimage: ["image"],
    viewimagedesc: ["image"],
    viewimageinfo: ["image"],
    saveimage: ["image"],
    copyimage: ["image"],
    "copyimage-contents": ["image"],
    reloadimage: ["image"],
    sendimage: ["image"],
    imagetext: ["image"],
    setDesktopBackground: ["image", "page"],

    // ---- video ----
    viewvideo: ["video"],
    savevideo: ["video"],
    copyvideourl: ["video"],
    "video-saveimage": ["video"],
    sendvideo: ["video"],
    "video-fullscreen": ["video"],
    "leave-dom-fullscreen": ["video"],
    "video-pictureinpicture": ["video"],

    // ---- audio ----
    saveaudio: ["audio"],
    copyaudiourl: ["audio"],
    sendaudio: ["audio"],
  };

  const NATIVE_MEDIA_CONTEXTS =
    Object.freeze([
      "video",
      "audio",
    ]);

  // Media controls apply to both kinds, so they are filled in from one list
  // rather than repeated a dozen times above.
  for (const id of [
    "media-play",
    "media-pause",
    "media-mute",
    "media-unmute",
    "media-loop",
    "media-playbackrate",
    "media-playbackrate-050x",
    "media-playbackrate-100x",
    "media-playbackrate-125x",
    "media-playbackrate-150x",
    "media-playbackrate-200x",
    "media-hidecontrols",
    "media-showcontrols",
    "media-eme-learnmore",
    "media-eme-separator",
    "media-sep-commands",
    "media-sep-video-commands",
  ]) {
    NATIVE_CONTEXTS[id] = [
      ...NATIVE_MEDIA_CONTEXTS,
    ];
  }

  Object.assign(NATIVE_CONTEXTS, {
    // ---- selection-only actions ----
    searchselect: ["selection"],
    "searchselect-private": ["selection"],
    "translate-selection": ["selection"],
    "print-selection": ["selection"],
    "viewpartialsource-selection": ["selection"],
    "copy-clean-link-to-highlight": ["selection"],
    "copy-link-to-highlight": ["selection"],
    "remove-highlight": ["selection"],

    // ---- view source ----
    viewsource: ["page", "frame"],
    "viewsource-goToLine": ["page", "frame"],
    "viewsource-wrapLongLines": ["page", "frame"],
    "viewsource-highlightSyntax": ["page", "frame"],
    viewframeinfo: ["frame"],

    // ---- navigation ----
    back: ["page"],
    forward: ["page"],

    // ---- bidi ----
    "bidi-page-direction-toggle": ["page", "frame"],
    "bidi-text-direction-toggle": ["editable"],

    // ---- PDF.js viewer (its own internal editing contexts) ----
    "pdfjs-undo": ["editable"],
    "pdfjs-redo": ["editable"],
    "pdfjs-cut": ["selection", "editable"],
    "pdfjs-copy": ["selection"],
    "pdfjs-paste": ["editable"],
    "pdfjs-delete": ["selection"],
    "pdfjs-select-all": ["selection"],
    "pdfjs-copy-page": ["page"],
    "pdfjs-cut-page": ["page"],
    "pdfjs-delete-page": ["page"],
    "pdfjs-save-page": ["page"],
    "pdfjs-comment-selection": ["selection"],
    "pdfjs-highlight-selection": ["selection"],
  });

  // Frozen only now, once every merge above has run.
  Object.freeze(NATIVE_CONTEXTS);

  // Strips a native menu-item id down to the bare key NATIVE_CONTEXTS is indexed
  // by.
  //
  // Two shapes have to be handled, because the id arrives in both:
  //
  //   "context-paste"          - the raw DOM node id, as found on disc.id
  //   "#context-paste:not(…)"  - a selector, which may also carry pseudo or
  //                              attribute parts
  //
  // Matching only the selector form silently missed every row whose id came from
  // the live node, which is most of them.
  function nativeIdOf(row) {
    for (const candidate of [
      trim(row?.disc?.id),
      trim(row?.elementId),
      trim(row?.selector),
      trim(row?.disc?.selector),
    ]) {
      if (!candidate) continue;

      const match =
        candidate.match(
          /#context-([a-zA-Z0-9_-]+)/
        ) ??
        candidate.match(
          /^context-([a-zA-Z0-9_-]+)/
        );

      if (match) return match[1];
    }

    return "";
  }

  // The contexts a NATIVE row belongs to, or null when the row is not native or
  // its id is one this table does not cover.
  //
  // Extension rows return null on purpose: their registration is authoritative,
  // and an extension is free to pick a menu-item id that collides with a native
  // one. Letting the table answer there would report a lie.
  function nativeContextsForRow(row) {
    if (!row || row.kind === "separator") {
      return null;
    }

    if (isExtensionRow(row)) {
      return null;
    }

    const contexts =
      NATIVE_CONTEXTS[
        nativeIdOf(row)
      ];

    return Array.isArray(contexts)
      ? [...contexts]
      : null;
  }

  // The context badges for a row.
  //
  // Two very different sources feed this:
  //
  //   extension rows - the contexts the extension registered for, read live from
  //                    the browser's own contextMenus registry, so always accurate.
  //   native rows    - the NATIVE_CONTEXTS table, because Firefox never records
  //                    this anywhere on the node.
  //
  // Both answer the same question: "why does this entry only show up sometimes".
  //
  // Capped, because an item valid in six contexts would otherwise bury every
  // other badge the row has.
  function rowContextBadges(row) {
    if (!row || row.kind === "separator") {
      return [];
    }

    const contexts =
      (
        isExtensionRow(row)
          ? row.contexts ??
            row.disc?.contexts
          : null
      ) ??
      nativeContextsForRow(row);

    const tokens = contextTokens(
      Array.isArray(contexts)
        ? contexts
        : null
    );

    if (!tokens.length) {
      return [];
    }

    const MAX_CONTEXT_BADGES = 4;

    const badges = tokens
      .slice(0, MAX_CONTEXT_BADGES)
      .map(([token, label]) => [
        token,
        `Appears only in the "${label}" context`,
        "context",
      ]);

    if (tokens.length > MAX_CONTEXT_BADGES) {
      badges.push([
        `+${tokens.length - MAX_CONTEXT_BADGES}`,
        `Also appears in: ${tokens
          .slice(MAX_CONTEXT_BADGES)
          .map(([, label]) => label)
          .join(", ")}`,
        "context context-more",
      ]);
    }

    return badges;
  }

  function rowBadges(row) {
    const badges = [];

    if (row?.identityCollision) {
      badges.push([
        "duplicate DOM ID",
        "More than one connected menu element in this menu scope has the same exact ID. These are not stale saved rules; the underlying DOM has duplicate identity, so independent reordering may be ambiguous.",
      ]);
    }

    if (row?.unverified) {
      badges.push([
        "unverified",
        "Saved selector not currently confirmed by a live node or active extension registration. Its configuration has not been deleted.",
      ]);
    } else if (row?.dormant) {
      badges.push([
        "dormant",
        "This selector matched a real menu item earlier in this browser session, but the node is absent now. It is kept in the Dormant filter in case the item is context-specific or lazily created.",
      ]);
    }

    // Extension-created entries are special because Firefox creates their DOM
    // nodes only while the menu is being shown. Keep the badge for both live and
    // registry-only rows.
    if (isExtensionRow(row)) {
      // A registry-only row is registered and real; it simply has no node yet.
      // Saying so is what stops "extension" reading as "possibly broken".
      badges.push([
        row.registryOnly
          ? "registered"
          : "extension",

        row.registryOnly
          ? `Registered by ${
              row.extensionName ||
              "an extension"
            } — appears in the real menu when its context applies`
          : row.extensionName
            ? `Registered by ${row.extensionName}`
            : "Registered by an extension",
      ]);
    }

    // Which context the item is bound to. This is the answer to "why does this
    // entry only show up sometimes".
    badges.push(
      ...rowContextBadges(row)
    );

    // A collapsed parent is a group row, so say how many live child entries it
    // contains rather than implying the row is one individual menu item.
    if (
      row.childCount > 1
    ) {
      badges.push([
        "submenu",
        `Contains ${row.childCount} entries`,
      ]);
    }

    // Hidden state is already communicated by the row's red background and
    // the disabled-name treatment. A separate "hidden" chip repeats the same
    // information and competes with the useful registration/context tags.

    if (
      entryLabel(row.entry)
    ) {
      badges.push([
        "renamed",
        "Renamed",
      ]);
    }

    if (row.pinned) {
      badges.push([
        "tail",
        "Pinned to tail",
      ]);
    }

    if (rowHasChildOrder(row)) {
      badges.push([
        "children ordered",
        "Child entries have a custom order",
      ]);
    }

    if (
      row.kind ===
      "separator"
    ) {
      badges.push([
        "separator",
        "Separator",
      ]);
    }

    return badges;
  }

  // The child total is metadata, not part of the editable menu title. Keep
  // its formatting in one place so singular/plural and empty groups are stable.
  function groupCountText(row) {
    if (!row?.isGroupParent) return "";
    const count = Math.max(0, Math.floor(Number(row.childCount) || 0));
    if (!count) return "";
    return `(${count} ${count === 1 ? "entry" : "entries"})`;
  }

  // Pointer capture can retarget the later dblclick to the drag surface. Keep
  // the original pointerdown target on the name cell, then permit inline rename
  // only when that original target was inside the actual editable title span.
  // This leaves parent counts and the disclosure/reorder buttons informational
  // or actionable without making them rename targets.
  function isEditableTitleGesture(label, event, nameButton) {
    const pointerTarget = label?._cmeRenamePointerTarget || null;
    label._cmeRenamePointerTarget = null;
    const target = pointerTarget || event?.target || null;
    return !!(
      target &&
      nameButton &&
      (target === nameButton || nameButton.contains?.(target))
    );
  }

  // Expansion identity must survive a fresh buildRows() pass. A row.key is
  // generated while reconciling live DOM and registry snapshots; those snapshots
  // can gain/lose transient rows between renders. Using that render-time key for
  // disclosure state can therefore make a click appear to do nothing: the Set is
  // updated for the old key, then the rebuilt parent has a different key.
  // Registered extension items have a stable extension ID + typed menuItemId;
  // synthetic extension wrappers have a stable extension ID; native groups fall
  // back to their menu ID + persistent selector.
  function groupExpansionKey(row) {
    const disc = row?.disc || {};
    const extensionId = String(
      disc.extensionId || row?.extensionId || ""
    ).trim().toLowerCase();

    if (disc.collapsedContainer && extensionId) {
      return `extension-root\u0000${extensionId}`;
    }

    if (
      extensionId &&
      disc.extensionMenuId !== undefined &&
      disc.extensionMenuId !== null
    ) {
      return [
        "extension-item",
        extensionId,
        typeof disc.extensionMenuId,
        String(disc.extensionMenuId),
      ].join("\u0000");
    }

    return [
      "native-group",
      String(row?.menuId || ""),
      trim(row?.selector || row?.entry?.selector || row?.key),
    ].join("\u0000");
  }

  function isGroupExpanded(row) {
    return state.expandedGroups.has(groupExpansionKey(row));
  }

  function toggleGroupExpanded(row, event = null) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const key = groupExpansionKey(row);
    const expanded = !state.expandedGroups.has(key);
    if (expanded) state.expandedGroups.add(key);
    else state.expandedGroups.delete(key);

    renderRowsOnly();
    return expanded;
  }

  function buildChildOrderControls(row) {
    if (!row?.isGroupChild || !row.parentSelector) return null;

    const controls = el("span", {
      class: "nested-order-controls",
      "aria-label": "Reorder child entry",
    });

    const add = (labelText, titleText, delta) => {
      const control = button(
        labelText,
        titleText,
        () => {
          reorderChildRow(
            row.menuId,
            row,
            delta < 0 ? "Move child up" : "Move child down",
            delta
          );
          render();
        },
        {
          class: "nested-order-button",
          "aria-label": titleText,
        }
      );
      // This lives inside a name-cell drag surface. Stop both pointer and
      // compatibility mouse presses so the arrow acts as a button, not a drag.
      control.addEventListener("pointerdown", event => event.stopPropagation());
      control.addEventListener("mousedown", event => event.stopPropagation());
      return control;
    };

    controls.append(
      add("↑", "Move child up", -1),
      add("↓", "Move child down", 1)
    );
    return controls;
  }

  function renderRow(row) {
    if (
      row.kind ===
      "separator"
    ) {
      const wrap = el(
        "div",
        {
          class: row.isGroupChild
            ? "cm-row cm-separator-row cm-row-nested"
            : "cm-row cm-separator-row",
        }
      );

      wrap._row = row;

      if (
        state.selectedKeys.has(
          row.key
        )
      ) {
        wrap.classList.add(
          "selected"
        );

        if (
          state.selectedKeys.size > 1
        ) {
          wrap.classList.add(
            "multi"
          );
        }
      }

      // A span, not a <button>.
      //
      // Firefox does not start a native HTML5 drag from a <button>, so the grip
      // had to be a plain element. The button role and tabindex keep it
      // reachable and announced the same way.
      const handle = el(
        "span",
        {
          role: "button",
          tabindex: "0",
          class:
            "drag-handle",
          text: "⠿",
          title: row.entry
            ? "Drag separator"
            : "Drag to organize this menu",
        }
      );

      wrap.addEventListener(
        "mousedown",
        event =>
          selectRow(
            wrap,
            row,
            event
          )
      );

      attachRowContextMenu(
        wrap,
        row
      );

      wrap.append(
        handle,

        el(
          "span",
          {
            class:
              "separator-line",
            text:
              "────────  separator  ────────",

            // The selector ("sep:7") used to sit here as its own
            // ".separator-meta" cell. It survives as a tooltip: the row stays
            // clean, while the raw ordinal stays readable — menu-config.json
            // still addresses separators positionally as "sep:N".
            title:
              row.selector,
          }
        )
      );

      // A separator has no name to click-rename, so double-clicking it keeps
      // its old meaning: take control of the menu's order.
      wrap.addEventListener(
        "dblclick",
        () => {
          adoptBrowserOrder(
            row.menuId
          );
        }
      );

      attachDragSource(
        handle,
        wrap,
        row
      );

      return wrap;
    }

    const hidden =
      !!row.entry?.hidden;

    const name =
      getRowDisplayName(row) ||
      "(unlabelled)";

    // "offline" is reserved for rules that really have nothing behind them.
    //
    // A registry-only extension entry is NOT offline: the extension has
    // registered it and Firefox will build it the moment the menu is opened for
    // a matching context. Dimming it made working entries look broken, so it
    // gets its own class and full opacity instead.
    const dimmed =
      row.offline &&
      !row.registryOnly;

    const wrap = el(
      "div",
      {
        class: [
          "cm-row",

          hidden
            ? "is-hidden"
            : "",

          dimmed
            ? "is-offline"
            : "",

          row.registryOnly
            ? "is-registry"
            : "",

          row.unverified
            ? "is-unverified"
            : "",

          row.isGroupParent
            ? "is-group-parent"
            : "",

          row.isGroupChild
            ? "is-group-child"
            : "",

          row.entry
            ? "is-managed"
            : "is-unmanaged",
        ]
          .filter(Boolean)
          .join(" "),
      }
    );

    wrap._row = row;

    if (
      state.selectedKeys.has(
        row.key
      )
    ) {
      wrap.classList.add(
        "selected"
      );

      if (
        state.selectedKeys.size > 1
      ) {
        wrap.classList.add(
          "multi"
        );
      }
    }

    // Same reasoning as the separator grip above: a span, because a <button>
    // will not start a native drag in Firefox.
    const handle = el(
      "span",
      {
        role: "button",
        tabindex: "0",
        class:
          "drag-handle",
        text: "⠿",
        title: row.entry
          ? "Drag to reorder"
          : "Drag to organize this menu",
      }
    );

    const label =
      el(
        "div",
        {
          class:
            "name-cell",
        }
      );

    // No "*" prefix any more. It existed to flag a title recovered from the
    // extension registry, but now that registry-recovered entries are detected
    // and labelled properly, the asterisk only added noise to every such row.
    // The explanation survives in the tooltip, where it costs no visual weight.
    const nameButton =
      el(
        "span",
        {
          class:
            "cm-name",
          text:
            name,
          title:
            row.identityCollision
              ? `${name}\n\nDuplicate live DOM ID. More than one connected element in this menu scope shares this ID. The editor keeps both real nodes visible rather than silently discarding one; ordering may be ambiguous.\nSelector: ${row.selector}`
              : row.unverified
                ? `${name}\n\nUnverified saved rule. No matching live menu node, active extension registration, or observation in this browser session was found. The rule is preserved in menu-config.json and is shown here only so you can inspect or release it. Open the relevant context/submenu once to let the editor verify a dynamic item.\nSelector: ${row.selector}`
                : row.dormant
                  ? `${name}\n\nDormant saved rule. This item was observed earlier in this browser session, but its DOM node is absent now. It may be lazily created or context-specific; open the relevant menu/submenu to bring it back into the live list. The rule is preserved.\nSelector: ${row.selector}`
                  : DISCOVERY_POLICY.isRuntimeHidden(row)
                    ? `${name}\n\nThis is a live menu item. Its owning popup currently marks it hidden for the active context/conditions; that does not mean the selector is dead.\nSelector: ${row.selector}`
                    : row.nameInferred
                      ? `${name}\n\nTitle recovered from the active extension registry. Firefox may materialise this menu item only when its context applies.\nSelector: ${row.selector}`
                      : "Double-click the title to rename • Enter/F2 to edit • Drag the row to reorder • Right-click for more actions",
          tabindex:
            "0",
        }
      );

    // Record the original hit target before attachDragSource() captures the
    // pointer on this cell. The eventual dblclick may be retargeted to `label`,
    // so relying on event.target alone would make the count look editable again.
    label.addEventListener(
      "pointerdown",
      event => {
        label._cmeRenamePointerTarget = event.target?.nodeType === 1
          ? event.target
          : event.target?.parentElement || null;
      },
      true
    );

    // Only the title itself is a rename target. The sibling child-count label
    // is deliberately outside .cm-name and receives no edit gesture or text-like
    // hover treatment. The rest of the cell remains a drag surface.
    label.addEventListener(
      "dblclick",
      event => {
        if (!isEditableTitleGesture(label, event, nameButton)) return;
        if (event.target.closest?.("input, button")) return;

        event.preventDefault();
        startInlineRename(wrap, row);
      }
    );

    nameButton.addEventListener(
      "keydown",
      event => {
        if (
          event.key ===
            "Enter" ||
          event.key ===
            "F2"
        ) {
          event.preventDefault();

          startInlineRename(
            wrap,
            row
          );
        }
      }
    );

    const meta =
      el(
        "span",
        {
          class:
            "selector",

          // The literal selector, verbatim. Deliberately NOT prettified.
          //
          // This line used to be rewritten for reading — "#context-visual-search"
          // shown as "Visual Search". That reads nicely but destroys the only
          // thing this line exists to be: the row's real identity. Every use of
          // it is a literal one. Copying the id out to paste into
          // menu-config.json, grepping the config for it, or typing it into the
          // row's own "manage this selector" action all need the exact string —
          // and a prettified one has to be mentally un-rewritten first, which is
          // worse than the plain id ever was.
          //
          // The pretty form is still used for the TITLE, via
          // getRowDisplayName(), where it solves a real problem instead of
          // hiding a real one. See the note on CUTE_NAMES.
          text:
            state.showIds
              ? row.selector
              : (
                  row.entry?.selector ||
                  row.selector ||
                  ""
                ),

          // Not redundant. .selector is one nowrap line with an ellipsis, so a
          // long extension selector is cut off on screen; the tooltip is the only
          // way to read the tail that got clipped.
          title:
            row.entry?.selector ||
            row.selector ||
            "",
        }
      );

    const titleLine = el("div", { class: "cm-title-line" });

    if (row.isGroupParent && Array.isArray(row.children)) {
      const expanded = isGroupExpanded(row);
      const toggle = button(
        "",
        expanded ? "Collapse child entries" : "Expand child entries",
        event => toggleGroupExpanded(row, event),
        {
          class: "group-toggle",
          "aria-expanded": String(expanded),
          "aria-label": expanded ? "Collapse child entries" : "Expand child entries",
        }
      );

      // The button lives inside .name-cell, which is a pointer-capture drag
      // surface. Stop the press before it bubbles to that parent. This is
      // intentionally done on BOTH pointerdown and mousedown: Firefox emits
      // compatibility mouse events after pointer events, and the row also has a
      // mousedown selection listener. Neither drag nor row-selection logic
      // should be involved in a disclosure-button activation. The click listener
      // above remains on the button, including native Enter/Space activation.
      const stopDisclosurePress = event => event.stopPropagation();
      toggle.addEventListener("pointerdown", stopDisclosurePress);
      toggle.addEventListener("mousedown", stopDisclosurePress);

      titleLine.appendChild(toggle);
    }

    titleLine.appendChild(nameButton);

    const childCountText = groupCountText(row);
    if (childCountText) {
      titleLine.appendChild(
        el("span", {
          class: "cm-entry-count",
          text: childCountText,
          role: "note",
          title: "Informational child count — this is not part of the editable menu title.",
          "aria-label": `${row.childCount} child entries; informational, not editable`,
        })
      );
    }

    // Dragging remains the primary gesture; these compact controls provide a
    // direct, discoverable fallback for child menu entries.
    const orderControls = buildChildOrderControls(row);
    if (orderControls) titleLine.appendChild(orderControls);

    label.append(
      titleLine,
      meta
    );

    const badges =
      el(
        "span",
        {
          class:
            "badges",
        }
      );

    // A badge is [text, title] with an optional third element naming extra CSS
    // classes. The text doubles as the base class (see CONTEXT_TOKENS), so a badge
    // can be both its own class and belong to a shared group.
    for (
      const [
        badge,
        title,
        extraClass,
      ] of rowBadges(row)
    ) {
      badges.appendChild(
        el(
          "span",
          {
            class:
              `badge ${badge}${
                extraClass
                  ? ` ${extraClass}`
                  : ""
              }`,
            text:
              badge,
            title,
          }
        )
      );
    }

    label.appendChild(
      badges
    );

    // The visibility checkbox is back, at the right edge of the row (built
    // above, appended below).
    //
    // It was removed once on the grounds that right-click reached the same
    // Hide/Show action, but a hidden control is not a read: with it gone there
    // was no way to SEE which entries were disabled, only to guess. This is the
    // read AND the write, on the row itself, in the place it belongs.
    //
    // The mousedown guard below keeps its "button, input" skip, which is what
    // stops a right-click or a drag started on the checkbox from being read as
    // a background selection.

    // No selection handler on the grip or the name: both bubble to this one, and
    // registering them separately is what made a single press select twice.
    wrap.addEventListener(
      "mousedown",
      event => {
        if (
          event.target !==
            wrap &&
          wrap.contains(
            event.target
          )
        ) {
          const control =
            event.target.closest?.(
              "button, input"
            );

          if (control) return;
        }

        selectRow(
          wrap,
          row,
          event
        );
      }
    );

    // Double-clicking the title renames in place; the child-count metadata is
    // deliberately not an edit target. Everything else lives in the row menu,
    // now reached by right-clicking the row.

    // The visibility checkbox, restored at the right edge of the entry. It is
    // the direct read/write control for the entry's "hidden" state: checked
    // means the entry is ENABLED (shown in Firefox), unchecked means DISABLED.
    // It drives the exact same setHidden() command the row menu uses, so it
    // participates in undo/redo and marks the config dirty like every command.
    const visibilityToggle = el(
      "input",
      {
        type: "checkbox",
        class: "visibility-toggle",
        title: hidden
          ? "This entry is disabled (hidden). Tick to enable it."
          : "This entry is enabled. Untick to disable (hide) it.",
        onchange: event => {
          const targets = rowsForVisibilityAction(row);
          setHiddenForRows(
            row.menuId,
            targets,
            !event.target.checked
          );
          render();
        },
      }
    );

    // Reflect the live state. el() only setAttribute()s, and setAttribute
    // ("checked", false) would still tick the box, so the property is assigned
    // here after construction.
    visibilityToggle.checked = !hidden;

    // The context filter is a compact tag chooser. The top line summarizes
    // every active tag; choosing another option toggles that tag instead of
    // replacing the current set. This supports combinations such as
    // "Media + Audio" or "Page + Custom" without expanding the row height.
    // Only content-area menus have click-context tags.
    const contextFilter = isContentMenu(row.menuId)
      ? el(
          "select",
          {
            class: "context-filter",
            title:
              `Active context tags: ${contextFilterSummary(row.entry)}\n` +
              "Choose a tag to toggle it on/off. Multiple tags are allowed; any selected tag may match.\n" +
              "Custom asks for another menu item ID/selector and follows that item's visibility.",
            onchange: event => {
              const value = event.target.value;
              if (value === "custom") {
                // The custom-reference UI is asynchronous and lives outside the
                // row list. Do not repaint immediately: doing so can steal focus
                // from its newly opened input.
                setCustomContextReference(row.menuId, row);
                return;
              }

              setContext(row.menuId, row, value);
              render();
            },
          },
          [
            el("option", {
              value: "__current__",
              text: contextFilterSummary(row.entry),
              disabled: "disabled",
            }),
            ...CONTEXT_FILTER_OPTIONS.map(option => {
              const checked = option.value !== "all" && contextTagSelected(row.entry, option.value);
              return el("option", {
                value: option.value,
                text: checked ? `✓ ${option.label}` : option.label,
              });
            }),
          ]
        )
      : null;

    if (contextFilter) {
      contextFilter.value = contextFilterValue(row.entry);
      contextFilter.classList.toggle(
        "restricted",
        contextFilterHasRestriction(row.entry)
      );
    }

    // Spread the filter in only when it exists. Element.append() stringifies a
    // null argument into a stray "null" text node, which would occupy a grid
    // track and knock every non-content-menu row out of alignment with its
    // header.
    wrap.append(
      handle,
      label,
      ...(contextFilter ? [contextFilter] : []),
      visibilityToggle
    );

    // Row gestures: the grip and the whole name cell are drag surfaces, so a
    // short title can be grabbed by the empty space beside it instead of by the
    // 28px grip alone. The name cell is the big one — it owns the rest of the
    // line, which is the point of shrinking .cm-name to fit-content.
    // Nested rows now have their own grip too. performDrop() scopes the move to
    // siblings with the same parentSelector, so the visible drag affordance
    // cannot pull a child out of its submenu.
    attachDragSource(
      handle,
      wrap,
      row
    );

    attachRowContextMenu(
      wrap,
      row
    );

    // The entire name cell is a drag surface for EVERY row, including nested
    // children. The previous guard left children draggable only from the tiny
    // grip, which made nested reordering appear unavailable when users naturally
    // grabbed the child label. Interactive controls inside the cell (the group
    // disclosure and the child-order buttons) are excluded by attachDragSource.
    attachDragSource(
      label,
      wrap,
      row
    );

    return wrap;
  }

  // ===========================================================================
  // DRAG & DROP
  // ===========================================================================
  //
  // Reordering is driven by POINTER events, not by native HTML drag-and-drop.
  //
  // Native DnD was tried first and does not work here: inside a Firefox chrome
  // document "dragstart" and "dragover" both fire, but the browser never
  // completes the session — no "drop" and no "dragend" are ever delivered — so
  // the rows simply never moved. Pointer events have no such restriction and
  // behave identically for mouse, pen and touch.
  //
  // The grip and the name cell are both drag surfaces. Only the title span is
  // double-click-to-rename; a press that moves beyond the threshold becomes a
  // drag instead. The reorder itself is model-driven, with coordinate-based
  // insertion markers and auto-scroll shared by root and nested rows.

  let draggedRow = null;

  // The in-flight gesture, or null. `active` only becomes true once the pointer
  // has travelled far enough to count as a drag, so a plain click on the handle
  // still just selects the row.
  let dragSession = null;

  // How far the pointer must travel before a press becomes a drag. Without this
  // threshold every click on the handle would start a drag.
  const DRAG_THRESHOLD = 4;

  // Where the pointer was during the current drag.
  //
  // The list cannot be scrolled with the wheel once a native drag has started:
  // the browser owns the pointer and delivers no wheel events to the page at
  // all, so the gesture simply stops working. Auto-scroll is the replacement,
  // and it needs the position reported by "dragover" to know which edge is being
  // approached.
  let dragPointer = null;
  let autoScrollFrame = 0;

  // How close to an edge the pointer has to get before scrolling starts, and the
  // most it may move per frame.
  const AUTOSCROLL_ZONE = 54;
  const AUTOSCROLL_SPEED = 17;

  function clearDropIndicators() {
    for (
      const element of
      rowContainer()
        ?.querySelectorAll(
          ".drop-before, .drop-after"
        ) || []
    ) {
      element.classList.remove(
        "drop-before",
        "drop-after"
      );
    }
  }

  // The row under a viewport point, or null when the pointer is over the header,
  // a gap between rows, or outside the list entirely.
  function rowElementAt(
    x,
    y
  ) {
    const container = rowContainer();

    // Hit-testing the actual painted element avoids choosing an overlapping
    // ancestor/earlier row when Firefox's chrome layout produces fractional or
    // temporarily overlapping row rectangles during auto-scroll.
    const hit = document.elementFromPoint?.(x, y);
    const hitRow = hit?.closest?.(".cm-row") || null;
    if (hitRow && container?.contains?.(hitRow)) return hitRow;

    // Fallback for headless tests and chrome surfaces where elementFromPoint
    // does not return the panel's HTML descendants.
    const candidates = [
      ...(container?.querySelectorAll?.(".cm-row") || []),
    ];
    let best = null;
    let bestArea = Infinity;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      if (
        y >= rect.top && y <= rect.bottom &&
        x >= rect.left && x <= rect.right
      ) {
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area < bestArea) {
          best = element;
          bestArea = area;
        }
      }
    }
    return best;
  }

  // Paints the insertion line for whatever row is under the pointer.
  //
  // Driven by coordinates rather than by the event target, because after the
  // list scrolls underneath a stationary pointer the row that last received
  // "dragover" is no longer the one being aimed at. That is precisely the case
  // auto-scroll creates, so recomputing per frame is what keeps the marker honest.
  function updateDropIndicator(
    x,
    y
  ) {
    clearDropIndicators();

    if (!draggedRow) return;

    const target =
      rowElementAt(x, y);

    if (!target) {
      return;
    }

    // A nested row can only be dropped among siblings in the same submenu;
    // likewise, a root item cannot be dropped into a child list. Do not show a
    // misleading insertion line over an invalid destination.
    if (
      rowOrderScopeKey(target._row) !==
      rowOrderScopeKey(draggedRow.row)
    ) {
      return;
    }

    // No marker on ANY row being carried, not just the grabbed one. A group drag
    // passing over its own members is a no-op (performDrop reports "same-row"),
    // so an insertion line there would promise a move that cannot happen.
    const draggedKeys =
      new Set(
        [
          ...(
            Array.isArray(draggedRow.rows)
              ? draggedRow.rows
              : []
          ),
          ...(
            draggedRow.row
              ? [draggedRow.row]
              : []
          ),
        ]
          .map(
            row => row?.key
          )
          .filter(
            key =>
              key != null
          )
      );

    if (
      draggedKeys.has(
        target._row?.key
      )
    ) {
      return;
    }

    const rect =
      target.getBoundingClientRect();

    target.classList.toggle(
      "drop-after",
      y >=
        rect.top +
          rect.height / 2
    );

    target.classList.toggle(
      "drop-before",
      y <
        rect.top +
          rect.height / 2
    );
  }

  function autoScrollTick() {
    autoScrollFrame = 0;

    const container =
      rowContainer();

    if (
      !draggedRow ||
      !dragPointer ||
      !container
    ) {
      dragPointer = null;
      return;
    }

    const rect =
      container.getBoundingClientRect();

    const {
      x,
      y,
    } = dragPointer;

    // How far past each edge the pointer is; zero while it is well inside.
    const pastTop =
      AUTOSCROLL_ZONE -
      (y - rect.top);

    const pastBottom =
      AUTOSCROLL_ZONE -
      (rect.bottom - y);

    // The nearer edge wins, so a list short enough to sit under the pointer from
    // both sides still scrolls toward whichever side the cursor is closer to.
    const past =
      Math.max(
        pastTop,
        pastBottom
      );

    const delta =
      past > 0
        ? (
            pastTop >=
            pastBottom
              ? -1
              : 1
          ) *
          (
            past /
            AUTOSCROLL_ZONE
          ) *
          AUTOSCROLL_SPEED
        : 0;

    if (delta) {
      const before =
        container.scrollTop;

      container.scrollTop =
        before + delta;

      // The rows just moved, so the insertion line has to move with them.
      if (
        container.scrollTop !==
        before
      ) {
        updateDropIndicator(
          x,
          y
        );
      }
    }

    autoScrollFrame =
      requestAnimationFrame(
        autoScrollTick
      );
  }

  function startAutoScroll() {
    if (autoScrollFrame) {
      return;
    }

    autoScrollFrame =
      requestAnimationFrame(
        autoScrollTick
      );
  }

  function stopAutoScroll() {
    if (
      autoScrollFrame
    ) {
      cancelAnimationFrame(
        autoScrollFrame
      );
    }

    autoScrollFrame = 0;
    dragPointer = null;
  }

  // A visible, self-describing drag image.
  //
  // The default preview is a snapshot of the drag source, which here is the
  // 28px grip: too small and too anonymous to read as "you are moving this row".
  // The ghost is parked off-screen, handed to setDragImage, then removed on the
  // next tick — setDragImage only works while the element is in the document.
  function buildDragGhost(
    row,
    rows = [row]
  ) {
    const extra =
      Math.max(
        0,
        (rows?.length || 1) - 1
      );

    const ghost =
      el(
        "div",
        {
          class:
            "cm-drag-ghost",
        },
        [
          // Only shown for a multi-row drag. A single-row drag keeps the exact
          // ghost it always had, so nothing about the common case changes.
          extra
            ? el(
                "span",
                {
                  class:
                    "cm-drag-ghost-count",
                  text: `${extra + 1} items`,
                }
              )
            : null,

          el(
            "span",
            {
              class:
                "cm-drag-ghost-name",

              // The same prettified title the row itself shows, so a dragged
              // entry never reverts to its raw selector mid-gesture.
              text:
                getRowDisplayName(row) ||
                "(unlabelled)",
            }
          ),
        ]
      );

    ghost.setAttribute(
      "aria-hidden",
      "true"
    );

    document.documentElement.appendChild(
      ghost
    );

    return ghost;
  }

  function finishPointerDrag(commit, event = null) {
    if (!dragSession) return;

    const session = dragSession;
    dragSession = null;

    try {
      session.surface?.releasePointerCapture?.(session.pointerId);
    } catch (_) {
      // Pointer capture is optional. Document-level listeners continue to work
      // when capture is unavailable in a particular chrome/XUL context.
    }

    // Never became a drag: this was just a click on the handle/name cell.
    if (!session.active) return;

    // Use the actual pointer-up coordinates. The old implementation used the
    // last pointermove point, which can lag the release point when Firefox sends
    // a final coalesced move or when pointer capture is not available.
    const x = Number.isFinite(event?.clientX)
      ? event.clientX
      : (dragPointer?.x ?? session.startX);
    const y = Number.isFinite(event?.clientY)
      ? event.clientY
      : (dragPointer?.y ?? session.startY);

    const targetEl = rowElementAt(x, y);
    const targetRow = targetEl?._row || null;
    let after = false;

    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      after = y >= rect.top + rect.height / 2;
    }

    endDrag(session);

    if (commit && targetRow) {
      performDrop(
        session.rows?.length > 1 ? session.rows : session.row,
        targetRow,
        after
      );
    }
  }

  function handleDocumentPointerMove(event) {
    if (
      !dragSession ||
      dragSession.pointerId !== event.pointerId
    ) {
      return;
    }

    if (!dragSession.active) {
      const moved =
        Math.abs(event.clientX - dragSession.startX) +
        Math.abs(event.clientY - dragSession.startY);
      if (moved < DRAG_THRESHOLD) return;
      beginDrag();
    }

    // Stops text selection and keeps the editor's own pointer gesture in charge.
    event.preventDefault();
    dragPointer = { x: event.clientX, y: event.clientY };
    updateDropIndicator(event.clientX, event.clientY);
    moveDragGhost(event.clientX, event.clientY);
  }

  function handleDocumentPointerUp(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    finishPointerDrag(true, event);
  }

  function handleDocumentPointerCancel(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    finishPointerDrag(false, event);
  }

  // Listen at the document in capture phase, rather than only on the tiny grip.
  // Firefox chrome documents and some XUL surfaces do not consistently deliver
  // pointer capture to ordinary HTML descendants. Document capture works with or
  // without setPointerCapture and still observes a release over a different row.
  document.addEventListener("pointermove", handleDocumentPointerMove, true);
  document.addEventListener("pointerup", handleDocumentPointerUp, true);
  document.addEventListener("pointercancel", handleDocumentPointerCancel, true);

  function attachDragSource(
    surface,
    rowElement,
    row
  ) {
    surface.addEventListener(
      "pointerdown",
      event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        if (dragSession) return;

        // Buttons, inputs, links and editable fields keep their own gestures.
        // Do not include [role="button"]: the drag grip intentionally has that
        // role, while actual buttons are caught by the `button` selector.
        const target = event.target?.nodeType === 1
          ? event.target
          : event.target?.parentElement;
        if (target?.closest?.(
          "button, input, select, textarea, a[href], [contenteditable='true']"
        )) {
          return;
        }

        try {
          surface.setPointerCapture?.(event.pointerId);
        } catch (_) {
          // Optional optimization only; document-level tracking is authoritative.
        }

        dragSession = {
          pointerId: event.pointerId,
          row,
          rowElement,
          surface,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          ghost: null,
        };

        // Selection is deliberately left to the row's mousedown handler. That
        // preserves Ctrl/Shift selection semantics and prevents double toggles.
      }
    );
  }

  // The rows the current drag is carrying.
  //
  // Resolved by KEY, never by object identity. getSelectedRows() runs
  // buildRows(), which allocates a completely fresh row object on every call, so
  // an `includes(dragSession.row)` identity test could never match — not even
  // for a row the user had definitely selected. That silently reduced every
  // multi-row drag to a single-row drag, and left the other rows' elements
  // un-dimmed, which is what made the selection look like it had been lost.
  //
  // "Drag just this row" still has to work, so an unselected grabbed row falls
  // back to itself rather than sweeping up whatever happened to be selected.
  function resolveDragGroup(row) {
    const selection =
      getSelectedRows().filter(
        candidate =>
          candidate.menuId ===
          row.menuId &&
          rowOrderScopeKey(candidate) === rowOrderScopeKey(row)
      );

    const keys =
      new Set(
        selection.map(
          candidate =>
            candidate.key
        )
      );

    return keys.has(
      row.key
    )
      ? selection
      : [row];
  }

  // Puts the drag into its active state: the source row dims, the ghost
  // appears and follows the cursor, and auto-scroll takes over.
  function beginDrag() {
    if (!dragSession) return;

    dragSession.active = true;

    // The group is resolved ONCE, here, rather than being re-read at drop time.
    // Between press and release the selection can legitimately change (a stray
    // click, a re-render from a background change), and dropping a set of rows
    // the user never picked is far worse than dropping the set they did.
    const rows =
      resolveDragGroup(
        dragSession.row
      );

    dragSession.rows = rows;

    const keys =
      new Set(
        rows.map(
          candidate =>
            candidate.key
        )
      );

    const elements = [
      ...(
        rowContainer()
          ?.querySelectorAll(
            ".cm-row"
          ) || []
      ),
    ].filter(
      node =>
        node._row &&
        keys.has(
          node._row.key
        )
    );

    dragSession.sourceElements =
      elements;

    draggedRow = {
      row: dragSession.row,
      rows,
      sourceElement:
        dragSession.rowElement,
    };

    for (
      const element of
      dragSession.sourceElements ||
      []
    ) {
      element.classList.add(
        "dragging"
      );
    }

    dragSession.ghost =
      buildDragGhost(
        dragSession.row,
        dragSession.rows
      );

    // Place it now rather than waiting for the first pointermove, otherwise it
    // flashes at the top-left corner of the window for a frame.
    moveDragGhost(
      dragPointer?.x ?? dragSession.startX,
      dragPointer?.y ?? dragSession.startY
    );

    startAutoScroll();
  }

  // Undoes everything beginDrag set up.
  //
  // The session is passed in rather than read from `dragSession`, because
  // finishDrag clears that global BEFORE calling this. Reading it here would
  // always find null, and the ghost would never be removed — which is exactly
  // how stray "ghost menu entries" were left stuck on screen.
  function endDrag(session) {
    stopAutoScroll();
    draggedRow = null;
    dragPointer = null;

    // Every source row has to be un-dimmed, not just the one the gesture started
    // from — missing the extras left rows stuck at .dragging opacity forever.
    for (
      const element of
      session?.sourceElements || []
    ) {
      element.classList.remove(
        "dragging"
      );
    }

    // Belt and braces: rowElement may not be in sourceElements if the list
    // re-rendered between press and release.
    session?.rowElement?.classList.remove(
      "dragging"
    );

    session?.ghost?.remove();

    clearDropIndicators();
  }

  function moveDragGhost(x, y) {
    const ghost =
      dragSession?.ghost;

    if (!ghost) return;

    ghost.style.transform =
      `translate(${Math.round(x) + 14}px, ${Math.round(y) + 16}px)`;
  }

  // Applies a completed drag to the model.
  //
  // Kept separate from the event plumbing so the reorder itself can be reasoned
  // about — and tested — without simulating a gesture.
  // Records what the last attempted drop actually did. Purely diagnostic: it is
  // what makes "the drag gesture reached the model" verifiable without having
  // to guess from the DOM afterwards.
  let lastDrop = null;

  // `source` is one row or an array of them. Accepting both keeps the existing
  // single-row call sites and diagnostics working unchanged.
  function performDrop(
    source,
    target,
    after
  ) {
    const sources =
      Array.isArray(source)
        ? source.filter(Boolean)
        : source
          ? [source]
          : [];

    // The reported "source" is the row the user actually grabbed, which is the
    // first of the group. Tests and lastDrop() read sourceKey, so it has to
    // keep meaning the same thing for a single-row drop.
    const lead =
      sources[0] || null;

    lastDrop = {
      sourceKey: lead?.key ?? null,
      sourceKeys: sources.map(
        row => row.key
      ),
      count: sources.length,
      targetKey: target?.key ?? null,
      after: !!after,
      outcome: "started",
    };

    if (
      !sources.length ||
      !target
    ) {
      lastDrop.outcome = "no-rows";
      return;
    }

    // Dropping onto one of the dragged rows is a no-op, not an error: it is what
    // happens when the pointer lands on the group itself as it is being moved.
    if (
      sources.some(
        row =>
          row.key ===
          target.key
      )
    ) {
      lastDrop.outcome = "same-row";
      return;
    }

    if (
      sources.some(
        row =>
          row.menuId !==
          target.menuId
      )
    ) {
      lastDrop.outcome = "different-menu";

      status(
        "Items can only be moved within the same menu.",
        "error"
      );

      return;
    }

    const menuId = lead.menuId;

    const sourceScope = rowOrderScopeKey(lead);
    if (
      sources.some(row => rowOrderScopeKey(row) !== sourceScope) ||
      rowOrderScopeKey(target) !== sourceScope
    ) {
      lastDrop.outcome = "different-parent";
      status(
        "Items can only be reordered among siblings inside the same parent menu.",
        "error"
      );
      return;
    }

    // Nested registrations are ordered by a parent-specific selector list.
    // They do not need (and must not receive) top-level menu rules.
    if (sourceScope !== "root") {
      const parentSelector = trim(lead.parentSelector);
      if (!parentSelector) {
        lastDrop.outcome = "missing-parent";
        status("This child entry has no stable parent selector.", "error");
        return;
      }

      lastDrop.nested = true;
      lastDrop.parentSelector = parentSelector;
      lastDrop.hasEntries = false;
      lastDrop.adopted = false;
      lastDrop.moved = moveChildRowGroup(
        menuId,
        parentSelector,
        sources,
        target,
        after
      );
      lastDrop.outcome = lastDrop.moved ? "moved-children" : "no-change";

      state.selectedKey = lead.key;
      state.selectedMenu = menuId;
      state.selectedKeys = new Set(sources.map(row => row.key));
      state.selectionAnchor = lead.key;

      render();
      return;
    }

    lastDrop.hasEntries =
      !!(
        sources.every(
          row =>
            !!row.entry
        ) &&
        !!target.entry
      );

    lastDrop.adopted =
        !!ensureFullControl(
          menuId
        );

    // A row only carries a rule once it has been acted on. After adoption the
    // rule objects are brand new, so every row has to be re-resolved by key or
    // selector before any of them can be moved.
    let group = sources;
    let targetRow = target;

    if (lastDrop.adopted) {
      const freshRows =
        buildRows(
          menuId
        );

      const remap = row =>
        freshRows.find(
          candidate =>
            candidate.key ===
              row.key ||
            candidate.selector ===
              row.selector
        );

      group =
        sources.map(remap);

      targetRow = remap(target);

      if (
        group.some(
          row =>
            !row?.entry
        ) ||
        !targetRow?.entry
      ) {
        lastDrop.outcome =
          "remap-failed";

        status(
          "Could not map the dragged rows after adopting the menu.",
          "error"
        );

        return;
      }
    }

    if (
      group.some(
        row =>
          !row.entry
      ) ||
      !targetRow.entry
    ) {
      lastDrop.outcome =
        "unmanaged-row";

      status(
        group.length > 1
          ? "Some of the selected rows cannot be moved."
          : "That row cannot be moved.",
        "error"
      );

      return;
    }

    lastDrop.moved =
      moveRuleGroup(
        menuId,
        group.map(
          row =>
            row.entry
        ),
        targetRow.entry,
        after
      );

    lastDrop.outcome =
      lastDrop.moved ? "moved" : "no-change";

    // The whole group stays selected after the drop, so it can be nudged again
    // without re-picking it.
    state.selectedKey =
      lead.key;

    state.selectedMenu =
      menuId;

    state.selectedKeys =
      new Set(
        group.map(
          row =>
            row.key
        )
      );

    state.selectionAnchor =
      lead.key;

    render();
  }

  // ===========================================================================
  // ROW ACTION MENU
  // ===========================================================================

  let rowPopup = null;

  function closeRowMenu() {
    rowPopup?.remove();
    rowPopup = null;
  }

  // Opens the row action menu.
//
// `at` is an optional {x, y} viewport point. The "..." button passes nothing and
// gets the menu tucked under itself; a right-click passes the pointer position
// so the menu appears where the user actually clicked, the way every other
// context menu behaves.
// Right-click opens the same action menu as the "..." button, positioned at the
// pointer.
//
// Kept as one helper because the entry row and the separator row build their own
// wrappers and both need it; duplicating the listener meant the two could drift.
//
// The native browser menu is suppressed — this panel lives in the chrome document,
// where an unsuppressed right-click would open Firefox's page menu on top of the
// editor and leave both on screen.
function attachRowContextMenu(
    rowElement,
    row
  ) {
    rowElement.addEventListener(
      "contextmenu",
      event => {
        event.preventDefault();
        event.stopPropagation();

        showRowMenu(
          rowElement,
          row,
          {
            x: event.clientX,
            y: event.clientY,
          }
        );
      }
    );
  }

  function originalElementIdForRow(row) {
    for (const candidate of [
      row?.disc?.id,
      row?.elementId,
      row?.disc?.elementId,
    ]) {
      const value = trim(candidate);
      if (value) return value;
    }

    // Last resort for exact-ID selectors used by a few offline rows. Do not
    // guess from broad selectors, because this action promises the original ID.
    const selector = trim(row?.selector || row?.entry?.selector);
    const exact = /^#((?:\\\\.|[^\\s,:>+~])+)$/.exec(selector);
    if (exact) return exact[1].replace(/\\\\([\\\\.#:[\\]()>+~])/g, "$1");

    return "";
  }

  function copyOriginalElementId(row) {
    const originalId = originalElementIdForRow(row);
    if (!originalId) return false;

    try {
      const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper);
      clipboard.copyString(originalId);
      status(`Copied original ID: ${originalId}`, "ok");
      return true;
    } catch (error) {
      console.error("[menu-editor] could not copy original element ID:", error);
      status(`Could not copy original ID: ${error}`, "error");
      return false;
    }
  }

  function showRowMenu(
    anchor,
    row,
    at = null
  ) {
    closeRowMenu();

    const popup =
      el(
        "div",
        {
          class:
            "cm-row-popup",
        }
      );

    rowPopup = popup;

    function action(
      label,
      fn,
      disabled = false
    ) {
      const item =
        button(
          label,
          "",
          () => {
            closeRowMenu();

            if (!disabled) {
              fn();
            }
          },
          {
            class:
              "popup-action",
          }
        );

      item.disabled =
        disabled;

      popup.appendChild(
        item
      );
    }

    const entry =
      row.entry;

    // The "Take control of this menu" item is gone: control is assumed (see
    // assumeControl()), so every row here already has a rule behind it.

    action(
      "Rename",
      () => {
        const rowNode =
          [
            ...rowContainer()
              .querySelectorAll(
                ".cm-row"
              ),
          ].find(
            node =>
              node._row?.key ===
              row.key
          );

        if (rowNode) {
          startInlineRename(
            rowNode,
            row
          );
        }
      },
      row.kind ===
        "separator"
    );

    const visibilityTargets =
      rowsForVisibilityAction(row);
    const visibilityLabel = row.entry?.hidden
      ? "Show"
      : "Hide";

    action(
      visibilityTargets.length > 1
        ? `${visibilityLabel} ${visibilityTargets.length} selected items`
        : visibilityLabel,
      () => {
        // When the right-clicked row belongs to a multi-selection, apply the
        // command to every selected non-separator row. Right-clicking outside
        // the selection is already converted to a single-row selection by
        // selectRow(), so it remains a one-item operation.
        setHiddenForRows(
          row.menuId,
          visibilityTargets,
          !row.entry?.hidden
        );

        render();
      },
      row.kind ===
        "separator"
    );

    action(
      "Move up",
      () => {
        if (rowOrderScopeKey(row) !== "root") {
          reorderChildRow(row.menuId, row, "Move child up", -1);
        } else if (!entry) {
          ensureFullControl(
            row.menuId
          );

          const fresh =
            buildRows(
              row.menuId
            ).find(
              r =>
                r.key ===
                  row.key ||
                r.selector ===
                  row.selector
            );

          if (fresh?.entry) {
            nudge(
              row.menuId,
              fresh.entry,
              -1
            );
          }
        } else {
          nudge(
            row.menuId,
            entry,
            -1
          );
        }

        render();
      }
    );

    action(
      "Move down",
      () => {
        if (rowOrderScopeKey(row) !== "root") {
          reorderChildRow(row.menuId, row, "Move child down", 1);
        } else if (!entry) {
          ensureFullControl(
            row.menuId
          );

          const fresh =
            buildRows(
              row.menuId
            ).find(
              r =>
                r.key ===
                  row.key ||
                r.selector ===
                  row.selector
            );

          if (fresh?.entry) {
            nudge(
              row.menuId,
              fresh.entry,
              1
            );
          }
        } else {
          nudge(
            row.menuId,
            entry,
            1
          );
        }

        render();
      }
    );

    action(
      "Move to top",
      () => {
        if (rowOrderScopeKey(row) !== "root") {
          reorderChildRow(row.menuId, row, "Move child to top");
        } else if (!entry) {
          ensureFullControl(
            row.menuId
          );

          const fresh =
            buildRows(
              row.menuId
            ).find(
              r =>
                r.key ===
                  row.key ||
                r.selector ===
                  row.selector
            );

          if (fresh?.entry) {
            moveEdge(
              row.menuId,
              fresh.entry,
              false
            );
          }
        } else {
          moveEdge(
            row.menuId,
            entry,
            false
          );
        }

        render();
      }
    );

    action(
      "Move to bottom",
      () => {
        if (rowOrderScopeKey(row) !== "root") {
          reorderChildRow(row.menuId, row, "Move child to bottom");
        } else if (!entry) {
          ensureFullControl(
            row.menuId
          );

          const fresh =
            buildRows(
              row.menuId
            ).find(
              r =>
                r.key ===
                  row.key ||
                r.selector ===
                  row.selector
            );

          if (fresh?.entry) {
            moveEdge(
              row.menuId,
              fresh.entry,
              true
            );
          }
        } else {
          moveEdge(
            row.menuId,
            entry,
            true
          );
        }

        render();
      }
    );

    // Reset clears this entry's custom title, hidden flag, context tags/reference
    // and pin, but keeps it managed — so it stays where it was dragged. Release
    // rule is the heavier option that hands the row back to the browser entirely.
    action(
      "Reset",
      () => {
        const childOrderParent = row.childOrderParentSelector || row.selector;
        if (entry) resetRule(row.menuId, entry, childOrderParent);
        else resetChildOrder(row.menuId, childOrderParent);

        render();
      },
      !ruleIsResettable(
        row.menuId,
        entry,
        row
      )
    );

    action(
      "Copy original ID",
      () => {
        copyOriginalElementId(row);
      },
      !originalElementIdForRow(row)
    );

    action(
      "Release rule",
      () => {
        if (entry) {
          releaseRule(
            row.menuId,
            entry
          );

          clearSelection();


          render();
        }
      },
      !entry
    );

    document.documentElement.appendChild(
      popup
    );

    const rect =
      anchor.getBoundingClientRect();

    const popupRect =
      popup.getBoundingClientRect();

    let x =
      at
        ? at.x
        : rect.right -
            popupRect.width;

    let y =
      at
        ? at.y
        : rect.bottom + 4;

    x = Math.max(
      4,
      Math.min(
        window.innerWidth -
          popupRect.width -
          4,
        x
      )
    );

    y = Math.max(
      4,
      Math.min(
        window.innerHeight -
          popupRect.height -
          4,
        y
      )
    );

    popup.style.left =
      `${x}px`;

    popup.style.top =
      `${y}px`;

    const closeOnPointer =
      event => {
        if (
          popup.contains(
            event.target
          ) ||
          event.target === anchor
        ) {
          return;
        }

        closeRowMenu();

        document.removeEventListener(
          "pointerdown",
          closeOnPointer,
          true
        );
      };

    setTimeout(
      () => {
        document.addEventListener(
          "pointerdown",
          closeOnPointer,
          true
        );
      },
      0
    );
  }

  // ===========================================================================
  // TOOLBAR / FILTER UI
  // ===========================================================================

  function buildMenuPicker() {
    const select =
      el(
        "select",
        {
          class:
            "menu-picker",
          title:
            "Choose a context menu or browser menu",
        }
      );

    const menus =
      availableMenus();

    const primary =
      menus.filter(
        menu =>
          menu.primary
      );

    const others =
      menus.filter(
        menu =>
          !menu.primary && !menu.saved && !menu.application
      );

    const application = menus.filter(menu => !!menu.application);

    const saved =
      menus.filter(
        menu =>
          !!menu.saved
      );

    const add = (
      menu,
      parent
    ) => {
      parent.appendChild(
        el(
          "option",
          {
            value:
              menu.id,
            text:
              state.showIds
                ? menu.id
                : menu.label,
            title:
              state.showIds
                ? menu.label
                : menu.id,
            selected:
              menu.id ===
              state.activeMenu,
          }
        )
      );
    };

    if (primary.length) {
      const group =
        el(
          "optgroup",
          {
            label:
              "Main menus",
          }
        );

      primary.forEach(
        menu =>
          add(
            menu,
            group
          )
      );

      select.appendChild(
        group
      );
    }

    if (others.length) {
      const group =
        el(
          "optgroup",
          {
            label:
              "Other context menus",
          }
        );

      others.forEach(
        menu =>
          add(
            menu,
            group
          )
      );

      select.appendChild(
        group
      );
    }

    if (application.length) {
      const group = el("optgroup", { label: "Other menus" });
      application.forEach(menu => add(menu, group));
      select.appendChild(group);
    }

    if (saved.length) {
      const group = el("optgroup", { label: "Saved menus" });
      saved.forEach(menu => add(menu, group));
      select.appendChild(group);
    }

    select.addEventListener(
      "change",
      event => {
        void selectMenu(
          event.target.value
        );
      }
    );

    return select;
  }

  function buildFilterBar(
    rows
  ) {
    const input =
      el(
        "input",
        {
          class:
            "filter-input",
          type:
            "search",
          placeholder:
            "Filter by title, original title or selector…",
          value:
            state.filter,
          spellcheck:
            "false",
          autocomplete:
            "off",
        }
      );

    input.addEventListener(
      "input",
      event => {
        state.filter =
          event.target.value;

        renderRowsOnly();
      }
    );

    const mode =
      el(
        "select",
        {
          class:
            "filter-mode",
          title:
            "Filter rows",
        },
        [
          el(
            "option",
            {
              value:
                "all",
              text:
                "Default",
            }
          ),

          el(
            "option",
            {
              value:
                "visible",
              text:
                "Visible",
            }
          ),

          el(
            "option",
            {
              value:
                "hidden",
              text:
                "Hidden",
            }
          ),

          el(
            "option",
            {
              value:
                "changed",
              text:
                "Changed",
            }
          ),

          el(
            "option",
            {
              value:
                "unmanaged",
              text:
                "Unmanaged",
            }
          ),

          el(
            "option",
            {
              value:
                "extension",
              text:
                "Extension",
            }
          ),

          el(
            "option",
            {
              value:
                "dormant",
              text:
                "Dormant / not live",
            }
          ),

          el(
            "option",
            {
              value:
                "unverified",
              text:
                "Unverified saved",
            }
          ),
        ]
      );

    mode.value =
      state.filterMode;

    mode.addEventListener(
      "change",
      event => {
        state.filterMode =
          event.target.value;

        renderRowsOnly();
      }
    );

    const count =
      el(
        "span",
        {
          class:
            "filter-count",
          text:
            `${
              rows.filter(
                rowMatchesFilter
              ).length
            }/${rows.length}`,
        }
      );

    return el(
      "div",
      {
        class:
          "filter-bar",
      },
      [
        input,
        mode,
        count,
      ]
    );
  }

  // ===========================================================================
  // FIND MINIBAR  (Ctrl+F)
  //
  // A small search field parked in the panel's top-right corner, summoned and
  // dismissed with the same chord.
  //
  // WHY THIS IS NOT THE FILTER
  //
  // The filter bar above answers "show me only the rows that match", and does it
  // by REMOVING every other row. That is right for narrowing a list you have
  // finished reading, and wrong for the thing people actually reach a context
  // menu editor to do: find the one entry you half-remember while the rest of the
  // menu stays put. Filtering 145 items down to 3 destroys the context being used
  // to recognise the thing in the first place — "was that near Undo, or was it in
  // the tab menu?" — and leaves a list that has to be re-expanded to get out of.
  //
  // So find is non-destructive by construction:
  //
  //   * every row stays in the DOM and on screen, exactly as it was;
  //   * matches get a highlight, the current one a stronger one;
  //   * Enter / Shift+Enter walk the matches, scrolling each into view;
  //   * the counter reports how many matched.
  //
  // It searches the same haystack the filter does (rowSearchText), so what
  // matches here matches there: every alias of a row, plus its selector and its
  // contexts. "visual", "#context-visual-search" and "search select" all find the
  // same entry.
  //
  // The highlight is a class on the already-rendered rows rather than a rebuilt
  // list. Rebuilding per keystroke would fight the user's scroll position and
  // drop the row they were reading.
  // ===========================================================================

  function findBar() {
    // The cached node is authoritative. It survives across renders, so this
    // returns the same element every time rather than a fresh lookup that could
    // briefly be null while the header is being rebuilt.
    if (state.findBarEl) {
      return state.findBarEl;
    }

    return (
      state.panel?.querySelector(
        ".find-bar"
      ) || null
    );
  }

  // Move the persistent find bar into a freshly built list header.
  //
  // renderRowsOnly() clears and recreates the header on every render, so the bar
  // has to be re-attached each time. It is MOVED, never rebuilt: recreating it
  // would throw away the input's focus and caret position, and a re-render
  // happens on things as routine as hiding a row — which would mean typing in
  // the find field silently stopped working halfway through a query.
  //
  // Returns the header so callers can append it in one expression.
  function mountFindBar(
    header
  ) {
    const bar =
      state.findBarEl;

    if (
      bar &&
      header &&
      bar.parentNode !== header
    ) {
      header.appendChild(
        bar
      );
    }

    return header;
  }

  function findInput() {
    return (
      findBar()?.querySelector(
        ".find-input"
      ) || null
    );
  }

  // Every row matching the current query, in list order.
  //
  // Read through getRowsForRender() rather than buildRows(), so the minibar
  // respects the active filter mode and never counts a row the user cannot
  // actually see as a match.
  function findMatchingKeys() {
    const query =
      trim(
        state.findQuery
      ).toLocaleLowerCase();

    if (!query) {
      return [];
    }

    return getRowsForRender()
      .filter(
        row =>
          rowSearchText(
            row
          ).includes(query)
      )
      .map(
        row =>
          row.key
      );
  }

  // Repaint the highlight without touching the list itself.
  //
  // Both classes are written unconditionally every pass (added or removed), so a
  // highlight can never be stranded on a row that stopped matching — which is
  // what would happen if this only ever added them.
  function paintFindHighlight() {
    const container =
      rowContainer();

    if (!container) return;

    const matching =
      new Set(
        state.findKeys
      );

    const current =
      state.findKeys[
        state.findIndex
      ] ??
      null;

    for (const node of container.querySelectorAll(
      ".cm-row"
    )) {
      const key =
        node._row?.key;

      node.classList.toggle(
        "find-match",
        matching.has(key)
      );

      node.classList.toggle(
        "find-current",
        key ===
          current
      );
    }
  }

  function updateFindCount() {
    const count =
      findBar()?.querySelector(
        ".find-count"
      );

    if (!count) return;

    const total =
      state.findKeys.length;

    if (!trim(state.findQuery)) {
      count.textContent =
        "";

      return;
    }

    count.textContent =
      total
        ? `${state.findIndex + 1}/${total}`
        : "none";

    count.classList.toggle(
      "find-none",
      !total
    );
  }

  // Recompute matches, then repaint.
  //
  // The single place that writes findKeys, so the counter and the highlight can
  // never disagree about what matched.
  function refreshFind() {
    state.findKeys =
      findMatchingKeys();

    // Start at the first match on a fresh query, but only clamp when the cursor
    // already had a position. Resetting unconditionally would make Shift+Enter
    // from match 3 impossible — every step back to 2 would first jump to 1.
    state.findIndex =
      state.findKeys.length
        ? state.findIndex < 0
          ? 0
          : Math.min(
              state.findIndex,
              state.findKeys.length - 1
            )
        : -1;

    paintFindHighlight();

    updateFindCount();
  }

  // Move the cursor to a match and bring it into view.
  //
  // Wraps at both ends, like every browser find bar. That matters more here than
  // usual: the match list spans the whole visible list, so the last match is
  // often below the fold and wrapping forward is the only quick way back into
  // view.
  function stepFind(
    direction
  ) {
    const total =
      state.findKeys.length;

    if (!total) return false;

    state.findIndex =
      (state.findIndex + direction + total) %
      total;

    paintFindHighlight();

    updateFindCount();

    const key =
      state.findKeys[
        state.findIndex
      ];

    // Select the match as well as highlighting it, so the user can act on it
    // immediately. Landing on a match should leave that row current, not merely
    // draw a box around it.
    const row =
      buildRows(
        state.activeMenu
      ).find(
        r =>
          r.key ===
          key
      );

    if (row) {
      state.selectedKey =
        row.key;

      state.selectedMenu =
        row.menuId;

      state.selectedKeys =
        new Set([row.key]);

      state.selectionAnchor =
        row.key;

      // renderRowsOnly() rebuilds the rows, which drops the classes
      // paintFindHighlight() just applied, so the repaint has to come after it.
      renderRowsOnly();

      paintFindHighlight();
    }

    const node = [
      ...(
        rowContainer()
          ?.querySelectorAll(
            ".cm-row"
          ) || []
      ),
    ].find(
      item =>
        item._row?.key ===
        key
    );

    // "center" rather than "nearest": a match is reached by stepping to it
    // deliberately, so it should land in view with its name and badges both
    // readable, not flush against an edge with half the row clipped.
    node?.scrollIntoView({
      block: "center",
    });

    return true;
  }

  function openFind() {
    state.findOpen =
      true;

    findBar()?.removeAttribute(
      "hidden"
    );

    const input =
      findInput();

    if (input) {
      input.focus();

      // Select what is already there so typing replaces the old query rather
      // than appending to it, as in every browser find bar.
      input.select();
    }

    // Opening onto a stale query re-evaluates it: the menu underneath may have
    // changed since it was typed.
    refreshFind();
  }

  function closeFind() {
    state.findOpen =
      false;

    // The query is dropped on close, so reopening starts clean. Keeping it would
    // make Ctrl+F after Ctrl+F land the user back inside a search they had
    // already dismissed.
    state.findQuery =
      "";

    state.findKeys =
      [];

    state.findIndex =
      -1;

    findBar()?.setAttribute(
      "hidden",
      ""
    );

    const input =
      findInput();

    if (input) {
      input.value =
        "";
    }

    updateFindCount();

    paintFindHighlight();
  }

  function toggleFind() {
    if (state.findOpen) {
      closeFind();
    } else {
      openFind();
    }
  }

  function buildFindBar() {
    const input =
      el(
        "input",
        {
          class:
            "find-input",

          type:
            "text",

          placeholder:
            "Find…",

          // Not type="search". That draws a native clear button, and its click
          // does not reliably fire "input" across Firefox versions — so the ×
          // would empty the box while leaving every row still lit up.
          value:
            state.findQuery,

          spellcheck:
            "false",

          autocomplete:
            "off",

          "aria-label":
            "Find menu entries",
        }
      );

    input.addEventListener(
      "input",
      event => {
        state.findQuery =
          event.target.value;

        // A new query always restarts at the top: carrying the cursor over from
        // the previous result set would light an unrelated row.
        state.findIndex =
          -1;

        refreshFind();
      }
    );

    input.addEventListener(
      "keydown",
      event => {
        // Escape closes the minibar, not the panel.
        //
        // The panel's own Escape handler deliberately ignores every key pressed
        // inside an input, so without this the key would do nothing at all while
        // the field had focus — which is exactly when it is most likely pressed.
        if (
          event.key ===
          "Escape"
        ) {
          event.preventDefault();

          // stopPropagation as well: the panel-level handler is on window, so
          // without this the same keypress would bubble up and close the panel
          // the minibar was meant to be covering.
          event.stopPropagation();

          closeFind();

          return;
        }

        // Enter / Shift+Enter walk the matches, as in every browser find bar.
        // Both are consumed so Enter does not also trigger a row action.
        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();

          stepFind(
            event.shiftKey
              ? -1
              : 1
          );
        }
      }
    );

    return el(
      "div",
      {
        class:
          "find-bar",

        // Built hidden and revealed by openFind(). An attribute rather than a
        // class, so a stale class from a previous open cannot leave it showing,
        // and so the hidden state needs no CSS override to compete with.
        hidden:
          "",
      },
      [
        input,

        el(
          "span",
          {
            class:
              "find-count",
          }
        ),

        button(
          "↑",
          "Previous match (Shift+Enter)",
          () =>
            stepFind(-1),
          {
            class:
              "find-step",
          }
        ),

        button(
          "↓",
          "Next match (Enter)",
          () =>
            stepFind(1),
          {
            class:
              "find-step",
          }
        ),

        button(
          "✕",
          "Close find (Esc)",
          () =>
            closeFind(),
          {
            class:
              "find-close",
          }
        ),
      ]
    );
  }

  // ===========================================================================
  // PANEL RENDERING
  // ===========================================================================

  function getRowsForRender() {
    const flattened = [];
    const visit = rows => {
      for (const row of rows || []) {
        if (rowMatchesFilter(row)) flattened.push(row);
        visit(row.children);
      }
    };
    visit(buildRows(state.activeMenu));
    return flattened;
  }

  function renderRowsOnly() {
    const container =
      rowContainer();

    if (!container) return;

    container.textContent =
      "";

    const rows =
      buildRows(
        state.activeMenu
      );

    const visibleRows =
      rows.filter(
        rowMatchesFilter
      );

    const header =
      el(
        "div",
        {
          class:
            "cm-grid-header",
        },
        [
          el(
            "span",
            {}
          ),

          el(
            "span",
            {
              text:
                `${rows.length} ${
                  plural(
                    rows.length,
                    "item"
                  )
                }`,
            }
          ),

          // Two spans: an empty grip spacer, and the item count. They occupy the same
          // first two grid tracks as .cm-row, so the header labels line up with
          // the rows beneath it. The deleted "Visible" caption and trailing blank
          // belonged to the removed checkbox and "…" columns.
          //
          // A third child, the find bar, is appended by mountFindBar() and lands
          // in the third track declared in CSS.
        ]
      );

    // The find bar lives in this header row, at its right-hand end — beside the
    // item count rather than up in the titlebar, where it was competing with the
    // panel title for the same edge.
    mountFindBar(
      header
    );

    container.appendChild(
      header
    );

    if (!visibleRows.length) {
      container.appendChild(
        el(
          "div",
          {
            class:
              "empty-state",

            text:
              state.filterMode === "unverified"
                ? "No unverified saved rules. Every saved selector is live, registered, or has been observed in this session."
                : state.filterMode === "dormant"
                  ? "No dormant saved rules. Every previously observed item is currently live."
                  : state.filter || state.filterMode !== "all"
                  ? "Nothing matches the current filter."
                  : "This menu has no discoverable items yet. Open it once in Firefox, then refresh.",
          }
        )
      );
    } else {
      const appendRowTree = (row, depth = 0) => {
        if (!rowMatchesFilter(row)) return;
        const rowNode = renderRow(row);
        if (depth > 0) {
          rowNode.classList.add("cm-row-nested");
          rowNode.style.setProperty(
            "--cm-row-indent",
            `${28 + (depth - 1) * 18}px`
          );
        }
        container.appendChild(rowNode);

        const children = row.children || [];
        if (!row.isGroupParent || !children.length) return;

        const hasMatchingDescendant =
          !!state.filter && children.some(rowMatchesFilter);
        if (isGroupExpanded(row) || hasMatchingDescendant) {
          for (const child of children) {
            if (rowMatchesFilter(child)) appendRowTree(child, depth + 1);
          }
        }
      };

      for (const row of visibleRows) appendRowTree(row, 0);
    }

    // Re-apply the find highlight last.
    //
    // Every row element here is brand new, so any class paintFindHighlight() set
    // before this call is gone. This is the one place every rebuild funnels
    // through, so hooking it here means the highlight survives anything that
    // re-renders the list — a drag, a rename, a hide, a menu switch — instead of
    // needing a manual repaint call at each of those dozen sites.
    paintFindHighlight();

    updateListMetrics(
      rows
    );
  }

  function updateListMetrics(
    rows
  ) {
    const menu =
      menuConfig(
        state.activeMenu,
        true
      );

    const hidden =
      rows.filter(
        row =>
          row.entry?.hidden
      ).length;

    const renamed =
      rows.filter(
        row =>
          entryLabel(
            row.entry
          )
      ).length;

    const managed =
      rows.filter(
        row =>
          row.entry
      ).length;

    // Extension rows, whether live or recovered from the registry. This replaces the
    // old "offline" tally: with the offline badge gone, an "offline" number had
    // nothing on screen to point at, while the extension count does.
    const extension =
      rows.filter(
        row =>
          isExtensionRow(row)
      ).length;

    const registered =
      rows.filter(
        row =>
          row.registryOnly
      ).length;

    const unverified =
      rows.filter(
        row =>
          row.unverified
      ).length;

    const dormant =
      rows.filter(
        row =>
          row.dormant
      ).length;

    const separators =
      rows.filter(
        row =>
          row.kind ===
          "separator"
      ).length;

    const reorderButton =
      document.getElementById(
        `${CONFIG.panelId}-reorder`
      );

    if (reorderButton) {
      reorderButton.textContent =
        menu.reorder
          ? "Custom ✓"
          : "Browser";

      reorderButton.title =
        menu.reorder
          ? "Disable custom ordering for this menu and return to Firefox/browser order"
          : "Enable custom ordering for this menu";

      reorderButton.dataset.active =
        String(
          menu.reorder
        );
    }

    // The "Take control (N)" counter that used to sit here went with the
    // button: control is assumed, so there is no N to count.

    const stats =
      document.getElementById(
        `${CONFIG.panelId}-stats`
      );

    if (!stats) return;

    stats.textContent =
      `${rows.length} ${plural(
        rows.length,
        "item"
      )} · ` +
      `${managed} managed · ` +
      `${hidden} hidden · ` +
      `${renamed} renamed · ` +
      `${separators} separators` +
      (
        registered
          ? ` · ${registered} registered`
          : ""
      ) +
      (
        extension
          ? ` · ${extension} extension`
          : ""
      ) +
      (
        dormant
          ? ` · ${dormant} dormant`
          : ""
      ) +
      (
        unverified
          ? ` · ${unverified} unverified saved`
          : ""
      ) +
      (
        state.dirty
          ? " · unsaved changes"
          : ""
      );
  }

  function render() {
    const panel =
      state.panel;

    if (!panel) return;

    const picker =
      panel.querySelector(
        ".menu-picker"
      );

    if (
      picker &&
      picker.value !==
        state.activeMenu
    ) {
      picker.value =
        state.activeMenu;
    }

    const toolbar =
      panel.querySelector(
        ".toolbar"
      );

    if (toolbar) {
      const current =
        toolbar.querySelector(
          ".menu-picker"
        );

      if (!current) {
        toolbar.prepend(
          buildMenuPicker()
        );
      }
    }

    const rows =
      buildRows(
        state.activeMenu
      );

    const filterBar =
      panel.querySelector(
        ".filter-bar"
      );

    if (filterBar) {
      filterBar.replaceWith(
        buildFilterBar(
          rows
        )
      );
    }

    renderRowsOnly();

    updateSaveButton();

    const undoLabel =
      document.getElementById(
        `${CONFIG.panelId}-undo`
      );

    const redoLabel =
      document.getElementById(
        `${CONFIG.panelId}-redo`
      );

    if (undoLabel) {
      undoLabel.title =
        state.history.length
          ? `Undo ${
              state.history.at(-1).label
            }`
          : "Nothing to undo";
    }

    if (redoLabel) {
      redoLabel.title =
        state.future.length
          ? `Redo ${
              state.future.at(-1).label
            }`
          : "Nothing to redo";
    }
  }

  function queueRender() {
    if (state.renderQueued) {
      return;
    }

    state.renderQueued =
      true;

    Promise.resolve().then(
      () => {
        state.renderQueued =
          false;

        render();
      }
    );
  }

  // ===========================================================================
  // MENU ACTIONS
  // ===========================================================================

  // Rebuilds the active menu the way the browser builds it, then re-reads it.
  //
  // Extension entries only exist inside a menu while it is being opened, so
  // discovery on an untouched menu legitimately finds none. Priming fires the
  // same "popupshowing" the real thing fires and waits for the asynchronous
  // extension insertions, which is what makes those entries show up here.
  async function scanLiveMenu() {
    const menuId =
      state.activeMenu;

    const e =
      engine();

    if (state.scanning) {
      return;
    }

    state.scanning = true;

    status(
      "Scanning…",
      ""
    );

    try {
      if (!e?.prime) {
        // The live XUL popup is the source of truth when no separate menu engine
        // is installed. Firefox builds some menus lazily, so this fallback can
        // inspect the current DOM/extension registry but cannot force a rebuild.
        const snapshot = discover(menuId);
        const liveCount = (snapshot.rows || []).filter(row => row?.el).length;
        const registryCount = (snapshot.registry || []).length;
        clearSelection();
        render();

        status(
          liveCount || registryCount
            ? `Scanned ${liveCount} live items` +
              (registryCount ? `, ${registryCount} registered by extensions` : "") +
              "."
            : "No live items found. Open this context menu once, then scan again.",
          liveCount || registryCount ? "ok" : ""
        );
        return;
      }

      const result =
        await e.prime(
          menuId
        );

      if (!result.primed) {
        status(
          `Cannot scan: ${result.reason}.`,
          "error"
        );

        return;
      }

      clearSelection();


      render();

      // prime() tore the menu down, so the rows it captured are handed to
      // discovery explicitly. Without them the DOM read comes back empty and
      // the scan reports nothing even though the items were just built.
      const snapshot =
        discover(
          menuId,
          result.rows
        );

      const registry =
        snapshot?.registry?.length ||
        0;

      status(
        result.unchanged &&
        !registry
          ? "Menu is not built until you open it. Open it once, then scan again."
          : `Scanned ${
              snapshot?.total || 0
            } live items` +
            (
              registry
                ? `, ${registry} registered by extensions`
                : ""
            ) +
            ".",

        result.unchanged &&
        !registry
          ? ""
          : "ok"
      );
    } catch (error) {
      console.error(
        "[menu-editor] scan failed:",
        error
      );

      status(
        `Scan failed: ${error}`,
        "error"
      );
    } finally {
      state.scanning = false;
    }
  }

  function toggleReorder() {
    const menu =
      menuConfig(
        state.activeMenu,
        true
      );

    if (menu.reorder) {
      disableReorder(
        state.activeMenu
      );

      status(
        "Custom ordering disabled. Firefox/browser order will be used after Save.",
        "ok"
      );
    } else {
      enableReorder(
        state.activeMenu
      );

      status(
        "Custom ordering enabled.",
        "ok"
      );
    }

    render();
  }

  async function promptReset() {
    const name =
      availableMenus()
        .find(
          menu =>
            menu.id ===
            state.activeMenu
        )?.label ||
      state.activeMenu;

    if (
      !(await confirmInPanel(
        "This removes custom order, titles and visibility rules for this menu.",
        {
          title: `Reset "${name}"?`,
          confirmLabel: "Reset menu",
          cancelLabel: "Cancel",
          danger: true,
        }
      ))
    ) {
      return;
    }

    resetLayout(
      state.activeMenu
    );

    clearSelection();


    render();

    status(
      "Menu reset. Save to apply.",
      "ok"
    );
  }

  // adoptCurrentOrder() — the "Take control" confirmation dialog — is gone.
  // Control is assumed (assumeControl()), so there is nothing left to confirm:
  // the browser order is adopted the moment the menu is shown, with no dialog
  // and no undo entry.

  async function save() {
    if (state.saveInProgress) {
      return;
    }

    state.saveInProgress = true;

    updateSaveButton();

    status(
      "Saving…"
    );

    try {
      const path =
        await writeConfig(
          state.config
        );

      // Apply here too: a change that only affects hidden rules (or an undo back
      // to "nothing hidden") has to be able to clear an already-armed rule.
      applyHiddenStyles();

      const activeEngine =
        engine();

      try {
        await activeEngine?.reload?.();
      } catch (error) {
        console.warn(
          "[menu-editor] config saved, engine reload failed:",
          error
        );
      }

      state.dirty = false;
      state.history.length = 0;
      state.future.length = 0;

      updateSaveButton();
      render();

      // Do not claim an engine reload that could not have happened. When there is
      // no __menuEngine, the live XUL visibility executor above is what applies
      // the hidden rules.
      status(
        activeEngine
          ? `Saved ${
              path.split(/[\\/]/).pop()
            } and reloaded the menu engine.`
          : `Saved ${
              path.split(/[\\/]/).pop()
            }. Hidden rules applied (no menu engine present).`,
        "ok"
      );
    } catch (error) {
      console.error(
        "[menu-editor] save failed:",
        error
      );

      status(
        `Save failed: ${error}`,
        "error"
      );
    } finally {
      state.saveInProgress =
        false;

      updateSaveButton();
    }
  }

  async function reloadFromDisk() {
    if (
      state.dirty &&
      !(await confirmInPanel(
        "Discard unsaved changes and reload from disk?",
        {
          title: "Reload configuration?",
          confirmLabel: "Discard & reload",
          cancelLabel: "Keep editing",
          danger: true,
        }
      ))
    ) {
      return false;
    }

    try {
      state.config =
        await readConfig();

      state.dirty =
        false;

      state.history.length =
        0;

      state.future.length =
        0;

      clearSelection();


      applyHiddenStyles();

      render();

      status(
        "Configuration reloaded from disk.",
        "ok"
      );
      return true;
    } catch (error) {
      console.error(
        "[menu-editor] reload failed:",
        error
      );

      status(
        `Reload failed: ${error}`,
        "error"
      );
      return false;
    }
  }

  // ===========================================================================
  // SANITY CHECK — HIDDEN / RENAMED / MOVED
  // ===========================================================================
  //
  // The config file itself records only the end state: an entry is either hidden
  // or it is not, it carries whatever label it was given, and its position in the
  // entries array IS its position. Nothing in the file says "this used to be
  // called something else" or "this used to sit third".
  //
  // That makes the JSON very hard to review by eye. This pass reconstructs the
  // three categories a reviewer actually asks about and reports each one with its
  // ORIGINAL identity, so a diff can be read without cross-referencing the live
  // menu by hand:
  //
  //   hidden   — original id            + hidden
  //   renamed  — original id            + the new name it was given
  //   moved    — original position      + the position it now sits at
  //
  // "Original position" is the index Firefox itself puts the item at, read from
  // the live menu. When a menu cannot be inspected (its node has not been built
  // yet, or the browser reports no row for it) the position is null and the entry
  // is reported as moved-unknown rather than being silently dropped: an
  // unverifiable claim is worse than an incomplete one.

  // The id a config entry addresses, without the leading "#".
  //
  // Separators are addressed positionally ("sep:3"), so their "id" is that
  // ordinal — there is no element id to report and inventing one would be a lie.
  function entryId(entry) {
    const selector = trim(entry?.selector);

    if (isSeparatorSelector(selector)) {
      return selector;
    }

    return selector.replace(/^#/, "");
  }

  // Position lookup: selector -> the index the live menu gives it.
  //
  // Built from a single buildRows() pass per menu, because that already pairs
  // each discovered row with the rule entry it satisfies. Going back to
  // discover() separately would risk pairing an entry with the wrong row.
  function livePositionsFor(menuId) {
    const positions = new Map();

    for (const row of buildRows(menuId)) {
      const selector = trim(row.entry?.selector);

      if (!selector) continue;
      if (positions.has(selector)) continue;

      const index = Number(row.disc?.index);

      // A rule with no live node has no browser position. Recorded as absent
      // rather than as 0, which would read as "first item".
      if (Number.isFinite(index)) {
        positions.set(selector, index);
      }
    }

    return positions;
  }

  // The name an entry had before the editor renamed it.
  //
  // originalLabel is the persisted truth for an entry that was renamed through
  // this editor. For an entry that predates it, the live menu's own title is the
  // best available answer.
  function entryPreviousLabel(entry, menuId) {
    const stored = entryOriginalLabel(entry);

    if (stored) return stored;

    const row = buildRows(menuId).find(
      candidate => candidate.entry === entry
    );

    return trim(rowDefaultLabel(row)) || "";
  }

  function auditMenu(menuId, menu) {
    const hidden = [];
    const renamed = [];
    const moved = [];

    const entries = Array.isArray(menu?.entries)
      ? menu.entries
      : [];

    const positions = livePositionsFor(menuId);

    entries.forEach((entry, index) => {
      if (!entry?.selector) return;

      const id = entryId(entry);

      if (entry.hidden) {
        hidden.push({
          menu: menuId,
          id,
          selector: entry.selector,
          hidden: true,
        });
      }

      const current = entryLabel(entry);

      // Only a REAL rename counts. entry.label equal to the original title is a
      // no-op rename that left no trace, and listing it would pad the report.
      if (current) {
        const original = entryPreviousLabel(entry, menuId);

        if (!original || original !== current) {
          renamed.push({
            menu: menuId,
            id,
            selector: entry.selector,
            from: original || null,
            to: current,
          });
        }
      }

      const originalPosition = positions.get(
        trim(entry.selector)
      );

      // "Moved" means the position the user chose is not the one Firefox had.
      // An entry already sitting where the browser puts it is not a move.
      if (
        originalPosition !== undefined &&
        originalPosition !== index
      ) {
        moved.push({
          menu: menuId,
          id,
          selector: entry.selector,
          from: originalPosition,
          to: index,
        });
      } else if (originalPosition === undefined) {
        moved.push({
          menu: menuId,
          id,
          selector: entry.selector,
          from: null,
          to: index,
          unknown: true,
        });
      }
    });

    return { hidden, renamed, moved };
  }

  function auditConfig(config) {
    const source =
      config && typeof config === "object"
        ? config
        : makeEmptyConfig();

    const result = {
      hidden: [],
      renamed: [],
      moved: [],
    };

    for (const [menuId, menu] of Object.entries(
      source.menus || {}
    )) {
      const report = auditMenu(menuId, menu);

      result.hidden.push(...report.hidden);
      result.renamed.push(...report.renamed);
      result.moved.push(...report.moved);
    }

    result.counts = {
      hidden: result.hidden.length,
      renamed: result.renamed.length,
      moved: result.moved.length,
    };

    return result;
  }

  // The three lists, spelled out for a human.
  //
  // This is what "sanity check our json" means in practice: one glance has to
  // answer "what did I hide, what did I rename, and what did I move".
  function formatAudit(audit) {
    const lines = [];

    lines.push("");
    lines.push(
      `SANITY CHECK — ${audit.counts.hidden} hidden, ` +
      `${audit.counts.renamed} renamed, ` +
      `${audit.counts.moved} moved`
    );
    lines.push("");

    lines.push(
      `HIDDEN (${audit.hidden.length}) — original id → hidden`
    );

    if (!audit.hidden.length) {
      lines.push("  (none)");
    } else {
      for (const item of audit.hidden) {
        lines.push(`  ${item.id} → hidden`);
      }
    }

    lines.push("");
    lines.push(
      `RENAMED (${audit.renamed.length}) — original id → new name`
    );

    if (!audit.renamed.length) {
      lines.push("  (none)");
    } else {
      for (const item of audit.renamed) {
        lines.push(
          `  ${item.id} → ${item.to}` +
          (item.from ? `  (was "${item.from}")` : "")
        );
      }
    }

    lines.push("");
    lines.push(
      `MOVED (${audit.moved.length}) — original position → new position`
    );

    if (!audit.moved.length) {
      lines.push("  (none)");
    } else {
      for (const item of audit.moved) {
        lines.push(
          item.from === null
            ? `  ${item.id} → position ${item.to + 1} (original position unknown — menu not built yet)`
            : `  ${item.id} → ${item.from + 1} → ${item.to + 1}`
        );
      }
    }

    lines.push("");

    return lines.join("\n");
  }

  function printAudit(audit) {
    console.info(
      `[menu-editor] sanity check\n${formatAudit(audit)}`
    );
  }

  // A compact "3 hidden, 2 renamed, 5 moved" summary for the status bar.
  function auditSummary(audit) {
    return (
      `${audit.counts.hidden} hidden, ` +
      `${audit.counts.renamed} renamed, ` +
      `${audit.counts.moved} moved`
    );
  }

  // ===========================================================================
  // IMPORT / EXPORT
  // ===========================================================================

  async function exportPath() {
    return joinProfilePath(await profilePath(), CONFIG.exportPath);
  }

  async function exportConfig() {
    try {
      // Read from disk rather than from state.config: the file is the source of
      // truth, so an export taken mid-edit hands back the saved state instead of
      // a half-finished session that was never applied to the real menu.
      const config =
        await readConfig();

      const audit =
        auditConfig(config);

      const path =
        await exportPath();

      const bundle = {
        format: CONFIG.exportFormat,
        exportedAt: new Date().toISOString(),
        config: deepClone(config),
        audit,
      };

      await writeUtf8Atomically(
        path,
        JSON.stringify(bundle, null, 2) + "\n"
      );

      printAudit(audit);

      status(
        `Exported to ${path.split(/[\\/]/).pop()} — ` +
        auditSummary(audit),
        "ok"
      );
    } catch (error) {
      console.error(
        "[menu-editor] export failed:",
        error
      );

      status(
        `Export failed: ${error}`,
        "error"
      );
    }
  }

  // Accepts either a full export bundle or a bare menu-config.json, so a user
  // who copies just the "config" object out of one of our exports by hand is not
  // punished for it.
  function configFromBundle(parsed) {
    if (!parsed || typeof parsed !== "object") {
      throw new Error("File is not JSON");
    }

    const candidate =
      parsed.format === CONFIG.exportFormat &&
      parsed.config
        ? parsed.config
        : parsed;

    if (
      !candidate.menus ||
      typeof candidate.menus !== "object"
    ) {
      throw new Error(
        'No "menus" object — this is not a Context Menu Editor config'
      );
    }

    return normalizeConfig(candidate);
  }

  async function promptImport() {
    const input =
      window.prompt(
        "Paste the full path to a config file to import.\n\n" +
        `A bare menu-config.json or a ${CONFIG.exportPath} export both work.`,
        await exportPath()
      );

    if (input === null) {
      return;
    }

    const raw = trim(input);

    if (!raw) {
      return;
    }

    // Normalize only on Windows. Blindly replacing slashes corrupts absolute
    // POSIX paths, but Gecko's PathUtils/IOUtils expect native separators on
    // Windows even when the user pasted a C:/... path.
    const path = normalizeHostPath(raw);

    if (
      state.dirty &&
      !(await confirmInPanel(
        "Importing replaces every unsaved change in the editor.\n\nContinue?",
        {
          title: "Replace unsaved changes?",
          confirmLabel: "Import configuration",
          cancelLabel: "Cancel",
          danger: true,
        }
      ))
    ) {
      return;
    }

    try {
      if (!(await IOUtils.exists(path))) {
        throw new Error("File not found");
      }

      state.config =
        configFromBundle(
          JSON.parse(await readBoundedConfigText(path))
        );

      state.dirty = true;
      state.history.length = 0;
      state.future.length = 0;
      clearSelection();

      // The imported config can hide or reveal what the live menu is currently
      // showing, so the executors have to run before the rows are painted —
      // otherwise the panel and the real menu disagree on screen.
      applyHiddenStyles();
      render();

      const audit =
        auditConfig(state.config);

      printAudit(audit);

      status(
        `Imported ${path.split(/[\\/]/).pop()} — ` +
        auditSummary(audit) +
        ". Save to apply.",
        "ok"
      );
    } catch (error) {
      console.error(
        "[menu-editor] import failed:",
        error
      );

      status(
        `Import failed: ${error}`,
        "error"
      );
    }
  }

  function makePanelDraggable(
    panel
  ) {
    // The whole red-marked header zone is a drag surface: title and the menu
    // picker strip below it. Interactive controls remain interactive because
    // their pointer events are excluded before a drag can start.
    const surfaces = [
      ...panel.querySelectorAll(
        ".titlebar, .toolbar"
      ),
    ];

    if (!surfaces.length) return;

    let dragging = false;
    let activeSurface = null;
    let activePointerId = null;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;

    function isInteractiveTarget(target) {
      return !!target?.closest?.(
        "button, input, select, textarea, a, [contenteditable='true']"
      );
    }

    function start(event) {
      if (event.button !== 0 || isInteractiveTarget(event.target)) {
        return;
      }

      const surface = event.currentTarget;
      const rect = panel.getBoundingClientRect();

      dragging = true;
      activeSurface = surface;
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      baseX = rect.left;
      baseY = rect.top;

      try {
        surface.setPointerCapture(event.pointerId);
      } catch (_) {
        // Pointer capture is best-effort.
      }

      panel.classList.add("moving");
      event.preventDefault();
    }

    function move(event) {
      if (!dragging || event.pointerId !== activePointerId) return;

      const rect = panel.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      const x = Math.max(
        4,
        Math.min(
          window.innerWidth - Math.min(width, 80),
          baseX + event.clientX - startX
        )
      );

      const y = Math.max(
        4,
        Math.min(
          window.innerHeight - Math.min(height, 50),
          baseY + event.clientY - startY
        )
      );

      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = "auto";
    }

    function stop(event) {
      if (!dragging || event.pointerId !== activePointerId) return;

      dragging = false;
      panel.classList.remove("moving");

      try {
        activeSurface?.releasePointerCapture(event.pointerId);
      } catch (_) {
        // Pointer capture may already have been released by the browser.
      }

      activeSurface = null;
      activePointerId = null;
    }

    function resetPosition(event) {
      if (isInteractiveTarget(event.target)) return;

      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
    }

    for (const surface of surfaces) {
      surface.addEventListener("pointerdown", start);
      surface.addEventListener("pointermove", move);
      surface.addEventListener("pointerup", stop);
      surface.addEventListener("pointercancel", stop);
      surface.addEventListener("dblclick", resetPosition);
    }
  }

  // ===========================================================================
  // PANEL RESIZING
  //
  // The panel is anchored top-right, so the grip sits in the bottom-left
  // corner: dragging it left and down grows the panel, which matches how every
  // other anchored window behaves.
  // ===========================================================================

  const RESIZE_STORAGE_KEY =
    "context-menu-editor:panel-size";

  // ===========================================================================
  // COMPACT MODE
  // ===========================================================================
  //
  // Compact is the only layout. Reordering a long menu is a drag-heavy job, and
  // the default row is 37px tall with the name, the selector and the badges
  // stacked on three lines. On a 1440p screen that is roughly 28 entries; the
  // menu actually has well over a hundred. Scrolling while dragging is the
  // single most annoying part of moving things around, so the list is always
  // drawn compact: one line per row, tighter padding, smaller type.
  //
  // It is a pure VIEW behaviour — never written into menu-config.json, so it
  // cannot leak into a backup or a share.

  // The class lives on the PANEL (not <body>) so the stylesheet can scope every
  // compact rule to this window's own markup and cannot reach anything else in
  // the chrome document.
  function applyCompact() {
    const panel = state.panel;

    if (panel) {
      panel.classList.add("compact");
    }
  }

  function toggleCompact() {
    // Retained for API compatibility, but compact can no longer be turned off.
    state.compact = true;
    applyCompact();
  }

  const RESIZE_MIN_WIDTH = 420;

  // Tall enough that the list still shows several rows once the titlebar, toolbar,
  // management bar, filter bar, footer and the panel's own padding have taken
  // their share.
  //
  // This was 260px, which was a lie: the chrome above and below the list sums to
  // roughly 190px, so 260 left about 70px of list — and because .rows also
  // carried its own min-height (now removed), the overflow went to the footer
  // instead, clipping the Save button out of sight. The minimum is only
  // meaningful if the panel can actually honour it, so it is set against the real
  // chrome rather than a round number.
  const RESIZE_MIN_HEIGHT = 320;

  function readStoredPanelSize() {
    try {
      const raw =
        globalThis.localStorage?.getItem(
          RESIZE_STORAGE_KEY
        );

      if (!raw) return null;

      const parsed =
        JSON.parse(raw);

      const width =
        Number(parsed?.width);
      const height =
        Number(parsed?.height);

      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        return null;
      }

      return {
        width,
        height,
      };
    } catch (_) {
      return null;
    }
  }

  function storePanelSize(
    width,
    height
  ) {
    try {
      globalThis.localStorage?.setItem(
        RESIZE_STORAGE_KEY,
        JSON.stringify({
          width: Math.round(width),
          height: Math.round(height),
        })
      );
    } catch (_) {
      // Storage can be unavailable or full; resizing still works without it.
    }
  }

  // Clamp against the viewport so a panel resized on a large monitor cannot be
  // dragged to a size it can never be restored to.
  function clampPanelSize(
    width,
    height
  ) {
    const vw =
      globalThis.innerWidth ||
      CONFIG.maxMenuWidth * 3;
    const vh =
      globalThis.innerHeight ||
      800;

    return {
      width: Math.round(
        Math.min(
          Math.max(width, RESIZE_MIN_WIDTH),
          Math.max(RESIZE_MIN_WIDTH, vw - 32)
        )
      ),
      height: Math.round(
        Math.min(
          Math.max(height, RESIZE_MIN_HEIGHT),
          Math.max(RESIZE_MIN_HEIGHT, vh - 32)
        )
      ),
    };
  }

  function applyPanelSize(
    panel,
    width,
    height
  ) {
    const clamped =
      clampPanelSize(
        width,
        height
      );

    // Inline styles win over the stylesheet's width/max-height, which is what
    // makes the panel actually keep the size.
    panel.style.width =
      `${clamped.width}px`;
    panel.style.height =
      `${clamped.height}px`;
    panel.style.maxHeight =
      `${clamped.height}px`;

    return clamped;
  }

  // Every edge and corner is a resize handle.  The panel is normally anchored
  // top-right, but its right/top offsets are adjusted for those two edges so a
  // drag still keeps the opposite edge visually fixed.
  //
  // Every zone shares one drag engine and differs only in WHICH axes it drives,
  // so dragging an edge never accidentally changes the other dimension.
  function makePanelResizable(
    panel
  ) {
    const stored =
      readStoredPanelSize();

    if (stored) {
      applyPanelSize(
        panel,
        stored.width,
        stored.height
      );
    }

    let resizing = null;

    // Anchored right and top, so moving left grows the width and moving down
    // grows the height.
    function beginResize(
      event,
      node,
      axes
    ) {
      const rect =
        panel.getBoundingClientRect();

      resizing = {
        node,
        axes,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        startRight: (globalThis.innerWidth || 0) - rect.right,
        startTop: rect.top,
      };

      panel.classList.add(
        "resizing"
      );

      try {
        node.setPointerCapture(
          event.pointerId
        );
      } catch (_) {
        // Capture is an optimisation; the drag works without it.
      }
    }

    function moveResize(
      event
    ) {
      if (
        !resizing ||
        resizing.node !==
          event.currentTarget
      ) {
        return;
      }

      const {
        axes,
        startX,
        startY,
        startWidth,
        startHeight,
        startRight,
        startTop,
      } = resizing;

      const size = applyPanelSize(
        panel,
        axes.x
          ? startWidth +
              axes.x * (event.clientX - startX)
          : startWidth,
        axes.y
          ? startHeight +
              axes.y * (event.clientY - startY)
          : startHeight
      );

      // +x means the right edge was dragged; -y means the top edge was
      // dragged.  Move the corresponding anchored offset by the amount the
      // clamped size actually changed, not by the raw pointer distance.
      if (axes.x === 1) {
        panel.style.right = `${startRight - (size.width - startWidth)}px`;
      }

      if (axes.y === -1) {
        panel.style.top = `${startTop + (startHeight - size.height)}px`;
      }
    }

    function endResize(
      event
    ) {
      if (
        !resizing ||
        resizing.node !==
          event.currentTarget
      ) {
        return;
      }

      resizing = null;

      panel.classList.remove(
        "resizing"
      );

      try {
        event.currentTarget.releasePointerCapture(
          event.pointerId
        );
      } catch (_) {
        // Already released.
      }

      const rect =
        panel.getBoundingClientRect();

      storePanelSize(
        rect.width,
        rect.height
      );
    }

    // Wires one zone. The press itself is stopped here rather than inside
    // beginResize, so every zone reads the same way.
    function attachZone(
      node,
      axes
    ) {
      node.addEventListener(
        "pointerdown",
        event => {
          if (event.button !== 0) {
            return;
          }

          // Do not let the press fall through to the row drag handlers
          // underneath it.
          event.preventDefault();
          event.stopPropagation();

          beginResize(
            event,
            node,
            axes
          );
        }
      );

      node.addEventListener(
        "pointermove",
        moveResize
      );

      node.addEventListener(
        "pointerup",
        endResize
      );

      node.addEventListener(
        "pointercancel",
        endResize
      );

      panel.appendChild(node);
    }

    // The corner, kept at its original 18px and given the highest z-index so it
    // wins where it overlaps the two edge strips.
    const grip =
      el(
        "div",
        {
          class:
            "resize-grip",
          title:
            "Drag to resize the panel (or use its left and bottom edges)",
        }
      );

    grip.addEventListener(
      "pointerdown",
      event => {
        if (event.button !== 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        beginResize(
          event,
          grip,
          { x: -1, y: 1 }
        );
      }
    );

    grip.addEventListener(
      "pointermove",
      moveResize
    );

    grip.addEventListener(
      "pointerup",
      endResize
    );

    grip.addEventListener(
      "pointercancel",
      endResize
    );

    panel.appendChild(grip);

    function attachCorner(className, axes, title) {
      const corner = el("div", {
        class: `resize-grip ${className}`,
        title,
      });

      corner.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        beginResize(event, corner, axes);
      });
      corner.addEventListener("pointermove", moveResize);
      corner.addEventListener("pointerup", endResize);
      corner.addEventListener("pointercancel", endResize);
      panel.appendChild(corner);
    }

    attachCorner("resize-grip-top-left", { x: -1, y: -1 }, "Drag to resize");
    attachCorner("resize-grip-top-right", { x: 1, y: -1 }, "Drag to resize");
    attachCorner("resize-grip-bottom-right", { x: 1, y: 1 }, "Drag to resize");

    attachZone(
      el(
        "div",
        {
          class:
            "resize-edge resize-edge-left",
          title:
            "Drag to resize the width",
        }
      ),
      { x: -1, y: 0 }
    );

    attachZone(
      el(
        "div",
        {
          class:
            "resize-edge resize-edge-bottom",
          title:
            "Drag to resize the height",
        }
      ),
      { x: 0, y: 1 }
    );

    attachZone(
      el("div", {
        class: "resize-edge resize-edge-right",
        title: "Drag to resize the width",
      }),
      { x: 1, y: 0 }
    );

    attachZone(
      el("div", {
        class: "resize-edge resize-edge-top",
        title: "Drag to resize the height",
      }),
      { x: 0, y: -1 }
    );

    // Escape abandons an in-progress resize rather than freezing a half-dragged
    // size.
    grip.addEventListener(
      "keydown",
      event => {
        if (event.key !== "Escape") {
          return;
        }

        event.stopPropagation();

        const rect =
          panel.getBoundingClientRect();

        if (
          stored &&
          Math.abs(rect.width - stored.width) < 1 &&
          Math.abs(rect.height - stored.height) < 1
        ) {
          return;
        }

        applyPanelSize(
          panel,
          stored?.width ??
            rect.width,
          stored?.height ??
            rect.height
        );

        storePanelSize(
          panel.getBoundingClientRect()
            .width,
          panel.getBoundingClientRect()
            .height
        );
      }
    );
  }

  // ===========================================================================
  // PANEL BUILD
  // ===========================================================================

  function buildPanel() {
    closeConfirmDialog(false);
    document
      .getElementById(
        CONFIG.panelId
      )
      ?.remove();

    const panel =
      el(
        "div",
        {
          id:
            CONFIG.panelId,
        }
      );

    const titlebar =
      el(
        "div",
        {
          class:
            "titlebar",
        },
        [
          el(
            "div",
            {
              class:
                "title-group",
            },
            [
              el(
                "span",
                {
                  class:
                    "title",
                  text:
                    "Context Menu Studio",
                }
              ),
            ]
          ),

          // The find minibar is NOT here. It lives in the list header, at the right-hand
          // end of the "N items" row, which is where the eye already goes when
          // scanning for something in a long list. Building it here put it on the
          // same edge as the title, where the two fought for room.
          //
          // It is created once and cached in state.findBarEl, then re-attached to
          // each rebuilt header by mountFindBar().
          button(
            "✕",
            "Close panel",
            () =>
              togglePanel(
                false
              ),
            {
              class:
                "close-button",
            }
          ),
        ]
      );

    const toolbar =
      el(
        "div",
        {
          class:
            "toolbar",
        },
        [
          buildMenuPicker(),
        ]
      );

    const management =
      el(
        "div",
        {
          class:
            "management-bar",
        },
        [
          // The "Take control" button that used to lead this bar is gone:
          // control is assumed the moment the panel shows a menu.

          button(
            "Reset menu",
            "Remove every custom rule from the current menu",
            () =>
              void promptReset()
          ),

          button(
            "Import…",
            "Load a menu-config.json or an exported backup into the editor",
            () =>
              void promptImport()
          ),

          button(
            "Export…",
            "Write the saved configuration plus the hidden/renamed/moved report to disk",
            () =>
              void exportConfig()
          ),

          // The stats span closes out the toolbar; compact needs no button here
          // because it is always on.
          el(
            "span",
            {
              class:
                "stats",
              id:
                `${CONFIG.panelId}-stats`,
            }
          ),
        ]
      );

    const rows =
      el(
        "div",
        {
          class:
            "rows",
          id:
            `${CONFIG.panelId}-rows`,
        }
      );

    // The wheel keeps working during a pointer drag. It did not during a NATIVE
    // drag: the browser seized the pointer and delivered no wheel events at all,
    // which is why this list used to scroll by hand. Pointer events leave the
    // wheel alone, so the default behaviour is correct here and forcing it would
    // only risk scrolling twice.
    rows.addEventListener(
      "wheel",
      event => {
        if (!draggedRow) {
          return;
        }

        // Keep the insertion marker honest after the list scrolls underneath a
        // stationary cursor.
        if (dragPointer) {
          updateDropIndicator(
            dragPointer.x,
            dragPointer.y
          );
        }
      },
      {
        passive: true,
      }
    );

    // Dragging over the gaps between rows, the header, or past the last row must
    // not read as "this row cannot be dropped here". Accepting the drag keeps
    // the drop cursor honest and keeps feeding auto-scroll a position.
    rows.addEventListener(
      "pointermove",
      event => {
        if (!draggedRow) {
          return;
        }

        dragPointer = {
          x: event.clientX,
          y: event.clientY,
        };

        updateDropIndicator(
          event.clientX,
          event.clientY
        );
      },
      {
        passive: true,
      }
    );

    const filterBar =
      buildFilterBar(
        buildRows(
          state.activeMenu
        )
      );

    const footer =
      el(
        "div",
        {
          class:
            "footer",
        },
        [
          el(
            "span",
            {
              class:
                "status",
              id:
                `${CONFIG.panelId}-status`,
            }
          ),

          el(
            "span",
            {
              class:
                "spacer",
            }
          ),

          button(
            "Cancel",
            "Discard changes made since the last disk load",
            async () => {
              if (await reloadFromDisk()) {
                togglePanel(
                  false
                );
              }
            }
          ),

          button(
            "Save",
            "Write menu-config.json and reload the engine",
            () =>
              void save(),
            {
              id:
                `${CONFIG.panelId}-save`,
              class:
                "save-button",
            }
          ),
        ]
      );

    panel.append(
      titlebar,
      toolbar,
      management,
      filterBar,
      rows,
      footer
    );

    // Built once, here, and kept on state. renderRowsOnly() attaches it to each
    // new list header via mountFindBar(); building it inside the render loop
    // instead would throw away the input's focus and caret on every re-render,
    // which happens on ordinary actions like hiding a row.
    state.findBarEl =
      buildFindBar();

    document.documentElement.appendChild(
      panel
    );

    state.panel =
      panel;

    makePanelDraggable(
      panel
    );

    makePanelResizable(
      panel
    );

    updateSaveButton();

    // Compact is always on, so the class is applied to the freshly built panel
    // every time — the panel has to be in state.panel already for applyCompact()
    // to reach it.
    applyCompact();

    return panel;
  }

  // ===========================================================================
  // PANEL VISIBILITY
  // ===========================================================================

  async function togglePanel(
    force = undefined
  ) {
    if (!state.config) {
      try {
        state.config =
          await readConfig();
      } catch (error) {
        console.error(
          "[menu-editor] config load failed:",
          error
        );

        const existing =
          document.getElementById(
            CONFIG.panelId
          );

        if (existing) {
          const message =
            existing.querySelector(
              ".status"
            );

          if (message) {
            message.textContent =
              `Cannot read config: ${error}`;

            message.className =
              "status error";
          }
        }

        return;
      }
    }

    const panel =
      state.panel ||
      buildPanel();

    const open =
      panel.hasAttribute(
        "open"
      );

    const show =
      force === undefined
        ? !open
        : !!force;

    if (show) {
      if (!open) {
        clearSelection();

      }

      // Opening the panel means we are in control of the menu it shows.
      assumeControl(state.activeMenu);

      render();

      panel.setAttribute(
        "open",
        ""
      );
    } else {
      closeCustomReferenceDialog();
      closeConfirmDialog(false);

      panel.removeAttribute(
        "open"
      );

      closeRowMenu();

      // Dismiss the find minibar along with the panel.
      //
      // Not strictly required — opening the panel again rebuilds nothing, so a
      // bar left open would reappear — but focus would still be sitting in the
      // hidden field, which is what actually breaks: the next keystroke would go
      // to an input the user cannot see and the first Tab would start from
      // inside it.
      if (
        state.findOpen
      ) {
        closeFind();
      }
    }
  }

  // ===========================================================================
  // KEYBOARD
  // ===========================================================================

  function shortcutMatches(
    event
  ) {
    const shortcut =
      CONFIG.shortcuts.toggle;

    const primary =
      event.code ===
        shortcut.key &&
      event.ctrlKey ===
        shortcut.ctrl &&
      event.shiftKey ===
        shortcut.shift &&
      event.altKey ===
        shortcut.alt &&
      event.metaKey ===
        shortcut.meta;

    const legacyShiftW =
      event.code ===
        "KeyW" &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey;

    return (
      primary ||
      legacyShiftW
    );
  }

  // Ctrl+W / Cmd+W closes the panel.
  //
  // Unlike every other shortcut here this one is NOT a toggle: it only ever
  // closes. Opening the panel with a "close" chord would be nonsense, and the
  // panel is normally opened with Ctrl+Shift+E anyway.
  function closeShortcutMatches(
    event
  ) {
    const shortcut =
      CONFIG.shortcuts.close;

    if (
      event.code !==
      shortcut.key
    ) {
      return false;
    }

    if (
      event.shiftKey !==
        shortcut.shift ||
      event.altKey !==
        shortcut.alt
    ) {
      return false;
    }

    // macOS uses Cmd, everyone else uses Ctrl. Accepting BOTH everywhere means a
    // Windows user with a Mac keyboard still gets the shortcut, which is a far
    // better failure mode than the chord simply doing nothing.
    return (
      (event.ctrlKey &&
        !event.metaKey) ||
      (event.metaKey &&
        !event.ctrlKey)
    );
  }

  // Ctrl+F / Cmd+F toggles the find minibar.
  //
  // Modelled on closeShortcutMatches rather than shortcutMatches: ctrl and meta
  // are accepted interchangeably so a Mac user on a Mac keyboard and a Windows
  // user on either keyboard both get the chord, rather than it silently doing
  // nothing on the platform where the chord is unusual.
  function findShortcutMatches(
    event
  ) {
    const shortcut =
      CONFIG.shortcuts.find;

    if (
      event.code !==
        shortcut.key ||
      event.shiftKey !==
        shortcut.shift ||
      event.altKey !==
        shortcut.alt
    ) {
      return false;
    }

    return (
      (event.ctrlKey &&
        !event.metaKey) ||
      (event.metaKey &&
        !event.ctrlKey)
    );
  }

  // Ctrl+Z / Cmd+Z undoes the last edit.
  //
  // Modelled on findShortcutMatches: ctrl and meta are accepted interchangeably so
  // the chord works on every platform/keyboard. Unlike find, this must be gated on
  // the panel being OPEN and the focus NOT being in a text field — see the handler.
  function undoShortcutMatches(
    event
  ) {
    const shortcut =
      CONFIG.shortcuts.undo;

    if (
      event.code !==
        shortcut.key ||
      event.shiftKey !==
        shortcut.shift ||
      event.altKey !==
        shortcut.alt
    ) {
      return false;
    }

    return (
      (event.ctrlKey &&
        !event.metaKey) ||
      (event.metaKey &&
        !event.ctrlKey)
    );
  }

  // Ctrl+Y / Cmd+Y redoes the last undone edit.
  //
  // Ctrl+Shift+Z is the other conventional redo chord and is accepted here too, so
  // a user who reaches for it out of habit is not left with a dead key. The two are
  // distinguished from plain Ctrl+Z undo purely by the shift modifier.
  function redoShortcutMatches(
    event
  ) {
    // Plain Ctrl+Y / Cmd+Y.
    const shortcut =
      CONFIG.shortcuts.redo;

    if (
      event.code ===
        shortcut.key &&
      event.shiftKey ===
        shortcut.shift &&
      event.altKey ===
        shortcut.alt &&
      ((event.ctrlKey &&
        !event.metaKey) ||
        (event.metaKey &&
          !event.ctrlKey))
    ) {
      return true;
    }

    // Ctrl+Shift+Z / Cmd+Shift+Z.
    const undoShortcut =
      CONFIG.shortcuts.undo;

    if (
      event.code ===
        undoShortcut.key &&
      event.shiftKey &&
      !event.altKey &&
      ((event.ctrlKey &&
        !event.metaKey) ||
        (event.metaKey &&
          !event.ctrlKey))
    ) {
      return true;
    }

    return false;
  }

  function keyboardNavigation(
    event
  ) {
    if (
      isInputLike(
        event.target
      )
    ) {
      return;
    }

    // Home / End jump the selection to the first / last entry.
    //
    // Handled before the "no selected row" bail-out further down: these are
    // exactly the keys a user presses when nothing is selected yet, so they must
    // not depend on there being a current selection.
    //
    // Arrow keys stay out of this: they reorder the selected entry in this panel
    // rather than moving a cursor, so Home/End deliberately follow suit and move
    // the selection instead of reordering anything.
    if (
      event.key ===
        "Home" ||
      event.key ===
        "End"
    ) {
      // Always consume the key, even when the selection was already at that
      // edge, so the panel does not also scroll the list out from under it.
      event.preventDefault();

      selectEdgeRow(
        event.key === "Home"
          ? "first"
          : "last"
      );

      return;
    }

    const row =
      getSelectedRow();

    // A row only carries a rule once it has been acted on, and an extension row
    // starts out with none. Bailing out here left those rows unselectable by
    // keyboard even though they render and can be clicked, so the rule is created
    // on demand instead.
    if (!row) return;

    if (
      !row.entry &&
      row.kind !==
        "separator"
    ) {
      ensureRuleForRow(
        row.menuId,
        row
      );
    }

    if (
      event.key ===
        "ArrowUp" ||
      event.key ===
        "ArrowDown"
    ) {
      event.preventDefault();

      if (
        !row.entry &&
        ensureFullControl(
          row.menuId
        )
      ) {
        const fresh =
          buildRows(
            row.menuId
          ).find(
            r =>
              r.key ===
                row.key ||
              r.selector ===
                row.selector
          );

        if (fresh?.entry) {
          if (
            nudge(
              row.menuId,
              fresh.entry,
              event.key ===
                "ArrowUp"
                ? -1
                : 1
            )
          ) {
            render();
          }
        }

        return;
      }

      if (row.entry) {
        if (
          nudge(
            row.menuId,
            row.entry,
            event.key ===
              "ArrowUp"
              ? -1
              : 1
          )
        ) {
          render();
        }
      }
    }
  }

  // Escape closes the editor unless a focused inline-rename field owns the key.
  // This listener runs in capture phase so it can close the panel even when
  // ordinary descendants stop bubbling; inline rename is the intentional
  // exception because its target-level handler must cancel the edit first.
  window.addEventListener(
    "keydown",
    event => {
      if (
        event.key !== "Escape" ||
        !state.panel?.hasAttribute("open")
      ) {
        return;
      }

      // Let the focused rename input receive Escape. Its own keydown handler
      // calls finish(false), restoring the original title and returning focus to
      // that row. Since it stops propagation, the bubble-phase panel handler
      // below will not close the editor on this same keypress.
      if (
        isInlineRenameInput(event.target) ||
        isInlineRenameInput(document.activeElement)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      closeCustomReferenceDialog();
      closeRowMenu();
      void togglePanel(false);
    },
    true
  );

  window.addEventListener(
    "keydown",
    event => {
      // Ctrl+F toggles the find minibar.
      //
      // Checked FIRST, and ahead of every isInputLike guard below, because the
      // one place this chord has to keep working is while the cursor is IN the
      // find field — which is exactly the isInputLike case every other handler
      // here bails on. A Ctrl+F that did nothing there, or that re-opened the
      // field it had just closed, would be a dead chord.
      //
      // Only consumed while the panel is OPEN. Swallowing Ctrl+F unconditionally
      // would break Firefox's own find bar across the whole browser, a far worse
      // regression than this shortcut not working — so with the panel closed this
      // deliberately does nothing and the browser keeps its own behaviour.
      if (
        findShortcutMatches(
          event
        ) &&
        state.panel?.hasAttribute(
          "open"
        )
      ) {
        event.preventDefault();
        event.stopPropagation();

        toggleFind();

        return;
      }

      // Checked FIRST, and before the toggle check below, because it must never
      // fall through to togglePanel().
      //
      // Only consumed while the panel is OPEN. Swallowing it unconditionally would
      // stop the user closing TABS with Ctrl+W anywhere in the browser, which is a
      // far worse regression than the shortcut not working — so with the panel
      // closed this deliberately does nothing and Firefox keeps its own behaviour.
      if (
        closeShortcutMatches(
          event
        ) &&
        state.panel?.hasAttribute(
          "open"
        )
      ) {
        if (
          isInputLike(
            event.target
          )
        ) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        closeRowMenu();

        void togglePanel(
          false
        );

        return;
      }

      if (
        shortcutMatches(
          event
        )
      ) {
        if (
          isInputLike(
            event.target
          )
        ) {
          return;
        }

        event.preventDefault();

        void togglePanel();

        return;
      }

      const panelOpen =
        state.panel?.hasAttribute(
          "open"
        );

      if (!panelOpen) {
        return;
      }

      // Ctrl+Z / Ctrl+Y (and their Shift variants) drive undo/redo.
      //
      // Gated on the panel being OPEN so the browser keeps its own undo everywhere
      // else, and on the focus NOT being in a text field — inside the rename input
      // or the find field, Ctrl+Z must stay the field's own text undo, not the
      // menu's. undo()/redo() already re-render, refresh the save/dirty state and
      // the undo/redo button tooltips, so this is purely a key binding.
      if (
        !isInputLike(
          event.target
        )
      ) {
        if (
          redoShortcutMatches(
            event
          )
        ) {
          event.preventDefault();
          event.stopPropagation();

          redo();

          return;
        }

        if (
          undoShortcutMatches(
            event
          )
        ) {
          event.preventDefault();
          event.stopPropagation();

          undo();

          return;
        }
      }

      if (
        event.key ===
          "Escape" &&
        !isInputLike(
          event.target
        )
      ) {
        event.preventDefault();

        // An open find minibar absorbs Escape before the panel does. Without this
        // the first Escape would close the whole panel and take the list with it,
        // when the user was only trying to dismiss a little search box.
        //
        // The minibar's own handler covers the case where focus is inside the
        // field (it stops propagation); this covers every other focus position —
        // a row, the titlebar, the panel itself.
        if (
          state.findOpen
        ) {
          closeFind();

          return;
        }

        closeRowMenu();

        togglePanel(
          false
        );

        return;
      }

      keyboardNavigation(
        event
      );
    }
  );

  window.addEventListener(
    "resize",
    () => {
      closeRowMenu();
    }
  );

  window.addEventListener(
    "scroll",
    () => {
      closeRowMenu();
    },
    true
  );

  // ===========================================================================
  // STYLE
  // ===========================================================================

  const CSS_TEXT = `
    /* Theme tokens are shared by the panel and its two root-level popups.
       The system colours are the no-preference / fallback palette; the two
       complete scheme palettes are declared together at the end of this CSS. */
    #${CONFIG.panelId},
    .cm-row-popup,
    .cm-drag-ghost {
      color-scheme: light dark;
      --cme-panel-bg: Canvas;
      --cme-panel-fg: CanvasText;
      --cme-surface-bg: Field;
      --cme-input-bg: Field;
      --cme-input-fg: FieldText;
      --cme-input-border: rgba(128,128,128,.55);
      --cme-button-bg: ButtonFace;
      --cme-button-border: rgba(128,128,128,.35);
      --cme-panel-border: rgba(128,128,128,.35);
      --cme-header-bg: Canvas;
      --cme-header-fg: CanvasText;
    }


    #${CONFIG.panelId} {
      position: fixed !important;
      top: 72px;
      right: 20px;
      left: auto;
      width: min(860px, calc(100vw - 32px));
      max-height: min(86vh, 980px);
      display: none;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      box-sizing: border-box;

      border: 1px solid var(--cme-panel-border);
      border-radius: 10px;

      background: var(--cme-panel-bg);
      color: var(--cme-panel-fg);

      box-shadow:
        0 16px 48px rgba(0,0,0,.42),
        0 2px 8px rgba(0,0,0,.18);

      font: message-box;
      font-size: 13px;
      line-height: 1.25;

      z-index: 2147483000;
      overflow: hidden;
    }

    #${CONFIG.panelId}[open] {
      display: flex !important;
    }

    #${CONFIG.panelId}.moving {
      user-select: none;
    }

    #${CONFIG.panelId}.resizing {
      /* Keep the pointer from selecting row text while the grip is dragged. */
      user-select: none;
      cursor: nwse-resize;
    }

    #${CONFIG.panelId} .resize-grip {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 18px;
      height: 18px;
      /* Above the two edge strips and the panel padding, below interactive
         children. The corner has to win where all three overlap, because it is
         the only zone that drives both axes at once. */
      z-index: 3;
      /* nesw, NOT nwse. The grip sits at the bottom-left of a panel that is
         anchored right and top, so the corner being dragged is the south-west
         one: left grows the width, down grows the height. nwse pointed at the
         opposite diagonal and contradicted the motion. */
      cursor: nesw-resize;
      /* The grip is decoration, not a control: no focus ring, no text select. */
      background: transparent;
      border-top-right-radius: 10px;
      touch-action: none;
    }

    #${CONFIG.panelId} .resize-grip-top-left {
      top: 0;
      bottom: auto;
      left: 0;
    }

    #${CONFIG.panelId} .resize-grip-top-right {
      top: 0;
      right: 0;
      bottom: auto;
      left: auto;
    }

    #${CONFIG.panelId} .resize-grip-bottom-right {
      right: 0;
      bottom: 0;
      left: auto;
    }

    /* -----------------------------------------------------------------------
       RESIZE EDGES

       The panel is anchored top-right, so only the left and bottom edges can
       grow it. Both are thin transparent strips: visible only as a cursor
       change, so they add no chrome but make the panel behave like a window.

       The left strip is 7px, which is narrower than the panel's own 10px
       padding. That matters — it means the strip sits entirely in the padding
       and can never steal a press from the 28px drag handle, which starts just
       inside it. A wider strip would silently break row dragging.
       ----------------------------------------------------------------------- */
    #${CONFIG.panelId} .resize-edge {
      position: absolute;
      z-index: 2;
      background: transparent;
      touch-action: none;
      /* Same reason the grip needs it: a press here must not select row text. */
      user-select: none;
    }

    #${CONFIG.panelId} .resize-edge-left {
      top: 0;
      bottom: 0;
      left: 0;
      width: 7px;
      cursor: ew-resize;
    }

    #${CONFIG.panelId} .resize-edge-bottom {
      left: 0;
      right: 0;
      bottom: 0;
      height: 6px;
      cursor: ns-resize;
    }

    #${CONFIG.panelId} .resize-edge-right {
      top: 0;
      right: 0;
      bottom: 0;
      width: 7px;
      cursor: ew-resize;
    }

    #${CONFIG.panelId} .resize-edge-top {
      top: 0;
      right: 0;
      left: 0;
      height: 6px;
      cursor: ns-resize;
    }

    #${CONFIG.panelId} .resize-grip:hover {
      background:
        linear-gradient(
          135deg,
          transparent 0 6px,
          currentColor 6px 8px,
          transparent 8px 11px,
          currentColor 11px 13px,
          transparent 13px
        );
      opacity: .45;
    }

    #${CONFIG.panelId} .resize-grip:focus-visible {
      outline: 1px dotted currentColor;
      outline-offset: -3px;
    }

    #${CONFIG.panelId} button,
    #${CONFIG.panelId} input,
    #${CONFIG.panelId} select {
      font: inherit;
    }

    /* -----------------------------------------------------------------------
       TITLEBAR
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .titlebar {
      display: flex;
      align-items: center;
      gap: 8px;
      /* A taller title surface; the full titlebar and toolbar strip below it
         are both drag regions (see makePanelDraggable), so the panel is easy
         to move without aiming at a thin strip. */
      min-height: 40px;
      padding: 6px 6px 6px 10px;
      border-radius: 7px;
      cursor: grab;
      user-select: none;
    }

    #${CONFIG.panelId} .titlebar:active {
      cursor: grabbing;
    }

    #${CONFIG.panelId} .title-group {
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 8px;

      /* The close button's own margin-inline-start:auto is the flex spacer that
         keeps it at the far end, which is all this row needs now that the find
         bar has moved down to the list header. */
      flex: 1 1 auto;
    }

    #${CONFIG.panelId} .title {
      font-size: 15px;
      font-weight: 700;
      white-space: nowrap;
    }

    #${CONFIG.panelId} .close-button {
      /* Was on the removed "drag title bar" hint, which acted as the flex
         spacer. The titlebar is display:flex, so without this the close button
         would sit right next to the title instead of at the far end. */
      margin-inline-start: auto;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font-weight: 700;
      padding: 3px 7px;
      cursor: pointer;
    }

    #${CONFIG.panelId} .close-button:hover {
      background: rgba(220,80,90,.16);
      border-color: rgba(220,80,90,.35);
    }

    /* -----------------------------------------------------------------------
       TOOLBAR
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .toolbar,
    #${CONFIG.panelId} .management-bar,
    #${CONFIG.panelId} .filter-bar,
    #${CONFIG.panelId} .footer {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    #${CONFIG.panelId} .toolbar {
      padding: 2px;
      cursor: grab;
      user-select: none;
    }

    #${CONFIG.panelId} .titlebar:active,
    #${CONFIG.panelId} .toolbar:active {
      cursor: grabbing;
    }

    /* The menu selector remains a normal control inside the enlarged drag zone. */
    #${CONFIG.panelId} .toolbar .menu-picker {
      cursor: default;
      user-select: auto;
    }

    /* Styleable replacement for window.prompt() used by Custom reference.
       The input is slightly larger than the editor's 13px base text so copied
       IDs and selectors are easier to read and verify. */
    #${CONFIG.panelId} .custom-reference-backdrop {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 18px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, .58);
      cursor: default;
    }

    #${CONFIG.panelId} .custom-reference-dialog {
      width: min(540px, 100%);
      box-sizing: border-box;
      padding: 16px;
      border: 1px solid var(--cme-panel-border);
      border-radius: 9px;
      background: var(--cme-panel-bg);
      color: var(--cme-panel-fg);
      box-shadow: 0 14px 38px rgba(0,0,0,.45);
    }

    #${CONFIG.panelId} .custom-reference-title {
      margin-bottom: 7px;
      font-size: 15px;
      font-weight: 700;
    }

    #${CONFIG.panelId} .custom-reference-help {
      margin: 0 0 12px;
      line-height: 1.45;
      opacity: .88;
    }

    #${CONFIG.panelId} .custom-reference-input {
      display: block;
      width: 100%;
      min-height: 36px;
      box-sizing: border-box;
      padding: 7px 10px;
      border: 1px solid var(--cme-input-border);
      border-radius: 5px;
      background: var(--cme-input-bg);
      color: var(--cme-input-fg);
      font-size: 15px;
      line-height: 1.35;
    }

    #${CONFIG.panelId} .custom-reference-input:focus-visible {
      outline: 2px solid #4a9eff;
      outline-offset: 1px;
    }

    #${CONFIG.panelId} .custom-reference-actions {
      display: flex;
      justify-content: flex-end;
      gap: 7px;
      margin-top: 14px;
    }

    #${CONFIG.panelId} .custom-reference-actions button {
      min-height: 30px;
      padding: 4px 11px;
      border: 1px solid var(--cme-button-border);
      border-radius: 5px;
      background: var(--cme-button-bg);
      color: inherit;
      cursor: pointer;
    }

    #${CONFIG.panelId} .custom-reference-actions .primary-button {
      border-color: rgba(74,158,255,.7);
      background: rgba(74,158,255,.16);
      font-weight: 700;
    }

    /* In-panel replacement for native window.confirm(): the modal inherits
       the studio palette and uses the same compact controls as the footer. */
    #${CONFIG.panelId} .confirm-backdrop {
      position: absolute;
      inset: 0;
      z-index: 30;
      display: grid;
      place-items: center;
      overflow: auto;
      padding: 18px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, .48);
      cursor: default;
    }

    #${CONFIG.panelId} .confirm-dialog {
      width: min(440px, 100%);
      box-sizing: border-box;
      padding: 16px;
      border: 1px solid var(--cme-panel-border);
      border-radius: 9px;
      background: var(--cme-panel-bg);
      color: var(--cme-panel-fg);
      box-shadow: 0 14px 38px rgba(0,0,0,.42);
    }

    #${CONFIG.panelId} .confirm-title {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 700;
    }

    #${CONFIG.panelId} .confirm-message {
      margin: 0;
      white-space: pre-wrap;
      line-height: 1.45;
      opacity: .9;
    }

    #${CONFIG.panelId} .confirm-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 7px;
      margin-top: 16px;
    }

    #${CONFIG.panelId} .confirm-actions button {
      min-height: 28px;
      padding: 4px 11px;
      border: 1px solid var(--cme-button-border);
      border-radius: 5px;
      background: var(--cme-button-bg);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    #${CONFIG.panelId} .confirm-actions .confirm-primary {
      border-color: rgba(74,158,255,.7);
      background: rgba(74,158,255,.16);
      font-weight: 700;
    }

    #${CONFIG.panelId} .confirm-actions .confirm-danger {
      border-color: rgba(220,80,90,.48);
      background: rgba(220,80,90,.12);
      font-weight: 700;
    }

    #${CONFIG.panelId} .confirm-actions button:focus-visible {
      outline: 2px solid #4a9eff;
      outline-offset: 2px;
    }

    /* Pushed to the far right so the menu picker keeps the left edge to itself. */
    #${CONFIG.panelId} .compact-button {
      margin-inline-start: auto;
    }

    #${CONFIG.panelId} .compact-button[aria-pressed="true"] {
      box-shadow: inset 0 0 0 1px rgba(100,145,255,.7);
      font-weight: 700;
    }

    #${CONFIG.panelId} .toolbar button,
    #${CONFIG.panelId} .management-bar button,
    #${CONFIG.panelId} .footer button,
    #${CONFIG.panelId} .cm-row button {
      min-height: 25px;
      padding: 3px 8px;
      border: 1px solid var(--cme-button-border);
      border-radius: 5px;
      background: var(--cme-button-bg);
      color: inherit;
      cursor: pointer;
    }

    #${CONFIG.panelId} button:hover:not(:disabled) {
      filter: brightness(.95);
    }

    #${CONFIG.panelId} button:active:not(:disabled) {
      filter: brightness(.9);
    }

    #${CONFIG.panelId} button:disabled {
      cursor: default;
      opacity: .45;
    }

    #${CONFIG.panelId} .compact {
      min-width: 29px;
      padding-inline: 6px;
      font-weight: 700;
    }

    #${CONFIG.panelId} .menu-picker {
      width: ${CONFIG.maxMenuWidth}px;
      max-width: 40vw;
      min-width: 180px;
    }

    #${CONFIG.panelId} .mode-button[data-active="true"] {
      box-shadow: inset 0 0 0 1px rgba(100,145,255,.7);
      font-weight: 700;
    }

    /* -----------------------------------------------------------------------
       MANAGEMENT BAR
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .management-bar {
      padding: 6px 0 4px;
      border-top: 1px solid rgba(128,128,128,.16);
      border-bottom: 1px solid rgba(128,128,128,.16);
    }

    #${CONFIG.panelId} .management-bar button:first-child {
      font-weight: 700;
    }

    #${CONFIG.panelId} .stats {
      margin-inline-start: auto;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: .62;
      font-size: 11px;
    }

    /* -----------------------------------------------------------------------
       FILTER
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .filter-input {
      flex: 1 1 260px;
      min-width: 180px;
      box-sizing: border-box;
      padding: 5px 8px;
      border: 1px solid rgba(128,128,128,.32);
      border-radius: 5px;
      background: var(--cme-surface-bg);
      color: inherit;
    }

    #${CONFIG.panelId} .filter-mode {
      min-width: 110px;
    }

    #${CONFIG.panelId} .filter-count {
      opacity: .55;
      min-width: 54px;
      text-align: right;
      font-size: 11px;
    }

    /* -----------------------------------------------------------------------
       FIND MINIBAR

       Sits in the titlebar. Everything about it is sized to stay out of the
       way of the title: a narrow field, small controls, and it collapses to
       nothing (the hidden attribute) when not summoned.

       The [hidden] attribute needs the explicit display:none below. The panel's own button
       rules would otherwise re-show it, since a UA [hidden] rule loses to any
       author rule that sets display.
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .find-bar {
      display: flex;
      align-items: center;
      gap: 3px;

      /* Pushed to the right-hand end of the header row, which is where the item
         count sits, so this fills the space beside it. */
      margin-inline-start: auto;

      /* The header is uppercase 10px with letter-spacing for its own labels. The
         find field is an input, not a heading, so it opts back out — otherwise the
         placeholder and the counter both render in the header's caps style. */
      text-transform: none;
      letter-spacing: normal;
      font-weight: 400;
      font-size: 11px;
      opacity: 1;

      /* Keeps the "146 ITEMS" label from butting against the field. */
      padding-inline-start: 10px;

      cursor: default;
      user-select: text;
    }

    #${CONFIG.panelId} .find-bar[hidden] {
      display: none;
    }

    #${CONFIG.panelId} .find-input {
      width: 150px;
      min-height: 22px;
      padding: 1px 6px;

      border: 1px solid rgba(100,145,255,.55);
      border-radius: 5px;

      background: var(--cme-surface-bg);
      color: inherit;

      font: inherit;
      font-size: 12px;
    }

    #${CONFIG.panelId} .find-input:focus-visible {
      outline: 1px solid rgba(100,145,255,.8);
    }

    #${CONFIG.panelId} .find-count {
      min-width: 38px;
      text-align: right;

      opacity: .6;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    /* "none" is a dead end, so it gets tinted rather than left to read as an
       ordinary count. */
    #${CONFIG.panelId} .find-count.find-none {
      opacity: .85;
    }

    #${CONFIG.panelId} .find-bar button {
      min-height: 22px;
      padding: 0 6px;
      line-height: 1;
      font-size: 11px;
    }

    #${CONFIG.panelId} .find-step:disabled,
    #${CONFIG.panelId} .find-close:disabled {
      opacity: .4;
      cursor: default;
    }

    /* The find HIGHLIGHT rules used to live here, right after the find bar's own
       styling. That was a bug: they declared box-shadow on .cm-row, and every
       row state further down this stylesheet — .is-hidden (red), .selected
       (blue), .drop-before/.drop-after — declares box-shadow too, at the SAME
       specificity. Later wins, so all of them silently overwrote the highlight and
       a match on a hidden or selected row showed nothing at all.

       The rules now live at the very end of this stylesheet, after every row
       state. Order is the whole fix; there is no way to win this on specificity
       alone without resorting to a selector no reader would believe. */

    /* -----------------------------------------------------------------------
       LIST
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .rows {
      /* min-height:0 is load-bearing, and it used to be 280px.
         A flex item's automatic minimum size is its content size, so this row
         refused to shrink below a floor and pushed the FOOTER past the bottom of
         a short panel — where overflow:hidden clipped it away entirely. The Save
         button simply disappeared, at exactly the moment the user was resizing to
         reach it.
         min-height:0 lets this row be the only thing that gives way, which is
         what a scrollable list should do. The panel's own minimum height
         (RESIZE_MIN_HEIGHT) is what keeps the list usable. */
      min-height: 0;
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;

      border: 1px solid var(--cme-panel-border);
      border-radius: 7px;

      background: var(--cme-surface-bg);
    }

    #${CONFIG.panelId} .cm-grid-header {
      position: sticky;
      top: 0;
      z-index: 4;

      display: grid;
      /* Three columns: the grip and the name (matching .cm-row exactly), plus a
         third for the find bar.

         The find bar is appended to this header by mountFindBar(), so the track
         has to be declared here. Without it a grid child with no track of its own
         gets an implicit one — which would push the header out of alignment with
         the rows below it, the exact failure the two-column comment below warns
         about.

         The third track is auto-sized, so it takes only the width the bar needs and
         collapses to nothing while the bar is hidden. The item count stays in the
         1fr track and does not move when the bar appears or disappears.

         A fourth track mirrors the rows' context-filter column, so the header
         keeps the same track count as .cm-row and never desynchronises from it. */
      grid-template-columns: 32px minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;

      padding: 6px 7px;
      border-bottom: 1px solid rgba(128,128,128,.25);

      background: var(--cme-header-bg);
      color: var(--cme-header-fg);

      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }

    #${CONFIG.panelId} .cm-row {
      display: grid;
      /* Matches .cm-grid-header exactly — a CSS grid places children by
         position, so any extra child without a matching column gets an implicit
         one and the row visibly desynchronises from its header. Four tracks now:
         the grip, the name, the per-entry context filter, and the per-entry
         enable/disable checkbox. The filter lands beside the checkbox at the
         right edge instead of stealing width from the name. */
      grid-template-columns: 32px minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;

      min-height: 37px;
      box-sizing: border-box;

      padding: 4px 7px;
      border-bottom: 1px solid rgba(128,128,128,.13);

      transition:
        background-color 60ms linear,
        box-shadow 60ms linear;
    }

    #${CONFIG.panelId} .cm-row:last-child {
      border-bottom: none;
    }

    /* Nested submenu hierarchy: the parent remains a normal editable row;
       its children are indented and appear only after the + control is opened. */
    #${CONFIG.panelId} .cm-title-line {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    #${CONFIG.panelId} .nested-order-controls {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-inline-start: 5px;
      opacity: 0;
      transition: opacity 90ms linear;
    }

    #${CONFIG.panelId} .cm-row-nested:hover .nested-order-controls,
    #${CONFIG.panelId} .cm-row-nested:focus-within .nested-order-controls {
      opacity: 1;
    }

    /* Touch devices do not have a hover state. Keep the explicit child-order
       buttons visible there instead of relying exclusively on dragging. */
    @media (hover: none) {
      #${CONFIG.panelId} .nested-order-controls {
        opacity: 1;
      }
    }

    #${CONFIG.panelId} .cm-row .nested-order-button {
      display: inline-grid;
      place-items: center;
      box-sizing: border-box;
      width: 19px;
      min-width: 19px;
      height: 19px;
      min-height: 19px;
      margin: 0;
      padding: 0;
      border: 1px solid var(--cme-border, rgba(128,128,128,.4));
      border-radius: 3px;
      background: transparent;
      color: inherit;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
    }

    #${CONFIG.panelId} .cm-row .nested-order-button:hover {
      background: rgba(128,128,128,.18);
      border-color: rgba(110,150,255,.75);
    }

    /* This selector intentionally outranks the general
       #panel .cm-row button rule above. Without the extra .cm-row component,
       the generic button padding/min-height wins in the cascade and pushes the
       +/- glyph off-centre, often making the control wider than its title gap. */
    #${CONFIG.panelId} .cm-row .group-toggle {
      position: relative;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      flex: 0 0 20px;
      width: 20px;
      min-width: 20px;
      height: 20px;
      min-height: 20px;
      margin: 0;
      padding: 0;
      overflow: hidden;
      border: 1px solid var(--cme-border, rgba(128,128,128,.45));
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 0;
      line-height: 0;
      vertical-align: middle;
    }

    /* Draw the disclosure mark from two equal strokes. Unlike + / − font
       glyphs, these have an exact geometric centre on every operating system. */
    #${CONFIG.panelId} .cm-row .group-toggle::before,
    #${CONFIG.panelId} .cm-row .group-toggle::after {
      content: "";
      position: absolute;
      display: block;
      left: 50%;
      top: 50%;
      border-radius: 1px;
      background: currentColor;
      pointer-events: none;
      transform: translate(-50%, -50%);
    }

    #${CONFIG.panelId} .cm-row .group-toggle::before {
      width: 9px;
      height: 1.5px;
    }

    #${CONFIG.panelId} .cm-row .group-toggle::after {
      width: 1.5px;
      height: 9px;
    }

    #${CONFIG.panelId} .cm-row .group-toggle[aria-expanded="true"]::after {
      display: none;
    }

    #${CONFIG.panelId} .group-toggle:hover {
      background: rgba(128,128,128,.16);
    }

    #${CONFIG.panelId} .cm-row-nested {
      /* Keep the four grid tracks aligned with ordinary rows. Indent only the
         name cell below; padding the whole row also shoved the context selector
         and visibility checkbox sideways and could clip them at the panel edge. */
      background: rgba(128,128,128,.045);
      box-shadow: inset 3px 0 0 rgba(128,128,128,.22);
    }

    #${CONFIG.panelId} .cm-row-nested .name-cell {
      flex-direction: column;
      box-sizing: border-box;
      padding-inline-start: var(--cm-row-indent, 28px);
    }

    /* -----------------------------------------------------------------------
       COMPACT MODE
       -----------------------------------------------------------------------
       Roughly halves the row height. The name, the selector and the badges used
       to stack on three lines; compact puts the name and its badges on ONE line
       and drops the selector entirely, since it is reference information rather
       than something you read while dragging.

       Interaction targets are deliberately NOT shrunk below what is comfortable:
       the grip stays large enough to grab and the row keeps enough height to hit
       accurately. A compact list that is hard to click would defeat the purpose,
       which is dragging many entries quickly.

       Specificity note: every rule here is "#panel .cm-row.compact"-shaped via
       the panel's own class, so it wins over the plain .cm-row rules above by
       being later in the sheet at equal specificity — no !important needed. */
    #${CONFIG.panelId}.compact .cm-row {
      min-height: 21px;
      grid-template-columns: 22px minmax(0, 1fr) auto auto;
      gap: 4px;
      padding: 1px 5px;
    }

    /* The per-entry enable/disable checkbox — the direct read/write control for
       the entry's "hidden" state, placed at the right edge of the row. Ticked
       = the entry is ENABLED and shows in Firefox; unticked = DISABLED. It is
       wired to setHidden(), so it carries undo/redo and dirty-tracking exactly
       like the same action in the row's "..." menu.

       grid-column: 4 pins it to the fourth track the row grid declares for it,
       so it never collides with the drag handle (track 1), the name cell
       (track 2) or the context filter (track 3) and stays put at the edge in
       every layout. justify-self: end keeps it flush right inside that auto
       track. */
    #${CONFIG.panelId} .visibility-toggle {
      grid-column: 4;
      justify-self: end;

      margin: 0 3px 0 4px;
      cursor: pointer;

      accent-color: #4a9eff;
    }

    #${CONFIG.panelId}.compact .visibility-toggle {
      width: 13px;
      height: 13px;
      margin: 0 2px;
    }

    /* The per-entry context filter — the "field" dropdown — in the third track,
       just left of the visibility checkbox. It restricts the entry to a chosen
       right-click field (image, media, link, selection, editable, frame, page)
       or "Default" for no restriction. Built only for the content-area menu, so it
       is simply absent from every other menu's rows.

       grid-column: 3 pins it to the third track, mirroring the checkbox at
       track 4, so the two right-edge controls never collide with the name. */
    #${CONFIG.panelId} .context-filter {
      grid-column: 3;
      justify-self: end;

      margin: 0 2px;
      cursor: pointer;

      font-size: 12px;
      line-height: 1.5;
      max-width: 140px;

      color: inherit;
      background: rgba(128,128,128,.14);
      border: 1px solid rgba(128,128,128,.32);
      border-radius: 4px;
      padding: 2px 5px;
    }

    #${CONFIG.panelId} .context-filter:hover {
      background: rgba(128,128,128,.22);
    }

    #${CONFIG.panelId} .context-filter:focus-visible {
      outline: 2px solid #4a9eff;
      outline-offset: 1px;
    }

    /* A restriction reads as a deliberate choice, so tint the control to match
       the accent used elsewhere for "this entry is under the user's control". */
    #${CONFIG.panelId} .context-filter.restricted {
      accent-color: #4a9eff;
      border-color: rgba(74,158,255,.55);
    }

    #${CONFIG.panelId}.compact .context-filter {
      max-width: 104px;
      padding: 1px 4px;
    }

    #${CONFIG.panelId}.compact .name-cell {
      flex-direction: row;
      align-items: center;
      gap: 5px;
      min-height: 0;
    }

    #${CONFIG.panelId}.compact .cm-name {
      padding: 1px 3px;
      font-size: 11px;
    }

    /* The selector is what compact mode trades away. "Show IDs" still works and
       is the escape hatch for anyone who needs it back. */
    #${CONFIG.panelId}.compact .selector {
      display: none;
    }

    #${CONFIG.panelId}.compact .badges {
      flex-wrap: nowrap;
      gap: 2px;
    }

    #${CONFIG.panelId}.compact .badge {
      /* 9px, not the old 8px: with the normal badge now 10px, leaving compact at
         8px made the difference look like a bug rather than a density setting.
         Still smaller, still nowrap, still fits the compact row. */
      padding: 1px 4px;
      font-size: 10px;
    }

    #${CONFIG.panelId}.compact .drag-handle {
      min-width: 18px;
    }

    #${CONFIG.panelId}.compact .separator-line {
      font-size: 9px;
    }

    #${CONFIG.panelId}.compact .cm-drag-ghost {
      font-size: 11px;
    }

    #${CONFIG.panelId} .cm-row.is-unverified {
      opacity: .72;
    }

    #${CONFIG.panelId} .cm-row.selected {
      background: rgba(110,150,255,.16);
      box-shadow: inset 3px 0 0 rgba(110,150,255,.85);
    }

    /* A multi-selection is several rows sharing one blue bar, which reads as a
       block rather than a set of unrelated highlights. Only applies when more
       than one row is selected, which paintSelection() cannot express with CSS
       alone — so the class is added by the selection code instead. */
    #${CONFIG.panelId} .cm-row.selected.multi {
      background: rgba(110,150,255,.24);
      box-shadow: inset 3px 0 0 rgba(110,150,255,.95);
    }

    #${CONFIG.panelId} .cm-row.dragging {
      opacity: .38;
    }

    #${CONFIG.panelId} .cm-row.drop-before {
      box-shadow: inset 0 2px 0 rgba(110,150,255,.95);
    }

    #${CONFIG.panelId} .cm-row.drop-after {
      box-shadow: inset 0 -2px 0 rgba(110,150,255,.95);
    }

      /* Registered-but-not-materialised extension rows are NOT offline, so they
       keep full opacity. Their "registered" badge and context tags are what say
       the entry comes from the extension registry rather than a live menu item. */

    /* -----------------------------------------------------------------------
       DRAG HANDLE
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .drag-handle {
      /* It is a span, not a button, so it needs the box behaviour a button used
         to get for free. */
      display: inline-flex;
      align-items: center;
      justify-content: center;

      box-sizing: border-box;
      width: 28px;
      min-height: 24px;
      padding: 2px 0;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;

      opacity: .5;
      cursor: grab;
      font: inherit;
      font-size: 16px;
      line-height: 1;
      user-select: none;
      /* The drag is pointer-driven, so the browser must not claim the gesture
         for panning/zooming on a touch device. */
      touch-action: none;
    }

    #${CONFIG.panelId} .drag-handle:hover {
      opacity: 1;
      border-color: rgba(128,128,128,.32);
    }

    #${CONFIG.panelId} .drag-handle:focus-visible {
      opacity: 1;
      outline: 1px solid rgba(110,150,255,.9);
      outline-offset: -1px;
    }

    #${CONFIG.panelId} .drag-handle:active {
      cursor: grabbing;
    }

    /* The drag image.
       With a native drag this was handed to setDragImage and lived only for one
       tick. It is now a real element that follows the cursor for the whole
       gesture, so it must be on screen, above everything, and never take a hit
       test. */
    .cm-drag-ghost {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483002;

      max-width: 320px;
      padding: 4px 9px;

      border: 1px solid rgba(110,150,255,.75);
      border-radius: 6px;
      background: var(--cme-panel-bg);
      color: var(--cme-panel-fg);
      box-shadow: 0 6px 20px rgba(0,0,0,.4);

      font: message-box;
      font-size: 12px;
      line-height: 1.3;
      pointer-events: none;
      opacity: .95;
      will-change: transform;
    }

    .cm-drag-ghost-name {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    /* Only present on a multi-row drag. It is the one thing that tells the user
       the gesture is carrying more than the row under the cursor — without it a
       group drag looks identical to a single drag and feels like a bug. */
    .cm-drag-ghost-count {
      display: block;
      margin-bottom: 1px;

      color: rgba(110,150,255,.95);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }

    /* -----------------------------------------------------------------------
       NAME / SELECTOR
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .name-cell {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;

      /* The cell fills the grid column while .cm-name inside it shrinks to the
         words, so this cell owns ALL the empty space to the right of a short
         title. Making it the drag surface is what turns that dead space into
         somewhere you can actually grab a row — previously only the 28px grip
         worked, which is a very small target for a very common action. */
      cursor: grab;
      align-self: stretch;
    }

    #${CONFIG.panelId} .name-cell:active {
      cursor: grabbing;
    }

    /* The input sits inside the cell, so it must win the grab cursor back —
       dragging out of a text field is not a thing users mean. The field's own
       box, padding and sizing live with the other .cm-name-input rules below. */
    #${CONFIG.panelId} .cm-name-input {
      cursor: text;
    }

    #${CONFIG.panelId} .cm-name {
      display: block;
      min-width: 0;

      /* Shrink to the words instead of filling the column.
         The rename target used to span the whole row, which made every empty
         square inch of the list look editable. Fitting the content keeps the
         affordance tight around the title that can actually be renamed, and
         hands the rest of the line back as ordinary draggable empty space. */
      width: fit-content;
      max-width: 100%;
      /* border-box keeps that 100% inclusive of the padding and border below;
         with the default content-box the box would overflow the grid column. */
      box-sizing: border-box;

      padding: 4px 3px;
      border: 1px solid transparent;
      border-radius: 3px;

      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      cursor: text;
    }

    /* Child totals are metadata, not part of the editable title. Their smaller,
       muted treatment and default cursor make that distinction visible without
       turning them into another badge or control. */
    #${CONFIG.panelId} .cm-entry-count {
      display: inline-block;
      flex: 0 0 auto;
      margin-inline-start: 3px;
      padding: 2px 5px;
      border-radius: 3px;
      background: rgba(128,128,128,.10);
      color: var(--cme-muted, rgba(160,160,160,.9));
      font-size: 11px;
      font-weight: 400;
      line-height: 1.35;
      white-space: nowrap;
      cursor: default;
      user-select: none;
    }

    #${CONFIG.panelId} .cm-name:hover {
      border-color: rgba(128,128,128,.45);
      background: rgba(128,128,128,.07);
    }

    #${CONFIG.panelId} .cm-name:focus-visible {
      outline: 1px solid rgba(100,145,255,.8);
    }

    /* A name recovered from the extension registry rather than read off a live
       menu item used to be flagged with a "*" prefix, then red-and-italic before
       that. All three were removed: the registry recovery is now visible in its
       own right through the "extension"/"registered" badges and the context tags,
       so a second visual signal on the title was redundant noise. The row's own
       states — hidden, selected, dragging — stay legible without having to fight
       a marker layered over the words. The explanation still lives in the title
       tooltip, where it costs nothing on screen. */

    #${CONFIG.panelId} .cm-name-input {
      /* Shrink-to-fit, like the .cm-name box it replaces. field-sizing does this
         natively from Firefox 121; fitInputToContent() measures and sets an inline
         width for older versions, and either way the field ends up a little wider
         than its text rather than a sliver.

         min-width is a real floor for when measurement is unavailable (row not yet
         laid out): too small and the selected text scrolls out of sight, which
         reads as "the title was deleted". 18ch is roughly the length of a real
         menu item, so the common case always shows the whole title. */
      field-sizing: content;

      min-width: 18ch;
      max-width: 100%;
      box-sizing: border-box;

      padding: 2px 4px;
      border: 1px solid rgba(100,145,255,.7);
      border-radius: 3px;

      background: var(--cme-panel-bg);
      color: inherit;
      outline: none;
    }

    #${CONFIG.panelId} .selector {
      min-width: 0;

      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      opacity: .48;
      font-size: 10px;
      font-family: ui-monospace, monospace;
    }

    #${CONFIG.panelId} .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;

      /* Keep status and context chips together at the RIGHT edge of the name
         area, instead of leaving them directly beside the title. The name and
         tags remain in the same grid column, so the content-menu context picker
         and enabled checkbox keep their existing dedicated tracks. In compact
         mode this auto margin uses the otherwise empty space after the title. */
      margin-inline-start: auto;
      justify-content: flex-end;
      align-self: center;
      min-width: 0;
    }

    #${CONFIG.panelId} .badge {
      display: inline-block;
      /* 9px was too small to read at a glance, especially for the context tags
         that carry the most meaning. 10px still fits comfortably inside the 37px
         row min-height, so bumping it costs no vertical space. */
      padding: 2px 5px;
      border-radius: 4px;
      background: rgba(128,128,128,.16);
      opacity: .8;
      font-size: 10px;
      line-height: 1.35;
    }

    #${CONFIG.panelId} .badge.renamed {
      background: rgba(100,145,255,.15);
    }

    #${CONFIG.panelId} .badge.extension {
      background: rgba(120,190,140,.16);
      font-style: normal;
    }

    /* -----------------------------------------------------------------------
       CONTEXT TAGS

       Which right-click situation an entry belongs to ("media", "sel",
       "link", ...). This is the answer to "why does this entry only show
       up sometimes", so it reads as information rather than as a warning.

       Each context carries TWO colours, so one rule can serve both themes:

         --ctx-tint  a saturated hue used as a low-alpha wash. On a dark
                     panel a light tint at low alpha reads clearly; the
                     same wash on white would be almost invisible, which is
                     why light mode lowers the alpha instead.
         --ctx-ink   a dark, desaturated version of the same hue, used as
                     the TEXT colour in light mode. The dark panel already
                     has light text, so --ctx-ink is unused there.

       Hues are spread around the wheel rather than varying lightness, so
       every context stays equally loud in dark mode and the set stays
       distinguishable rather than merely different.
       ----------------------------------------------------------------------- */
    #${CONFIG.panelId} .badge.context {
      font-style: normal;
      letter-spacing: .2px;
      opacity: 1;
    }

    /* page / frame — the neutral pair, nudged brighter than a plain grey would be,
       because at this size a neutral chip reads as "no colour" rather than as
       its own category. */
    #${CONFIG.panelId} .badge.page   { --ctx-tint: 163 178 199; --ctx-ink: 56 70 90; }
    #${CONFIG.panelId} .badge.frame  { --ctx-tint: 146 164 188; --ctx-ink: 48 62 82; }

    /* selection — teal, the "text is selected" colour people already expect. */
    #${CONFIG.panelId} .badge.sel    { --ctx-tint: 45 212 191; --ctx-ink: 6 92 84; }

    /* editable — amber, so form fields read differently from plain text. */
    #${CONFIG.panelId} .badge.edit   { --ctx-tint: 251 191 36;  --ctx-ink: 138 82 6; }

    /* link — blue. */
    #${CONFIG.panelId} .badge.link   { --ctx-tint: 96 165 250; --ctx-ink: 26 70 165; }

    /* image — green. */
    #${CONFIG.panelId} .badge.img    { --ctx-tint: 74 222 128; --ctx-ink: 14 96 44; }

    /* media — fuchsia, the midpoint of the two hues it replaced: violet for
       video, rose for audio. Both contexts render this one badge now. */
    #${CONFIG.panelId} .badge.media  { --ctx-tint: 232 121 249; --ctx-ink: 162 28 175; }

    /* tab — indigo, close to link but clearly its own thing. */
    #${CONFIG.panelId} .badge.tab    { --ctx-tint: 129 140 248; --ctx-ink: 47 57 172; }

    /* bookmark — orange. */
    #${CONFIG.panelId} .badge.bookmark { --ctx-tint: 251 146 60; --ctx-ink: 142 68 8; }

    /* Extension-toolbar contexts. */
    #${CONFIG.panelId} .badge.toolbar { --ctx-tint: 125 211 252; --ctx-ink: 17 92 140; }
    #${CONFIG.panelId} .badge.pagebtn { --ctx-tint: 56 189 248; --ctx-ink: 11 86 142; }
    #${CONFIG.panelId} .badge.action  { --ctx-tint: 103 232 249; --ctx-ink: 13 92 122; }
    #${CONFIG.panelId} .badge.custom  { --ctx-tint: 251 146 60; --ctx-ink: 154 52 18; }

    /* "all" means every context, so it gets a neutral grey rather than a
       hue that would imply one specific situation. */
    #${CONFIG.panelId} .badge.all    { --ctx-tint: 184 184 184; --ctx-ink: 82 82 82; }

    /* The "+N more" overflow chip. Deliberately untinted and dim: it carries
       no context of its own, only a pointer to the tooltip. */
    #${CONFIG.panelId} .badge.context-more {
      opacity: .65;
    }

    #${CONFIG.panelId} .badge.registered {
      background: rgba(120,190,140,.16);
      font-style: normal;
      font-weight: 700;
      opacity: .9;
    }

    #${CONFIG.panelId} .badge.tail {
      background: rgba(190,150,70,.15);
    }

    #${CONFIG.panelId} .badge.separator {
      background: rgba(150,150,150,.16);
    }

    /* -----------------------------------------------------------------------
       SEPARATORS
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .cm-separator-row {
      min-height: 27px;
      opacity: .62;

      /* Two children — grip and rule — so two tracks now, same as a normal
         row. The third "auto" track existed only for the ".separator-meta"
         selector cell, which no longer renders.

         The cell also had no stable home in compact mode — the compact
         ".cm-row" rule carries an extra class, so it beat this rule and
         pushed the cell onto a stray line under the rule. */
      grid-template-columns:
        22px minmax(0, 1fr);
    }

    #${CONFIG.panelId} .separator-line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: 1px;
    }

    /* -----------------------------------------------------------------------
       ROW POPUP
       ----------------------------------------------------------------------- */

    /* The popup is a sibling, not a child, because it is appended to the root. */
    .cm-row-popup {
      position: fixed;
      z-index: 2147483001;

      display: flex;
      flex-direction: column;
      gap: 2px;

      min-width: 150px;
      padding: 4px;

      border: 1px solid var(--cme-panel-border);
      border-radius: 7px;

      background: var(--cme-panel-bg);
      color: var(--cme-panel-fg);

      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      font: message-box;
      font-size: 12px;
    }

    .cm-row-popup .popup-action {
      display: block;
      width: 100%;
      min-height: 25px;
      padding: 4px 7px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    .cm-row-popup .popup-action:hover:not(:disabled) {
      background: rgba(100,145,255,.16);
    }

    .cm-row-popup .popup-action:disabled {
      opacity: .35;
    }

    /* -----------------------------------------------------------------------
       EMPTY / FOOTER
       ----------------------------------------------------------------------- */

    #${CONFIG.panelId} .empty-state {
      padding: 28px 18px;
      text-align: center;
      opacity: .5;
    }

    #${CONFIG.panelId} .footer {
      min-height: 29px;
      padding-top: 2px;
    }

    #${CONFIG.panelId} .footer .spacer {
      flex: 1;
    }

    #${CONFIG.panelId} .status {
      min-width: 0;
      max-width: 70%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      opacity: .68;
      font-size: 11px;
    }

    #${CONFIG.panelId} .status.ok {
      color: #65a97a;
      opacity: 1;
    }

    #${CONFIG.panelId} .status.error {
      color: #df727c;
      opacity: 1;
      font-weight: 700;
    }

    #${CONFIG.panelId} .save-button {
      font-weight: 700;
    }

    /* -----------------------------------------------------------------------
       SMALL WINDOWS
       ----------------------------------------------------------------------- */

    @media (max-width: 780px) {
      #${CONFIG.panelId} {
        right: 8px;
        width: calc(100vw - 16px);
      }
    }


    /* =======================================================================
       COMPLETE THEME PALETTES

       Every scheme-dependent surface and state is kept here. The shared rules
       above contain layout, typography and colour-independent interaction
       states only. Keep these two blocks together at the end of the stylesheet.
       ======================================================================= */
    @media (prefers-color-scheme: dark) {
      #${CONFIG.panelId},
      .cm-row-popup,
      .cm-drag-ghost {
        color-scheme: dark;
        --cme-panel-bg: #202126;
        --cme-panel-fg: #f0f1f4;
        --cme-surface-bg: #17181c;
        --cme-input-bg: #141519;
        --cme-input-fg: #f0f1f4;
        --cme-input-border: rgba(255,255,255,.27);
        --cme-button-bg: #303238;
        --cme-button-border: rgba(255,255,255,.2);
        --cme-panel-border: rgba(255,255,255,.2);
        --cme-header-bg: #090a0c;
        --cme-header-fg: #f5f6f7;
      }

      #${CONFIG.panelId} .find-count.find-none {
        color: #e0a030;
      }

      #${CONFIG.panelId} .cm-row.is-hidden {
        background: rgba(122,8,8,.55);
        box-shadow: inset 3px 0 0 rgba(196,40,40,.85);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.selected {
        background: rgba(150,12,12,.68);
        box-shadow:
          inset 5px 0 0 rgba(226,74,74,.95),
          inset 0 0 0 1px rgba(226,74,74,.35);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.drop-before {
        box-shadow: inset 0 2px 0 rgba(255,210,210,.95);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.drop-after {
        box-shadow: inset 0 -2px 0 rgba(255,210,210,.95);
      }

      #${CONFIG.panelId} .badge.context {
        background: rgb(var(--ctx-tint) / .28);
        color: var(--cme-panel-fg);
        box-shadow: inset 0 0 0 1px rgb(var(--ctx-tint) / .34);
      }

      #${CONFIG.panelId} .badge.context-more {
        background: rgb(var(--ctx-tint, 130 148 170) / .08);
      }

      #${CONFIG.panelId} .cm-row.find-match {
        box-shadow: inset 0 0 0 1px rgba(255,196,64,.9);
      }

      #${CONFIG.panelId} .cm-row.find-current {
        background: rgba(255,196,64,.18);
        box-shadow:
          inset 3px 0 0 rgba(255,196,64,.95),
          inset 0 0 0 1px rgba(255,222,140,.95);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.find-match {
        box-shadow: inset 0 0 0 2px rgba(255,214,64,.95);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.find-current {
        background: rgba(150,40,40,.72);
        box-shadow:
          inset 3px 0 0 rgba(255,214,64,.95),
          inset 0 0 0 2px rgba(255,232,150,.95);
      }
    }

    @media (prefers-color-scheme: light) {
      #${CONFIG.panelId},
      .cm-row-popup,
      .cm-drag-ghost {
        color-scheme: light;
        --cme-panel-bg: #f7f7f9;
        --cme-panel-fg: #202124;
        --cme-surface-bg: #ffffff;
        --cme-input-bg: #ffffff;
        --cme-input-fg: #202124;
        --cme-input-border: rgba(32,33,36,.28);
        --cme-button-bg: #eceef1;
        --cme-button-border: rgba(32,33,36,.2);
        --cme-panel-border: rgba(32,33,36,.22);
        --cme-header-bg: #ffffff;
        --cme-header-fg: #202124;
      }

      #${CONFIG.panelId} .find-count.find-none {
        color: #a05a10;
      }

      #${CONFIG.panelId} .cm-row.is-hidden {
        background: rgba(220,80,90,.14);
        box-shadow: inset 3px 0 0 rgba(200,55,65,.75);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.selected {
        background: rgba(220,80,90,.24);
        box-shadow:
          inset 5px 0 0 rgba(190,40,50,.9),
          inset 0 0 0 1px rgba(190,40,50,.35);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.drop-before {
        box-shadow: inset 0 2px 0 rgba(190,40,50,.9);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.drop-after {
        box-shadow: inset 0 -2px 0 rgba(190,40,50,.9);
      }

      #${CONFIG.panelId} .badge.context {
        background: rgb(var(--ctx-tint) / .16);
        color: rgb(var(--ctx-ink));
        box-shadow: inset 0 0 0 1px rgb(var(--ctx-tint) / .45);
      }

      #${CONFIG.panelId} .badge.context-more {
        background: rgb(var(--ctx-tint, 130 148 170) / .07);
      }

      #${CONFIG.panelId} .cm-row.find-match {
        box-shadow: inset 0 0 0 1px rgba(178,108,0,.95);
      }

      #${CONFIG.panelId} .cm-row.find-current {
        background: rgba(255,196,64,.34);
        box-shadow:
          inset 3px 0 0 rgba(160,92,0,.95),
          inset 0 0 0 1px rgba(178,108,0,.95);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.find-match {
        box-shadow: inset 0 0 0 2px rgba(150,80,0,.95);
      }

      #${CONFIG.panelId} .cm-row.is-hidden.find-current {
        background: rgba(255,214,120,.42);
        box-shadow:
          inset 3px 0 0 rgba(150,80,0,.95),
          inset 0 0 0 2px rgba(150,80,0,.95);
      }
    }

  `;

  function ensureStyle() {
    let style =
      document.getElementById(
        CONFIG.styleId
      );

    if (!style) {
      style =
        document.createElement(
          "style"
        );

      style.id =
        CONFIG.styleId;

      document.documentElement.appendChild(
        style
      );
    }

    if (
      style.textContent !==
      CSS_TEXT
    ) {
      style.textContent =
        CSS_TEXT;
    }
  }

  // Flatten a discovered menu tree for diagnostics without changing the
  // recursive structure used by the editor UI.
  function flattenMenuRows(rows, output = []) {
    for (const row of rows || []) {
      output.push(row);
      flattenMenuRows(row.children, output);
    }
    return output;
  }

  // ===========================================================================
  // TEST / API SURFACE
  // ===========================================================================

  window.__menuEditor = {
    open: () =>
      togglePanel(true),

    close: () =>
      togglePanel(false),

    toggle: () =>
      togglePanel(),

    render,
    save,
    readConfig,
    configPath,
    availableMenus,
    buildRows,
    extensionRegistry: menuId => extensionMenuRegistry(menuId || state.activeMenu),
    discovery: Object.freeze({
      policy: DISCOVERY_POLICY,
      observedSelectors: menuId => [
        ...(observedMenuSelectors(menuId || state.activeMenu)?.keys() || []),
      ],
      rows: menuId => flattenMenuRows(
        buildRows(menuId || state.activeMenu)
      ),
      unverifiedRules: menuId => flattenMenuRows(
        buildRows(menuId || state.activeMenu)
      )
        .filter(row => row.unverified)
        .map(row => ({ selector: row.selector, label: getRowName(row) })),
      dormantRules: menuId => flattenMenuRows(
        buildRows(menuId || state.activeMenu)
      )
        .filter(row => row.dormant)
        .map(row => ({
          selector: row.selector,
          label: getRowName(row),
          parentSelector: row.parentSelector || row.childOrderParentSelector || null,
        })),
    }),


    undo,
    redo,

    scan: () =>
      scanLiveMenu(),

    // Passive popup monitor. This is intentionally separate from the menu
    // editing API: it only returns diagnostic snapshots and never changes rows.
    monitor: {
      status: () => monitorStatusRecord(),
      report: () => monitorPublicClone(monitorReport()),
      text: () => JSON.stringify(monitorReport(), null, 2),
      clear: () => monitorClearHistory(),
      setEnabled: enabled => monitorSetEnabled(enabled),
    },

    // Forces the live-rule executors to run immediately. The real menu is
    // normally relabelled on popupshowing; this lets a test assert the rename
    // reached the live XUL node without having to open a context menu.
    applyLiveRules: () => {
      applyHiddenStyles();
      return true;
    },

    // What the most recent drop attempt actually did. Diagnostic only.
    lastDrop: () => lastDrop,

    // Was adoptCurrentOrder(). The dialog is gone; this now just asserts the
    // same end state — control assumed, browser order snapshot — silently.
    adopt: () => {
      const adopted = assumeControl(state.activeMenu);

      render();

      return adopted;
    },

    reset: () =>
      promptReset(),

    // "All visible", "Release rules" and "Sanity check" were removed from the
    // management bar along with their handlers, so their API entries went with
    // them. auditConfig/formatAudit stay: they still produce the hidden /
    // renamed / moved report embedded in an export bundle.
    compact: {
      get: () => true,
      set on(_v) {
        // Compact is the only layout; this is a no-op kept for API compatibility.
        state.compact = true;
        applyCompact();
      },
      toggle: () => toggleCompact(),
    },

    audit: async () =>
      auditConfig(
        state.dirty
          ? state.config
          : await readConfig()
      ),

    auditText: async () =>
      formatAudit(
        await window.__menuEditor.audit()
      ),

    exportConfig,
    importConfig: promptImport,

    get config() {
      return state.config;
    },

    get dirty() {
      return state.dirty;
    },

    get activeMenu() {
      return state.activeMenu;
    },

    selectMenu,

    select: key => {
      state.selectedKey =
        key;

      // Keep the multi-selection set in step with the single-key API. A test or a
      // console caller using select() expects the row to be genuinely selected —
      // and since renderRow() now reads selectedKeys, leaving the set stale would
      // mean this row does not even get the highlight.
      state.selectedKeys =
        key
          ? new Set([key])
          : new Set();

      state.selectionAnchor =
        key;

      state.selectedMenu =
        state.activeMenu;

      renderRowsOnly();

      return key;
    },

    // Multi-select helpers, for tests and for driving the panel from the console.
    selectMany: keys => {
      state.selectedKeys =
        new Set(
          (keys || []).filter(Boolean)
        );

      const list =
        [...state.selectedKeys];

      state.selectedKey =
        list[list.length - 1] ??
        null;

      state.selectionAnchor =
        state.selectedKey;

      state.selectedMenu =
        state.activeMenu;

      renderRowsOnly();

      return list;
    },

    get selectedKeys() {
      return [...state.selectedKeys];
    },

    testRename: (
      menuId,
      selector,
      value
    ) => {
      // Match on the rule's selector, not the suggested one: an entry that is
      // already managed carries the selector that was written for it, which is
      // not necessarily what suggestSelector() would produce now.
      const row =
        buildRows(
          menuId
        ).find(
          r =>
            r.selector ===
            selector
        ) ||
        buildRows(
          menuId
        ).find(
          r =>
            r.entry?.selector ===
            selector
        );

      if (!row) {
        return false;
      }

      const changed =
        rename(
          menuId,
          row,
          value
        );

      if (
        menuId ===
        state.activeMenu
      ) {
        render();
      }

      return changed;
    },

    testHide: (
      menuId,
      selector,
      hidden
    ) => {
      const entry =
        findRule(
          menuId,
          selector
        );

      if (!entry) {
        return false;
      }

      const changed =
        setHidden(
          menuId,
          entry,
          !!hidden
        );

      if (
        menuId ===
        state.activeMenu
      ) {
        render();
      }

      return changed;
    },

    testMove: (
      menuId,
      selector,
      targetSelector,
      after = false
    ) => {
      const from =
        findRule(
          menuId,
          selector
        );

      const target =
        findRule(
          menuId,
          targetSelector
        );

      if (
        !from ||
        !target
      ) {
        return false;
      }

      const changed =
        moveRule(
          menuId,
          from,
          target,
          !!after
        );

      if (
        menuId ===
        state.activeMenu
      ) {
        render();
      }

      return changed;
    },

    testMoveChild: (
      menuId,
      selector,
      targetSelector,
      after = false
    ) => {
      const rows = [];
      const visit = current => {
        for (const row of current || []) {
          rows.push(row);
          visit(row.children);
        }
      };
      visit(buildRows(menuId));

      const from = rows.find(row =>
        row.selector === selector || row.entry?.selector === selector
      );
      const target = rows.find(row =>
        row.selector === targetSelector || row.entry?.selector === targetSelector
      );

      if (
        !from ||
        !target ||
        !from.parentSelector ||
        from.parentSelector !== target.parentSelector
      ) {
        return false;
      }

      const changed = moveChildRowGroup(
        menuId,
        from.parentSelector,
        [from],
        target,
        !!after
      );

      if (menuId === state.activeMenu) render();
      return changed;
    },

    testCuteName: selector => prettifySelector(selector),

    state,
  };

  // ===========================================================================
  // STARTUP
  // ===========================================================================

  async function start() {
    ensureStyle();

    // Compact is the only layout, so it is applied unconditionally — there is no
    // stored preference to read and nothing to restore.
    state.compact = true;

    if (!engine()) {
      for (
        let i = 0;
        i < 50 &&
        !engine();
        i++
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              100
            )
        );
      }
    }

    try {
      state.config =
        await readConfig();
    } catch (error) {
      console.error(
        "[menu-editor] initial config load failed:",
        error
      );

      state.config =
        makeEmptyConfig();
    }

    // Arm the hidden rules on startup: rules already in the file must apply
    // without the panel ever being opened.
    installHiddenStyleWatcher();
    applyHiddenStyles();

    // Build lazily; this keeps startup cheap.
  }

  function delayedStartupReady() {
    return (
      typeof gBrowserInit !==
        "undefined" &&
      gBrowserInit.delayedStartupFinished
    );
  }

  if (delayedStartupReady()) {
    state.startupPromise =
      start();
  } else if (Services?.obs) {
    const observer = {
      observe(
        subject,
        topic
      ) {
        if (
          topic !==
            "browser-delayed-startup-finished" ||
          subject !== window
        ) {
          return;
        }

        Services.obs.removeObserver(
          observer,
          "browser-delayed-startup-finished"
        );

        state.startupPromise =
          start();
      },
    };

    Services.obs.addObserver(
      observer,
      "browser-delayed-startup-finished"
    );
  } else {
    state.startupPromise =
      new Promise(
        resolve => {
          window.addEventListener(
            "load",
            async () => {
              await start();
              resolve();
            },
            {
              once: true,
            }
          );
        }
      );
  }
})();



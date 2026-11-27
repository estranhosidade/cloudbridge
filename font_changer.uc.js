// ==UserScript==
// @name           Font Changer
// @description    Manage Firefox interface and web-page fonts. Ctrl+Shift+F opens a centered, draggable font window.
// @author         OpenAI
// @version        7.2.6-bookmark-control-height
// ==/UserScript==

(() => {
  "use strict";

  // ========================================================================
  // Configuration
  // ========================================================================

  const VERSION = "7.2.6-bookmark-control-height";
  const PREFIX = "[FontChanger]";
  const RUNTIME_KEY = "__ucFontChangerRuntime_v6";

  const PREF_ROOT = "userChrome.fontChanger.";
  const ACTIVE_SHEET_PREF = "extensions.ucFontChanger.activeContentSheet";
  // Generic toolbar tooltips can be Gecko document-level native-anonymous
  // content. They need an AGENT_SHEET; the browser.xhtml <style> element and
  // ordinary USER_SHEET rules do not reliably reach that tooltip implementation.
  const ACTIVE_TOOLTIP_SHEET_PREF = "extensions.ucFontChanger.activeTooltipAgentSheet";
  const POSITION_PREF = PREF_ROOT + "panelPosition";

  const PANEL_ID = "uc-font-changer-panel-v7";
  const STYLE_ID = "uc-font-changer-ui-style-v7";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const DEFAULT_BOOKMARK_FONTS = Object.freeze([
    "Roboto",
    "SF Pro",
    "Source Sans Pro",
    "Switzer",
    "Arimo",
    "Lato",
    "Consolas",
  ]);

  const DEFAULT_FONT = "Source Sans Pro";
  const DEBUG = true;

  // Visual/media elements are always excluded: they are not text targets and
  // should stay protected even when the user disables the icon/widget list.
  const MEDIA_EXCLUSIONS = [
    "svg", "svg *", "image", "img", "canvas", "video", "audio",
  ];

  const ICON_EXCLUSIONS = [
    ".toolbarbutton-icon", ".tab-icon-image", ".tab-icon-overlay",
    ".urlbar-icon", ".urlbarView-favicon", ".identity-box-icon",
    ".titlebar-button", ".titlebar-buttonbox *", ".window-controls",
    ".material-symbols", ".material-symbols-outlined",
    "[class*='material-icons']", "[class*='MaterialIcons']",
    "[class*='fa-']", ".fa", ".fas", ".far", ".fab", ".fa-solid",
    "fa-icon", "[class^='si-']", "[class*=' si-']",
    "[class*='glyphicon']", "[id*='glyphicon']", ".dashicons",
    ".noticon", ".ph", "[class*='ph-']", ".icon", "[class*='icon-']",
    "[class*='Icon']", "[class*='iconfont']", "[class*='icon-font']",
    ".iconfont", ".icon-font", "i[class*='icon']", "[class*='uolIcons']",
    "[class*='res-icon']", ".ms-Icon", ".ms-ContextualMenu-icon",
    ".ab-icon", ".mejs-controls *", ".vjs-control-bar *", ".mce-ico",
    ".google-symbols", ".google-symbols *", ".iconic",
    "[class*='defaultIcon']",
    // Protect nested glyph elements as well as site-specific icon wrappers.
    ".notification-icon", ".notification-icon *",
    ".tweet-top-icon", ".tweet-top-icon *",
  ];

  // Dedicated, always-on icon-font protection. These selectors complement
  // the SVG/image/icon-class exclusions above. They are based on recognizable
  // framework classes and explicit inline font-family names rather than
  // excluding every custom font (which would also block ordinary page text).
  //
  // Coverage is intentionally broad because icon glyphs are font characters:
  // changing their family can turn them into missing-glyph boxes or letters.
  // The list includes high-adoption families (Font Awesome, Dashicons,
  // Bootstrap Icons, IcoMoon, Material Icons, Simple Line Icons, Flaticon,
  // Ionicons, Genericons, Fontello, Themify, Remixicon) and other common packs.
  const ICON_FONT_EXCLUSIONS = [
    // Google Material Icons (legacy and style variants).
    ".material-icons",
    ".material-icons-outlined",
    ".material-icons-round",
    ".material-icons-sharp",
    ".material-icons-two-tone",
    '[class^="material-icons-"]',
    '[class*=" material-icons-"]',

    // Google Material Symbols (current icon-font family).
    ".material-symbols",
    ".material-symbols-outlined",
    ".material-symbols-rounded",
    ".material-symbols-sharp",
    '[class^="material-symbols-"]',
    '[class*=" material-symbols-"]',
    ".google-symbols",

    // WordPress Dashicons (one of the most widely deployed icon fonts).
    ".dashicons",
    '[class^="dashicons-"]', '[class*=" dashicons-"]',

    // TinyMCE classic icons and newer TinyMCE/Toast UI editor icon hooks.
    ".mce-ico", '[class^="mce-i-"]', '[class*=" mce-i-"]',
    ".tox-icon", ".tox-tbtn__icon", ".tox-collection__item-icon",

    // Font Awesome 4 through 7 class families and style aliases.
    ".fa", ".fas", ".far", ".fab", ".fal", ".fad", ".fat", ".fass",
    ".fa-solid", ".fa-regular", ".fa-brands", ".fa-light",
    ".fa-duotone", ".fa-thin", ".fa-sharp", ".fa-classic",
    '[class^="fa-"]', '[class*=" fa-"]',

    // Bootstrap Icons.
    ".bi", '[class^="bi-"]', '[class*=" bi-"]',

    // Glyphicons (Bootstrap 3 and older themes).
    ".glyphicon", '[class^="glyphicon-"]', '[class*=" glyphicon-"]',

    // Microsoft Fluent UI / Office Fabric and Windows icon fonts.
    ".ms-Icon", ".ms-ContextualMenu-icon",
    '[class^="ms-Icon--"]', '[class*=" ms-Icon--"]',
    ".fui-Icon", '[class*="fui-Icon"]',
    '[class*="FluentIcon"]',

    // Material Design Iconic Font (ZMDI).
    ".zmdi", '[class^="zmdi-"]', '[class*=" zmdi-"]',

    // Material Design Icons community webfont.
    ".mdi", '[class^="mdi-"]', '[class*=" mdi-"]',
    ".mdil", '[class^="mdil-"]', '[class*=" mdil-"]',

    // Ionicons legacy webfont.
    "ion-icon", ".ion", '[class^="ion-"]', '[class*=" ion-"]',

    // Simple Line Icons use the documented icon-* class family.
    '[class^="icon-"]', '[class*=" icon-"]',

    // IcoFont and Flaticon generated webfonts.
    ".icofont", '[class^="icofont-"]', '[class*=" icofont-"]',
    ".flaticon", '[class^="flaticon-"]', '[class*=" flaticon-"]',

    // Genericons and other WordPress ecosystem glyph fonts.
    ".genericon", '[class^="genericon-"]', '[class*=" genericon-"]',

    // Boxicons families.
    ".bx", ".bxs", ".bxl", ".bxf", ".bxr", ".bxrf", ".bxsf",
    ".bxd", ".bxrd", ".bxsd", '[class^="bx-"]', '[class*=" bx-"]',

    // Remix Icon.
    ".ri", '[class^="ri-"]', '[class*=" ri-"]',

    // Dripicons, Entypo and social-brand icon fonts.
    ".dripicons", '[class^="dripicons-"]', '[class*=" dripicons-"]',
    ".entypo", ".entypo-icon", '[class^="entypo-"]', '[class*=" entypo-"]',
    ".socicon", '[class^="socicon-"]', '[class*=" socicon-"]',
    ".zocial", '[class^="zocial-"]', '[class*=" zocial-"]',
    ".socialico", '[class^="socialico-"]', '[class*=" socialico-"]',

    // PrimeIcons.
    ".pi", '[class^="pi-"]', '[class*=" pi-"]',

    // WordPress page-builder / slider icon fonts.
    ".eicon", '[class^="eicon-"]', '[class*=" eicon-"]',
    ".et-pb-icon", ".revicon", '[class^="revicon-"]', '[class*=" revicon-"]',

    // Lineicons and Linearicons webfont class families.
    ".lni", '[class^="lni-"]', '[class*=" lni-"]',
    ".lnr", '[class^="lnr-"]', '[class*=" lnr-"]',

    // Popular component-library icon font hooks (mostly font-backed legacy
    // releases; current releases may render SVG, already covered by MEDIA).
    ".anticon", '[class^="anticon-"]', '[class*=" anticon-"]',
    '[class^="el-icon-"]', '[class*=" el-icon-"]',
    ".q-icon", ".v-icon", ".uk-icon",
    ".ck-icon", '[class^="ck-icon-"]', '[class*=" ck-icon-"]',
    ".fr-icon", '[class^="fr-icon-"]', '[class*=" fr-icon-"]',
    ".k-icon", '[class^="k-i-"]', '[class*=" k-i-"]',
    ".dx-icon", '[class^="dx-icon-"]', '[class*=" dx-icon-"]',
    ".e-icons", '[class*="e-icons"]',
    ".sapUiIcon", ".spectrum-Icon",

    // Other commonly deployed icon webfonts.
    ".octicon", '[class^="octicon-"]', '[class*=" octicon-"]',
    ".codicon", '[class^="codicon-"]', '[class*=" codicon-"]',
    ".uil", '[class^="uil-"]', '[class*=" uil-"]',
    ".pf", '[class^="pf-"]', '[class*=" pf-"]',
    ".pe-7s", '[class^="pe-7s-"]', '[class*=" pe-7s-"]',
    ".hgi", '[class^="hgi-"]', '[class*=" hgi-"]',
    ".typcn", '[class^="typcn-"]', '[class*=" typcn-"]',
    ".wi", '[class^="wi-"]', '[class*=" wi-"]',
    ".fi", '[class^="fi-"]', '[class*=" fi-"]',
    ".ti", '[class^="ti-"]', '[class*=" ti-"]',
    ".devicon", '[class^="devicon-"]', '[class*=" devicon-"]',
    ".la", '[class^="la-"]', '[class*=" la-"]',

    // Inline font-family declarations are useful when sites do not apply a
    // recognizable framework class to the icon element itself.
    '[style*="Material Icons" i]',
    '[style*="Material Symbols" i]',
    '[style*="Google Symbols" i]',
    '[style*="Font Awesome" i]',
    '[style*="Dashicons" i]',
    '[style*="TinyMCE" i]',
    '[style*="Simple Line Icons" i]',
    '[style*="Flaticon" i]',
    '[style*="Genericons" i]',
    '[style*="Icofont" i]',
    '[style*="Dripicons" i]',
    '[style*="Entypo" i]',
    '[style*="Socicon" i]',
    '[style*="Zocial" i]',
    '[style*="Unicons" i]',
    '[style*="PaymentFont" i]',
    '[style*="Codicons" i]',
    '[style*="Stroke 7" i]',
    '[style*="Bootstrap Icons" i]',
    '[style*="bootstrap-icons" i]',
    '[style*="Material Design Icons" i]',
    '[style*="materialdesignicons" i]',
    '[style*="Ionicons" i]',
    '[style*="boxicons" i]',
    '[style*="remixicon" i]',
    '[style*="PrimeIcons" i]',
    '[style*="Segoe MDL2 Assets" i]',
    '[style*="Segoe Fluent Icons" i]',
    '[style*="Segoe UI Symbol" i]',
    '[style*="FabricMDL2Icons" i]',
    '[style*="FluentSystemIcons" i]',
    '[style*="Octicons" i]',
    '[style*="Typicons" i]',
    '[style*="Weather Icons" i]',
    '[style*="IcoMoon" i]',
    '[style*="Fontello" i]',
  ];

  // Site-specific icon, control, and typography exceptions supplied for this
  // profile. Kept separate from the framework-wide icon list so the panel can
  // enable/disable the complete page exception set with one persistent toggle.
  // Exact duplicates are removed when the CSS selector is assembled.
  const PAGE_SPECIFIC_EXCLUSIONS = [
    // IcoFont and other recognizable webfont/icon classes.
    '[class*=" icofont-"]',
    '[class^="icofont-"]',
    '[class*="icofont-"]',
    '.ph-arrow-up-right.ph',
    '.ph-clock-afternoon.ph',
    '.ph-chat-circle.ph',
    '.ph-calendar-dots.ph',
    '.ph-bold',
    '.mico-home.mico',
    '.noticon-top.noticon',
    '.tweet-self-thread-line-dots',
    '.glyphicon-globe',
    '.i-edit',
    '.jetpack-contact-form-icon',
    '.icon-mail',
    '.icon-whatsapp',
    '.icon-email',
    '.icon-access-no',
    '.icon-burger',
    '.icon-lock-open',
    '[class*="icon-share-"]',
    '[class*="uolIcons"]',
    '.res-icon',
    '.WO9bab',
    '.iconfont',
    '.google-symbols',
    '.fa-icon .bwi-lg',
    '.fa-solid',
    'fa-icon',
    'fa-icon .lia-fa-icon',
    '.lia-fa-times',
    '[class*="fa-"]',
    '[class*="icon-"]',
    '[class*="defaultIcon"]',
    '[class*="glyphicon"]',
    '[id*="glyphicon"]',

    // Search, navigation, notifications, and theme-specific UI.
    '.gPI1Ge',
    '.titlebar-buttonbox *',
    '.ipsQuote_citation > [href="#"]',
    '.user-link.ruser.ruser-bottom > .line',
    '.user-link.ruser.ruser-top > .line',
    '.iconic.ghost.change-spinner',
    '.iconic.ghost * .ab-item > .ab-icon',
    '.ab-icon',
    '.notification-icon',
    '.od-freeTrial-giftBoxIcon',
    '.see-all-link',
    '[aria-label="Clear search"]',
    '[aria-label="Advanced search"]',
    '#search_button',
    '#search-replace-dialog [data-type="actions"] *',
    '.js-search-button.search__button',

    // Media-player/editor controls and their glyph elements.
    '.mejs-controls *',
    '.vjs-control-bar *',
    '.mce-ico',

    // Preserve explicitly requested emphasis elements as well.
    'strong',
    'b',

    // Framework-specific icon elements not already covered by the generic list.
    '.material-symbols',
    '.material-symbols-outlined',
    '[class*="material-icons"]',
    '.ms-Icon',
    '.ms-ContextualMenu-icon',
    '.dashicons',
    '.fa',
    '.icon',
  ];

  const UI_EXTRA_EXCLUSIONS = [
    // Firefox renders every HTML <select> option list in a shared chrome popup
    // outside the originating panel. Keep that native popup out of the global
    // interface-font rule so the Font Changer's font dropdown retains its
    // normal, browser-native appearance while the Apply button is restyled.
    "#ContentSelectDropdown",
    "#ContentSelectDropdown *",
    "menupopup image", "toolbarbutton image",
    "toolbarbutton .toolbarbutton-badge", ".tab-close-button",
    ".urlbarView-type-icon", ".urlbarView-favicon", ".urlbarView-button",
    ".searchbar-search-icon", ".searchbar-search-button",
    "#identity-box image", "#page-action-buttons image",
    ".urlbar-page-action", ".tab-icon-stack", ".tab-icon-image",
    ".toolbarbutton-1 > .toolbarbutton-icon",
    `#${PANEL_ID}`,
    `#${PANEL_ID} *`,
  ];

  const log = (...args) => {
    if (DEBUG) console.log(`${PREFIX} [${new Date().toLocaleTimeString()}]`, ...args);
  };
  const warn = (...args) => console.warn(PREFIX, ...args);
  const error = (...args) => console.error(PREFIX, ...args);

  log("Starting", VERSION, document.documentURI);

  // ========================================================================
  // Replace a previous v6 instance; remove earlier floating panels and styles
  // ========================================================================

  try {
    window[RUNTIME_KEY]?.cleanup?.();
  } catch (err) {
    warn("Previous v6 cleanup failed:", err);
  }

  // Clean up earlier versions when their runtime is still exposed.
  for (const key of [
    "__ucFontChangerRuntime_v5",
    "__ucFontChangerRuntime_v4",
    "__ucFontChangerRuntime_v3",
    "__ucFontChangerDebug",
    "__ucFontChangerLibraryV4",
    "__ucFontChangerDirectHotkeyFix",
    "__ucFontChangerPanelIsolation",
  ]) {
    try {
      if (key !== "__ucFontChangerDebug" || window[key]?.version) {
        window[key]?.cleanup?.();
      }
    } catch (err) {
      warn("Previous runtime cleanup failed:", key, err);
    }
  }

  // Remove stale popup/keyset nodes from previous iterations.
  for (const id of [
    "uc-font-changer-panel",
    "uc-font-changer-panel-v4",
    "uc-font-changer-panel-v5",
    "uc-font-changer-panel-v6",
    "uc-font-changer-keyset",
    "uc-font-changer-hotkey",
    "uc-font-changer-ui-style",
    "uc-font-changer-ui-style-v4",
    "uc-font-changer-ui-style-v5",
    "uc-font-changer-ui-style-v6",
  ]) {
    try {
      document.getElementById(id)?.remove();
    } catch (_) {}
  }

  // The original v2 script registered Ctrl+Alt+F and did not retain a removable
  // handler reference. Its old handler may remain until this browser window is
  // closed. The legacy-chord suppressor below neutralizes that shortcut.
  window.__ucFontChangerLoaded = true;

  // ========================================================================
  // Privileged Gecko services (works when pasted into Browser Console)
  // ========================================================================

  const Cc = Components.classes;
  const Ci = Components.interfaces;

  let prefs;
  let io;
  let sheetService;
  let fontEnumerator;

  try {
    prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
    io = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);
    sheetService = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    fontEnumerator = Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator);
    log("XPCOM services initialized.");
    log("Icon-font preservation selectors loaded:", ICON_FONT_EXCLUSIONS.length);
    log("Site-specific page exceptions loaded:", PAGE_SPECIFIC_EXCLUSIONS.length);
  } catch (err) {
    error("Could not initialize Firefox services:", err);
    throw err;
  }

  // ========================================================================
  // Runtime state and helpers
  // ========================================================================

  let settings;
  let installedFonts = [];
  let panel = null;
  let controls = null;
  let writingPrefs = false;
  let refreshPending = false;
  let cleanedUp = false;
  let dragState = null;
  let resizeHandler = null;
  let selectedLibraryFont = "";
  // A committed font change must also become the System Font library's
  // selection. Keep this one-shot value until refreshPanel() has rebuilt the
  // controls, so search/bookmark filters cannot silently restore an older font.
  let pendingLibrarySelectionSync = "";

  // Character type-ahead follows the familiar native-select/listbox model:
  // one letter jumps to the next matching font; repeated letters cycle among
  // fonts beginning with that letter; rapid different letters form a prefix.
  const TYPEAHEAD_TIMEOUT_MS = 850;
  const typeaheadState = new WeakMap();

  function handleFontTypeahead(event, target, names, currentName, onMatch) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      typeof event.key !== "string" ||
      Array.from(event.key).length !== 1 ||
      event.key.trim() === ""
    ) {
      return false;
    }

    const character = event.key.toLocaleLowerCase();
    const now = Date.now();
    const previous = typeaheadState.get(target);
    const withinWindow = previous && now - previous.time <= TYPEAHEAD_TIMEOUT_MS;

    // Repeated identical single-letter presses cycle instead of building
    // "ccc". Different letters typed quickly build a multi-character prefix.
    let prefix = !withinWindow
      ? character
      : previous.prefix.length === 1 && previous.prefix === character
        ? character
        : previous.prefix + character;

    const findNext = candidatePrefix => {
      if (!names.length) return -1;

      const currentKey = String(currentName || "").toLocaleLowerCase();
      const currentIndex = names.findIndex(
        name => name.toLocaleLowerCase() === currentKey
      );

      // When several different characters form a longer prefix (e.g. C then A),
      // retain the current item if it already matches the completed prefix.
      // Repeated single characters deliberately skip the current item to cycle.
      if (candidatePrefix.length > 1 && currentIndex >= 0 && currentKey.startsWith(candidatePrefix)) {
        return currentIndex;
      }

      for (let offset = 1; offset <= names.length; offset++) {
        const index = (currentIndex + offset + names.length) % names.length;
        if (names[index].toLocaleLowerCase().startsWith(candidatePrefix)) {
          return index;
        }
      }

      return -1;
    };

    let matchIndex = findNext(prefix);

    // If a multi-character sequence has no match, fall back to the most
    // recent character. This keeps the picker responsive rather than getting
    // stuck with an impossible prefix.
    if (matchIndex < 0 && prefix !== character) {
      prefix = character;
      matchIndex = findNext(prefix);
    }

    typeaheadState.set(target, { prefix, time: now });

    if (matchIndex < 0) return false;

    event.preventDefault();
    onMatch(names[matchIndex]);
    return true;
  }

  function element(tag, className = "", text = undefined) {
    const node = document.createElementNS(XHTML_NS, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className = "") {
    const node = element("button", className, label);
    node.type = "button";
    return node;
  }

  function cleanFontName(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 120);
  }

  function normalizeNames(values) {
    const seen = new Set();
    const output = [];
    for (const item of values || []) {
      const name = cleanFontName(item);
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      output.push(name);
    }
    return output;
  }

  function sortFonts(values) {
    return normalizeNames(values).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  }

  // Every font is handled uniformly. The former hard-coded “built-in/protected”
  // category is gone; availability comes from Gecko's installed-font enumerator.
  function normalizeCustomFonts(values) {
    return normalizeNames(values);
  }

  function cssString(value) {
    return '"' + String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n\f]/g, " ") + '"';
  }

  // ========================================================================
  // Preferences
  // ========================================================================

  function parseArrayPref(name) {
    try {
      const raw = prefs.getStringPref(PREF_ROOT + name, "");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      warn("Could not read preference array:", name, err);
      return null;
    }
  }

  function readSettings() {
    let customFonts = parseArrayPref("customFonts");

    // Migrate the previous favorites list if this is an older profile.
    if (customFonts === null) {
      customFonts = normalizeCustomFonts(parseArrayPref("favorites") || []);
      writingPrefs = true;
      try {
        prefs.setStringPref(PREF_ROOT + "customFonts", JSON.stringify(customFonts));
      } finally {
        writingPrefs = false;
      }
    } else {
      customFonts = normalizeCustomFonts(customFonts);
    }

    const font = cleanFontName(
      prefs.getStringPref(PREF_ROOT + "font", DEFAULT_FONT)
    ) || DEFAULT_FONT;

    if (!customFonts.some(x => x.toLocaleLowerCase() === font.toLocaleLowerCase())) {
      customFonts.push(font);
    }

    // Separate interface fonts are opt-in. Existing profiles therefore keep
    // the previous behavior: one selected font is shared by pages and UI.
    const separateInterfaceFont = prefs.getBoolPref(
      PREF_ROOT + "separateInterfaceFont",
      false
    );
    const interfaceFont = cleanFontName(
      prefs.getStringPref(PREF_ROOT + "interfaceFont", font)
    ) || font;

    return {
      font,
      interfaceFont,
      separateInterfaceFont,
      customFonts,
      bookmarks: sortFonts(parseArrayPref("bookmarks") || []),
      pages: prefs.getBoolPref(PREF_ROOT + "pages", true),
      interface: prefs.getBoolPref(PREF_ROOT + "interface", true),
      // Enabled by default so existing profiles keep all current icon guards
      // and also receive the expanded site-specific exception set.
      protectPageExceptions: false,
    };
  }

  function saveSettings() {
    writingPrefs = true;
    try {
      prefs.setStringPref(PREF_ROOT + "font", settings.font);
      prefs.setStringPref(PREF_ROOT + "interfaceFont", settings.interfaceFont || settings.font);
      prefs.setBoolPref(PREF_ROOT + "separateInterfaceFont", !!settings.separateInterfaceFont);
      prefs.setStringPref(PREF_ROOT + "customFonts", JSON.stringify(normalizeCustomFonts(settings.customFonts)));
      prefs.setStringPref(PREF_ROOT + "bookmarks", JSON.stringify(sortFonts(settings.bookmarks)));
      prefs.setBoolPref(PREF_ROOT + "pages", settings.pages);
      prefs.setBoolPref(PREF_ROOT + "interface", settings.interface);
      prefs.setBoolPref(PREF_ROOT + "protectPageExceptions", false);
    } catch (err) {
      error("Could not save settings:", err);
    } finally {
      writingPrefs = false;
    }
    settings = readSettings();
    applyAll();
  }

  function readSavedPosition() {
    try {
      const raw = prefs.getStringPref(POSITION_PREF, "");
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!Number.isFinite(value.left) || !Number.isFinite(value.top)) return null;
      return value;
    } catch (_) {
      return null;
    }
  }

  function savePosition() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    try {
      prefs.setStringPref(POSITION_PREF, JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      }));
    } catch (err) {
      warn("Could not save panel position:", err);
    }
  }

  // ========================================================================
  // Installed system fonts
  // ========================================================================

  function enumerateInstalledFonts() {
    let result;
    try {
      result = fontEnumerator.EnumerateAllFonts();
    } catch (firstError) {
      warn("Trying legacy font enumeration signature:", firstError);
      result = fontEnumerator.EnumerateAllFonts({});
    }
    const names = sortFonts(Array.from(result || []).filter(x => typeof x === "string"));
    if (!names.length) throw new Error("Firefox returned no installed font families.");
    return names;
  }

  try {
    installedFonts = enumerateInstalledFonts();
    log(`Detected ${installedFonts.length} installed font families.`);
  } catch (err) {
    warn("Font enumeration failed; saved and custom fonts remain available:", err);
  }

  // Seed the former default-font choices into Bookmarks only when Gecko confirms
  // that each family is installed. A processed-name preference prevents a user
  // who later removes a bookmark from having it silently re-added. If a font is
  // installed in the future, the next refresh will seed it once at that point.
  function seedAvailableDefaultBookmarks() {
    if (!settings || !installedFonts.length) return 0;
    let processed = [];
    try {
      const raw = prefs.getStringPref(PREF_ROOT + "defaultBookmarkCandidatesProcessed", "[]");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) processed = normalizeNames(parsed);
    } catch (_) {}

    const processedKeys = new Set(processed.map(x => x.toLocaleLowerCase()));
    const installedByKey = new Map(installedFonts.map(name => [name.toLocaleLowerCase(), name]));
    const bookmarkKeys = new Set(settings.bookmarks.map(name => name.toLocaleLowerCase()));
    let added = 0;

    for (const candidate of DEFAULT_BOOKMARK_FONTS) {
      const key = candidate.toLocaleLowerCase();
      const actualName = installedByKey.get(key);
      if (!actualName || processedKeys.has(key)) continue;
      processedKeys.add(key);
      if (!bookmarkKeys.has(key)) {
        settings.bookmarks.push(actualName);
        bookmarkKeys.add(key);
        added++;
      }
    }

    if (added || processedKeys.size !== processed.length) {
      writingPrefs = true;
      try {
        prefs.setStringPref(PREF_ROOT + "defaultBookmarkCandidatesProcessed", JSON.stringify([...processedKeys]));
        prefs.setStringPref(PREF_ROOT + "bookmarks", JSON.stringify(sortFonts(settings.bookmarks)));
      } finally {
        writingPrefs = false;
      }
      settings.bookmarks = sortFonts(settings.bookmarks);
      if (added) log(`Automatically bookmarked ${added} available default font(s).`);
    }
    return added;
  }

  // ========================================================================
  // CSS generation — Context Menu Editor inspired theme
  // ========================================================================

  function buildSelector(exclusions = [], includeSiteSpecific = false) {
    // Icon protection is unconditional: there is no parameter or UI option
    // that can disable it. Only the old, broader site-specific typography
    // exceptions remain opt-in/dormant so normal bold text still changes.
    const protectedSelectors = [
      ...ICON_EXCLUSIONS,
      ...ICON_FONT_EXCLUSIONS,
      ...(includeSiteSpecific ? PAGE_SPECIFIC_EXCLUSIONS : []),
    ];
    const allExclusions = [...new Set([
      ...MEDIA_EXCLUSIONS,
      ...protectedSelectors,
      ...exclusions,
    ])];

    return "*:not(" + allExclusions.join("):not(") + ")";
  }

  function buildPageCSS() {
    const selector = buildSelector();
    // USER_SHEET + !important is intentional. It outranks ordinary page-author
    // font declarations. Root coverage is deliberate: some userscripts append
    // elements directly to <html>, outside <body> (for example Google's Gbar).
    // Because this is a document stylesheet rather than a
    // one-time DOM walk, it automatically matches elements inserted later by
    // page JavaScript. No MutationObserver is needed for ordinary DOM nodes.
    // Shadow roots and accessible iframe documents are handled by the separate
    // integration below.
    return `
      @-moz-document
        url-prefix("http://"),
        url-prefix("https://"),
        url-prefix("file://"),
        url-prefix("about:"),
        url-prefix("moz-extension://"),
        url-prefix("data:"),
        url-prefix("blob:") {
          html, body, html ${selector} {
            font-family: ${cssString(settings.font)}, sans-serif !important;
          }
      }
    `;
  }

  function buildPanelCSS() {
    return `
      #${PANEL_ID} {
        color-scheme: light dark;
        --fc-panel-bg: Canvas;
        --fc-panel-fg: CanvasText;
        --fc-surface-bg: Field;
        --fc-input-bg: Field;
        --fc-input-fg: FieldText;
        --fc-input-border: rgba(128,128,128,.55);
        --fc-button-bg: ButtonFace;
        --fc-button-border: rgba(128,128,128,.35);
        --fc-panel-border: rgba(128,128,128,.35);
        --fc-header-bg: Canvas;
        --fc-header-fg: CanvasText;

        position: fixed !important;
        left: 50%;
        top: 50%;
        right: auto;
        bottom: auto;
        transform: translate(-50%, -50%);

        display: none;
        flex-direction: column;
        gap: 8px;
        box-sizing: border-box;
        width: min(480px, calc(100vw - 32px));
        max-height: min(88vh, 920px);
        padding: 10px;
        overflow: hidden;

        border: 1px solid var(--fc-panel-border);
        border-radius: 10px;
        background: var(--fc-panel-bg);
        color: var(--fc-panel-fg);
        box-shadow: 0 16px 48px rgba(0,0,0,.42), 0 2px 8px rgba(0,0,0,.18);

        font: message-box;
        font-size: 13px;
        line-height: 1.3;
        z-index: 2147483000;
      }

      #${PANEL_ID}.is-open { display: flex !important; }
      #${PANEL_ID}.is-moving { user-select: none; }

      #${PANEL_ID} *,
      #${PANEL_ID} *::before,
      #${PANEL_ID} *::after { box-sizing: border-box; }

      #${PANEL_ID} button,
      #${PANEL_ID} input,
      #${PANEL_ID} select { font: inherit; }

      #${PANEL_ID} .fc-titlebar {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 42px;
        padding: 6px 7px 6px 10px;
        border: 1px solid var(--fc-panel-border);
        border-radius: 7px;
        background: var(--fc-header-bg);
        color: var(--fc-header-fg);
        cursor: grab;
        user-select: none;
        touch-action: none;
      }

      #${PANEL_ID} .fc-titlebar:active { cursor: grabbing; }
      #${PANEL_ID} .fc-title-group {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex: 1 1 auto;
        min-width: 0;
      }
      #${PANEL_ID} .fc-title { font-size: 15px; font-weight: 700; white-space: nowrap; }
      #${PANEL_ID} .fc-subtitle {
        overflow: hidden;
        color: color-mix(in srgb, var(--fc-panel-fg) 58%, transparent);
        font-size: 10px;
        letter-spacing: .07em;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PANEL_ID} .fc-close {
        display: inline-flex;
        flex: 0 0 28px;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        min-width: 28px;
        min-height: 28px;
        margin: 0;
        padding: 0;
        appearance: none;
        -moz-appearance: none;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-family: Arial, sans-serif;
        font-size: 18px;
        font-weight: 400;
        line-height: 1;
        text-align: center;
        cursor: pointer;
      }
      #${PANEL_ID} .fc-close:hover {
        border-color: rgba(220,80,90,.35);
        background: rgba(220,80,90,.16);
      }

      #${PANEL_ID} .fc-body {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 9px;
        min-height: 0;
        overflow: auto;
        padding: 1px 2px 2px;
        scrollbar-width: thin;
      }

      #${PANEL_ID} .fc-section {
        display: flex;
        flex-direction: column;
        gap: 7px;
        min-width: 0;
        padding: 10px;
        border: 1px solid var(--fc-panel-border);
        border-radius: 8px;
        background: color-mix(in srgb, var(--fc-surface-bg) 26%, transparent);
      }

      #${PANEL_ID} .fc-section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        min-height: 17px;
      }
      #${PANEL_ID} .fc-section-title {
        color: color-mix(in srgb, var(--fc-panel-fg) 68%, transparent);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .07em;
        text-transform: uppercase;
      }
      #${PANEL_ID} .fc-section-note {
        color: color-mix(in srgb, var(--fc-panel-fg) 48%, transparent);
        font-size: 10px;
      }

      #${PANEL_ID} .fc-targets {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      #${PANEL_ID} .fc-target {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 32px;
        padding: 5px 8px;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-input-bg);
        color: var(--fc-input-fg);
        font-size: 12px;
      }
      #${PANEL_ID} .fc-target input { margin: 0; }
      #${PANEL_ID} .fc-target-wide { grid-column: 1 / -1; }

      #${PANEL_ID} select,
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="search"] {
        width: 100%;
        min-width: 0;
        min-height: 30px;
        padding: 5px 7px;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-input-bg);
        color: var(--fc-input-fg);
      }
      #${PANEL_ID} select:focus-visible,
      #${PANEL_ID} input:focus-visible,
      #${PANEL_ID} button:focus-visible {
        outline: 1px solid Highlight;
        outline-offset: 1px;
      }

      #${PANEL_ID} .fc-font-select-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px;
        gap: 6px;
        align-items: stretch;
      }
      /* Keep the bookmark button exactly as tall as the selected-font roll. */
      #${PANEL_ID} .fc-font-select-row > select,
      #${PANEL_ID} .fc-font-select-row > .fc-selected-font-bookmark {
        height: 34px;
        min-height: 34px;
        max-height: 34px;
        box-sizing: border-box;
      }
      #${PANEL_ID} .fc-selected-font-bookmark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        margin: 0;
        padding: 0;
        font-size: 18px;
        line-height: 1;
      }
      #${PANEL_ID} .fc-selected-font-bookmark.is-bookmarked { color: #e5b83f; }
      #${PANEL_ID} .fc-selected-font-bookmark[hidden] { display: none !important; }
      #${PANEL_ID} .fc-preview {
        min-height: 39px;
        padding: 8px 9px;
        overflow-wrap: anywhere;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-surface-bg);
        color: var(--fc-panel-fg);
        font-size: 19px;
        line-height: 1.25;
      }
      #${PANEL_ID} .fc-separate-toggle {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 30px;
        padding: 5px 8px;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-input-bg);
        color: var(--fc-input-fg);
        font-size: 12px;
        cursor: pointer;
      }
      #${PANEL_ID} .fc-separate-toggle input { margin: 0; }
      #${PANEL_ID} .fc-interface-font-picker {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #${PANEL_ID} .fc-interface-font-picker[hidden],
      #${PANEL_ID} [hidden] { display: none !important; }
      #${PANEL_ID} .fc-interface-preview {
        min-height: 32px;
        padding: 6px 8px;
        overflow-wrap: anywhere;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-surface-bg);
        color: var(--fc-panel-fg);
        font-size: 16px;
        line-height: 1.25;
      }

      /* Keep the shared button treatment identical to Context Menu Editor:
         same dimensions, border, radius, theme tokens and interaction states. */
      #${PANEL_ID} button {
        min-height: 25px;
        padding: 3px 8px;
        border: 1px solid var(--fc-button-border);
        border-radius: 5px;
        background: var(--fc-button-bg);
        color: inherit;
        cursor: pointer;
      }
      #${PANEL_ID} button:hover:not(:disabled) {
        filter: brightness(.95);
      }
      #${PANEL_ID} button:active:not(:disabled) {
        filter: brightness(.9);
      }
      #${PANEL_ID} button:disabled {
        cursor: default;
        opacity: .45;
      }

      #${PANEL_ID} .fc-lib-row {
        display: grid;
        grid-template-columns: minmax(0,1fr) 112px;
        gap: 6px;
      }
      #${PANEL_ID} .fc-font-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        height: 152px;
        min-height: 100px;
        overflow: auto;
        padding: 4px;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-input-bg);
        scrollbar-width: thin;
        outline-offset: 2px;
      }
      #${PANEL_ID} .fc-font-list:focus-visible {
        outline: 1px solid Highlight;
        outline-offset: 2px;
      }
      #${PANEL_ID} .fc-font-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 30px;
        align-items: center;
        gap: 4px;
        min-height: 28px;
        border: 1px solid transparent;
        border-radius: 4px;
      }
      #${PANEL_ID} .fc-font-row.is-selected {
        border-color: color-mix(in srgb, Highlight 45%, transparent);
        background: color-mix(in srgb, Highlight 17%, transparent);
      }
      #${PANEL_ID} .fc-font-name {
        display: block;
        width: 100%;
        min-width: 0;
        min-height: 27px;
        padding: 4px 7px;
        overflow: hidden;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--fc-input-fg);
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }
      #${PANEL_ID} .fc-font-name:hover {
        background: color-mix(in srgb, var(--fc-panel-fg) 9%, transparent);
      }
      #${PANEL_ID} .fc-font-star {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 27px;
        min-width: 27px;
        min-height: 26px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: color-mix(in srgb, var(--fc-panel-fg) 62%, transparent);
        font-size: 17px;
        line-height: 1;
      }
      #${PANEL_ID} .fc-font-star.is-bookmarked {
        color: #e5b83f;
      }
      #${PANEL_ID} .fc-font-star:hover {
        background: color-mix(in srgb, var(--fc-panel-fg) 10%, transparent);
      }
      #${PANEL_ID} .fc-font-empty {
        padding: 16px 8px;
        color: color-mix(in srgb, var(--fc-panel-fg) 55%, transparent);
        text-align: center;
        font-size: 11px;
      }
      #${PANEL_ID} .fc-lib-meta {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        color: color-mix(in srgb, var(--fc-panel-fg) 54%, transparent);
        font-size: 10px;
      }
      #${PANEL_ID} .fc-lib-preview {
        min-height: 54px;
        padding: 9px;
        overflow-wrap: anywhere;
        border: 1px solid var(--fc-input-border);
        border-radius: 5px;
        background: var(--fc-surface-bg);
        color: var(--fc-panel-fg);
        font-size: 19px;
        line-height: 1.3;
      }
      #${PANEL_ID} .fc-note {
        margin: 0;
        color: color-mix(in srgb, var(--fc-panel-fg) 50%, transparent);
        font-size: 10px;
      }
      /* Footer mirrors Context Menu Editor's status / spacer / action layout.
         Save is bold; Apply Font uses the same weight and shared button rules. */
      #${PANEL_ID} .fc-footer {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        min-height: 29px;
        padding-top: 2px;
        line-height: 1.25;
      }
      #${PANEL_ID} .fc-footer-hint {
        min-width: 0;
        max-width: 70%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: .68;
        font-size: 11px;
      }
      #${PANEL_ID} .fc-footer-spacer {
        flex: 1;
      }
      #${PANEL_ID} .fc-footer .fc-apply {
        font-weight: 700;
      }

      #${PANEL_ID}.is-moving,
      #${PANEL_ID}.is-moving * { user-select: none !important; }

      @media (prefers-color-scheme: dark) {
        #${PANEL_ID} {
          color-scheme: dark;
          --fc-panel-bg: #202126;
          --fc-panel-fg: #f0f1f4;
          --fc-surface-bg: #17181c;
          --fc-input-bg: #141519;
          --fc-input-fg: #f0f1f4;
          --fc-input-border: rgba(255,255,255,.27);
          --fc-button-bg: #303238;
          --fc-button-border: rgba(255,255,255,.2);
          --fc-panel-border: rgba(255,255,255,.2);
          --fc-header-bg: #090a0c;
          --fc-header-fg: #f5f6f7;
        }
      }

      @media (prefers-color-scheme: light) {
        #${PANEL_ID} {
          color-scheme: light;
          --fc-panel-bg: #f7f7f9;
          --fc-panel-fg: #202124;
          --fc-surface-bg: #ffffff;
          --fc-input-bg: #ffffff;
          --fc-input-fg: #202124;
          --fc-input-border: rgba(32,33,36,.28);
          --fc-button-bg: #eceef1;
          --fc-button-border: rgba(32,33,36,.2);
          --fc-panel-border: rgba(32,33,36,.22);
          --fc-header-bg: #ffffff;
          --fc-header-fg: #202124;
        }
      }

      @media (max-height: 650px) {
        #${PANEL_ID} { max-height: calc(100vh - 16px); }
        #${PANEL_ID} .fc-font-list { height: 110px; }
      }
    `;
  }

  function interfaceFontValue() {
    return settings.separateInterfaceFont
      ? (settings.interfaceFont || settings.font)
      : settings.font;
  }

  function buildInterfaceCSS() {
    // These exclusions are important: neither panel controls nor its contents
    // receive the global browser-interface font. Preview samples opt in below.
    // Browser chrome keeps the existing framework protections, but page-only
    // selectors (Google bar, website widgets, etc.) do not leak into UI CSS.
    const selector = buildSelector(UI_EXTRA_EXCLUSIONS, false);
    const fontRule = settings.interface
      ? `${selector} { font-family: ${cssString(interfaceFontValue())}, sans-serif !important; }`
      : "";
    return fontRule + buildPanelCSS();
  }

  // Generic extension-toolbar tooltips are not always normal DOM nodes.
  // Gecko may create the default tooltip as document-level native-anonymous
  // content, which can escape the ordinary author stylesheet injected into
  // browser.xhtml. A separate AGENT_SHEET is the established way to style it.
  // Keep this stylesheet narrowly scoped to XUL tooltip elements so it does
  // not change extension popup pages or ordinary webpage content.
  function buildTooltipAgentCSS() {
    return `
      @namespace xul url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");

      xul|tooltip,
      xul|tooltip[default="true"],
      xul|tooltip[page="true"],
      xul|tooltip:-moz-native-anonymous,
      xul|tooltip > xul|description.tooltip-label,
      xul|tooltip[default="true"] > xul|description.tooltip-label,
      xul|tooltip[page="true"] > xul|description.tooltip-label,
      xul|tooltip > xul|label.tooltip-label,
      xul|tooltip .tooltip-label,
      xul|tooltip:-moz-native-anonymous > xul|description.tooltip-label,
      xul|tooltip:-moz-native-anonymous > xul|label.tooltip-label,
      xul|tooltip:-moz-native-anonymous .tooltip-label,
      xul|tooltip#aHTMLTooltip,
      xul|tooltip#remoteBrowserTooltip,
      xul|tooltip#tabbrowser-tab-tooltip,
      xul|tooltip#back-button-tooltip,
      xul|tooltip#forward-button-tooltip,
      xul|tooltip#dynamic-shortcut-tooltip {
        font-family: ${cssString(interfaceFontValue())}, sans-serif !important;
      }
    `;
  }

  // ========================================================================
  // Stylesheet application
  // ========================================================================

  function makeSheetURI(css) {
    return io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(css));
  }

  function getActiveTooltipSheetSpec() {
    return prefs.getStringPref(ACTIVE_TOOLTIP_SHEET_PREF, "");
  }

  function unregisterActiveTooltipAgentSheet() {
    const oldSpec = getActiveTooltipSheetSpec();
    if (!oldSpec) return;

    try {
      const oldURI = io.newURI(oldSpec);
      if (sheetService.sheetRegistered(oldURI, sheetService.AGENT_SHEET)) {
        sheetService.unregisterSheet(oldURI, sheetService.AGENT_SHEET);
      }
    } catch (err) {
      error("Could not unregister previous tooltip agent stylesheet:", err);
    }

    prefs.setStringPref(ACTIVE_TOOLTIP_SHEET_PREF, "");
  }

  function applyTooltipAgentStyle() {
    if (!settings.interface) {
      unregisterActiveTooltipAgentSheet();
      log("Tooltip font styling disabled with Firefox interface fonts.");
      return;
    }

    try {
      const uri = makeSheetURI(buildTooltipAgentCSS());
      const activeSpec = getActiveTooltipSheetSpec();

      if (
        activeSpec === uri.spec &&
        sheetService.sheetRegistered(uri, sheetService.AGENT_SHEET)
      ) {
        return;
      }

      unregisterActiveTooltipAgentSheet();
      sheetService.loadAndRegisterSheet(uri, sheetService.AGENT_SHEET);
      prefs.setStringPref(ACTIVE_TOOLTIP_SHEET_PREF, uri.spec);

      log("Native XUL tooltip font agent stylesheet registered:", interfaceFontValue());
    } catch (err) {
      error("Tooltip agent stylesheet registration failed:", err);
    }
  }

  function getActiveSheetSpec() {
    return prefs.getStringPref(ACTIVE_SHEET_PREF, "");
  }

  function unregisterActiveContentSheet() {
    const oldSpec = getActiveSheetSpec();
    if (!oldSpec) return;

    try {
      const oldURI = io.newURI(oldSpec);
      if (sheetService.sheetRegistered(oldURI, sheetService.USER_SHEET)) {
        sheetService.unregisterSheet(oldURI, sheetService.USER_SHEET);
      }
    } catch (err) {
      error("Could not unregister previous page stylesheet:", err);
    }

    prefs.setStringPref(ACTIVE_SHEET_PREF, "");
  }

  function applyPageStyle() {
    if (!settings.pages) {
      unregisterActiveContentSheet();
      log("Page styling disabled.");
      return;
    }

    try {
      const uri = makeSheetURI(buildPageCSS());
      if (
        getActiveSheetSpec() === uri.spec &&
        sheetService.sheetRegistered(uri, sheetService.USER_SHEET)
      ) {
        return;
      }

      unregisterActiveContentSheet();
      sheetService.loadAndRegisterSheet(uri, sheetService.USER_SHEET);
      prefs.setStringPref(ACTIVE_SHEET_PREF, uri.spec);
      log("Page stylesheet registered.");
    } catch (err) {
      error("Page stylesheet application failed:", err);
    }
  }

  function applyInterfaceStyle() {
    try {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElementNS(XHTML_NS, "style");
        style.id = STYLE_ID;
        style.setAttribute("type", "text/css");
        document.documentElement.appendChild(style);
      }
      style.textContent = buildInterfaceCSS();
      log("Interface stylesheet updated; font panel excluded.");
    } catch (err) {
      error("Interface stylesheet application failed:", err);
    }

    // Must be registered separately as an AGENT_SHEET: generic toolbar
    // tooltips can be document-level native-anonymous content and are not
    // reliably affected by the style element above.
    applyTooltipAgentStyle();
  }

  // ========================================================================
  // Immediate style flush / redraw
  //
  // nsIStyleSheetService applies USER_SHEET registrations synchronously to
  // existing documents. After replacing the sheet, force a computed-style
  // read on the selected tab (which flushes pending style/layout work), then
  // ask Gecko to redraw that content window immediately. This avoids leaving
  // the visible tab waiting for a later incidental layout/paint.
  // ========================================================================

  function getWindowUtils(targetWindow) {
    try {
      if (targetWindow.windowUtils) {
        return targetWindow.windowUtils;
      }
    } catch (_) {}

    try {
      return targetWindow
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils);
    } catch (err) {
      warn("Could not obtain nsIDOMWindowUtils:", err);
      return null;
    }
  }

  function flushDocumentStyles(targetWindow, label) {
    try {
      if (!targetWindow || targetWindow.closed) return false;

      const doc = targetWindow.document;
      const root = doc?.documentElement;
      if (!root) return false;

      const probe = doc.body || root;

      // getComputedStyle + geometry read synchronously flushes style/layout.
      const computedFont = targetWindow.getComputedStyle(probe).fontFamily;
      void root.getBoundingClientRect();

      const utils = getWindowUtils(targetWindow);
      if (utils && typeof utils.redraw === "function") {
        utils.redraw(1);
        log(`${label}: immediate redraw requested.`, {
          computedFont,
          uri: doc.documentURI,
        });
      } else {
        log(`${label}: style/layout flushed; redraw API unavailable.`, {
          computedFont,
          uri: doc.documentURI,
        });
      }

      return true;
    } catch (err) {
      warn(`${label}: immediate style refresh failed:`, err);
      return false;
    }
  }

  function forceImmediateRefresh() {
    // Flush browser chrome styling (toolbar, tabs, menus) after its <style>
    // element has been updated.
    flushDocumentStyles(window, "Browser interface");

    // The global USER_SHEET is already registered for every tab. Flush and
    // redraw the selected content window so the visible page repaints now.
    try {
      const browser = window.gBrowser?.selectedBrowser;
      const contentWindow = browser?.contentWindow;

      if (contentWindow) {
        flushDocumentStyles(contentWindow, "Active web page");
      } else {
        log("No selected content window available for immediate page redraw.");
      }
    } catch (err) {
      warn("Could not refresh active browser tab immediately:", err);
    }
  }


  // ========================================================================
  // Universal Shadow DOM + iframe integration
  //
  // The ordinary USER_SHEET cannot cross Shadow DOM boundaries. This engine
  // discovers open roots recursively, injects a scoped stylesheet into each
  // root, and observes document/root mutations so late-created components are
  // covered. It also wraps each accessible document realm's attachShadow()
  // method so roots created after installation are styled immediately. The
  // wrapper preserves the native call/return behavior and is restored during
  // cleanup when it is still the active method.
  //
  // This is component-agnostic: no application-specific host names or classes are
  // required. A root created as mode:"closed" after the hook is installed can
  // be styled because the wrapper sees the return value before the caller
  // receives it. Closed roots created before installation, roots in documents
  // that cannot be accessed, and roots created through a previously cached
  // native attachShadow reference remain outside the generic engine's reach.
  // ========================================================================

  const shadowDocumentStates = new Map();
  const shadowRootRecords = new Map();
  const shadowBrowserScanTimers = new Map();

  let shadowTabOpenHandler = null;
  let shadowProgressListener = null;
  let shadowProgressListenerInstalled = false;
  let shadowIntegrationInstalled = false;
  let shadowMutationBatches = 0;

  function shadowFontValue() {
    return `${cssString(settings.font)}, sans-serif`;
  }

  function isIconProtectedElement(element) {
    if (!element?.matches) return false;

    const selectors = [
      ...MEDIA_EXCLUSIONS,
      ...ICON_EXCLUSIONS,
      ...ICON_FONT_EXCLUSIONS,
      ...(settings.protectPageExceptions ? PAGE_SPECIFIC_EXCLUSIONS : []),
    ];

    for (const selector of selectors) {
      try {
        if (element.matches(selector)) return true;
      } catch (_) {
        // A selector that is invalid in a particular browser build must not
        // prevent the remaining icon-family exclusions from being checked.
      }
    }

    return false;
  }

  function buildShadowRootCSS() {
    // Reuse the same icon exclusions as the normal document stylesheet.
    // Shadow-root styles are scoped to this root, so they cannot affect the
    // browser's Font Changer panel or any other component's shadow tree.
    const selector = buildSelector();
    return `
      ${selector} {
        font-family: ${shadowFontValue()} !important;
      }
    `;
  }

  function removeShadowRootStyle(record) {
    if (!record) return;

    try {
      if (record.sheet && record.root?.adoptedStyleSheets) {
        record.root.adoptedStyleSheets = Array.from(
          record.root.adoptedStyleSheets
        ).filter(sheet => sheet !== record.sheet);
      }
    } catch (err) {
      warn("Could not detach constructed Shadow DOM stylesheet:", err);
    }

    try {
      record.style?.remove();
    } catch (_) {}

    record.sheet = null;
    record.style = null;
    record.styleMode = "none";
    record.appliedFont = "";
  }

  function updateShadowRootStyle(record) {
    if (!record || !record.root) return false;

    try {
      if (!settings.pages || record.iconHostExcluded) {
        removeShadowRootStyle(record);
        return true;
      }

      const css = buildShadowRootCSS();

      // Prefer a constructed stylesheet. It can be adopted by a ShadowRoot,
      // is ordered after that root's ordinary style sheets, and avoids relying
      // on an inline <style> element that a page's style-src policy may block.
      if (record.sheet && record.sheet.replaceSync) {
        record.sheet.replaceSync(css);

        const adopted = Array.from(record.root.adoptedStyleSheets || []);
        if (!adopted.includes(record.sheet)) {
          record.root.adoptedStyleSheets = [...adopted, record.sheet];
        }

        record.appliedFont = settings.font;
        record.styleMode = "adoptedStyleSheets";
        return true;
      }

      if (!record.sheet && "adoptedStyleSheets" in record.root) {
        try {
          let pageWindow = record.docState.win;
          try {
            pageWindow = record.docState.win.wrappedJSObject || record.docState.win;
          } catch (_) {}

          const SheetCtor =
            pageWindow?.CSSStyleSheet ||
            record.docState.win?.CSSStyleSheet;

          if (typeof SheetCtor === "function") {
            const sheet = new SheetCtor();
            sheet.replaceSync(css);

            const adopted = Array.from(record.root.adoptedStyleSheets || []);
            record.root.adoptedStyleSheets = [...adopted, sheet];

            record.sheet = sheet;
            record.appliedFont = settings.font;
            record.styleMode = "adoptedStyleSheets";

            // Remove a previous fallback if the constructed stylesheet now
            // succeeds (e.g. a realm implementation becomes available).
            try { record.style?.remove(); } catch (_) {}
            record.style = null;

            return true;
          }
        } catch (err) {
          warn("Constructed stylesheet unavailable for this ShadowRoot; using style-element fallback:", err);
        }
      }

      // Compatibility fallback for engines/realms without adoptedStyleSheets.
      if (!record.style || record.style.getRootNode() !== record.root) {
        const doc = record.docState.doc;
        const style = doc.createElement("style");
        style.setAttribute("data-font-changer-shadow-style", VERSION);
        style.setAttribute("type", "text/css");
        style.textContent = css;
        record.root.appendChild(style);
        record.style = style;
      } else {
        record.style.textContent = css;
      }

      record.appliedFont = settings.font;
      record.styleMode = "style-element-fallback";

      if (!record.style.sheet) {
        warn("ShadowRoot style element has no CSSStyleSheet; the page may block inline styles via CSP.");
      }

      return true;
    } catch (err) {
      warn("Could not apply stylesheet to Shadow DOM root:", {
        host: record.root.host?.localName,
        mode: record.mode,
        error: err,
      });
      return false;
    }
  }

  // Coalesce duplicate MutationObserver records. If a parent and one of its
  // descendants were both inserted during the same batch, inspecting the
  // parent already covers the descendant. This keeps SPA-heavy pages from
  // repeatedly walking the same inserted subtree.
  function processAddedNodeBatch(records, docState) {
    const addedNodes = new Set();

    for (const mutation of records || []) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes || []) {
        if (node?.nodeType === 1) addedNodes.add(node);
      }
    }

    if (!addedNodes.size) return 0;

    for (const node of addedNodes) {
      let ancestor = node.parentElement;
      let nestedInAddedNode = false;

      while (ancestor) {
        if (addedNodes.has(ancestor)) {
          nestedInAddedNode = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }

      if (!nestedInAddedNode) processShadowSubtree(node, docState);
    }

    shadowMutationBatches++;
    return addedNodes.size;
  }

  function processShadowSubtree(node, docState) {
    if (!node || !docState) return;

    if (node.nodeType === 9) {
      scanShadowDocument(node, docState);
      return;
    }

    if (node.nodeType !== 1) return;

    const inspectElement = element => {
      if (!element || element.nodeType !== 1) return;

      try {
        const root = element.shadowRoot;
        if (root) {
          registerShadowRoot(root, docState);
        }
      } catch (err) {
        // Closed roots created before the hook are expected to be invisible.
      }

      try {
        if (element.matches?.("iframe, frame")) {
          watchShadowFrame(element, docState);
        }
      } catch (_) {}
    };

    inspectElement(node);

    try {
      for (const descendant of node.querySelectorAll?.("*") || []) {
        inspectElement(descendant);
      }

    } catch (err) {
      warn("Could not inspect added DOM subtree:", docState.label, err);
    }
  }

  function registerShadowRoot(root, docState) {
    if (!root || !docState || !root.querySelectorAll) return null;

    const existing = shadowRootRecords.get(root);
    if (existing) {
      updateShadowRootStyle(existing);
      return existing;
    }

    const mode = root.mode || "open";
    const record = {
      root,
      docState,
      mode,
      iconHostExcluded: isIconProtectedElement(root.host),
      style: null,
      sheet: null,
      styleMode: "none",
      observer: null,
      appliedFont: "",
    };

    shadowRootRecords.set(root, record);
    docState.roots.add(root);



    updateShadowRootStyle(record);

    try {
      const ObserverCtor =
        docState.win?.MutationObserver || window.MutationObserver;

      if (ObserverCtor) {
        record.observer = new ObserverCtor(records => {
          processAddedNodeBatch(records, docState);
        });

        record.observer.observe(root, {
          childList: true,
          subtree: true,
        });
      }
    } catch (err) {
      warn("Could not observe Shadow DOM root:", err);
    }

    // Scan existing descendants for nested roots and iframes.
    try {
      for (const child of root.children || []) {
        processShadowSubtree(child, docState);
      }
    } catch (err) {
      warn("Could not scan nested Shadow DOM roots:", err);
    }

    log("Shadow DOM root discovered:", {
      host: root.host?.localName || "unknown",
      mode,
      font: settings.font,
      pagesEnabled: settings.pages,
    });

    return record;
  }

  function watchShadowFrame(frame, parentState) {
    if (!frame || parentState.frames.has(frame)) return;

    const onLoad = () => {
      try {
        const childWindow = frame.contentWindow;
        if (childWindow) {
          installShadowDocument(
            childWindow,
            `${parentState.label} / iframe`
          );
        }
      } catch (err) {
        // Cross-origin/remote frames may be inaccessible. The shared Gecko
        // USER_SHEET continues to style their ordinary document content.
        warn("Could not inspect iframe document for Shadow DOM:", err);
      }
    };

    parentState.frames.set(frame, onLoad);

    try {
      frame.addEventListener("load", onLoad, true);
    } catch (_) {}

    onLoad();
  }

  function scanShadowDocument(doc, docState) {
    if (!doc?.documentElement || !docState) return;

    try {
      processShadowSubtree(doc.documentElement, docState);
    } catch (err) {
      warn("Shadow DOM document scan failed:", docState.label, err);
    }
  }

  function cleanupShadowDocument(doc) {
    const state = shadowDocumentStates.get(doc);
    if (!state) return;

    try {
      state.observer?.disconnect();
      state.win?.removeEventListener("pagehide", state.pageHideHandler, true);

      for (const [frame, handler] of state.frames) {
        try {
          frame.removeEventListener("load", handler, true);
        } catch (_) {}
      }

      for (const root of state.roots) {
        const record = shadowRootRecords.get(root);
        if (!record) continue;

        try {
          record.observer?.disconnect();
          removeShadowRootStyle(record);
        } catch (_) {}

        shadowRootRecords.delete(root);
      }

      state.roots.clear();
    } catch (err) {
      warn("Shadow DOM document cleanup failed:", state.label, err);
    }

    shadowDocumentStates.delete(doc);
  }

  function installShadowDocument(targetWindow, label = "content document") {
    let doc;

    try {
      if (!targetWindow || targetWindow.closed) return false;
      doc = targetWindow.document;
      if (!doc?.documentElement) return false;
    } catch (err) {
      warn("Document is inaccessible for generic Shadow DOM handling:", label, err);
      return false;
    }

    // An installed document already has a MutationObserver. Re-scanning its
    // entire DOM on tab selection or repeated progress notifications is both
    // redundant and expensive; new nodes are handled incrementally.
    if (shadowDocumentStates.has(doc)) return true;

    const MutationObserverCtor =
      targetWindow.MutationObserver || window.MutationObserver;

    if (!MutationObserverCtor) {
      warn("MutationObserver unavailable for:", label);
      return false;
    }

    const state = {
      doc,
      win: targetWindow,
      label,
      observer: null,
      pageHideHandler: null,
      frames: new Map(),
      roots: new Set(),
    };

    try {
      // Do not patch page-realm prototypes. Discover existing open roots once,
      // then inspect only DOM subtrees that are subsequently inserted.
      shadowDocumentStates.set(doc, state);

      state.observer = new MutationObserverCtor(records => {
        processAddedNodeBatch(records, state);
      });

      state.observer.observe(doc.documentElement, {
        childList: true,
        subtree: true,
      });

      state.pageHideHandler = event => {
        // Keep observers/prototype instrumentation for BFCache-restored pages.
        if (!event.persisted) cleanupShadowDocument(doc);
      };

      targetWindow.addEventListener(
        "pagehide",
        state.pageHideHandler,
        true
      );

      scanShadowDocument(doc, state);

      log("Generic document/Shadow DOM observer installed:", label, doc.documentURI);
      return true;
    } catch (err) {
      state.observer?.disconnect();
      shadowDocumentStates.delete(doc);
      error("Could not install generic Shadow DOM observer:", label, err);
      return false;
    }
  }

  function scheduleShadowBrowserScan(browser, label = "tab", delay = 90) {
    if (!browser || !settings?.pages || cleanedUp) return;

    // Keep at most one pending scan per browser. Navigation start/location
    // notifications are intentionally not used; the completed-document event
    // below schedules a single scan after Gecko has committed the new document.
    const previousTimer = shadowBrowserScanTimers.get(browser);
    if (previousTimer) window.clearTimeout(previousTimer);

    const timer = window.setTimeout(() => {
      shadowBrowserScanTimers.delete(browser);
      if (cleanedUp || !settings?.pages) return;

      try {
        const contentWindow = browser.contentWindow;
        if (contentWindow) installShadowDocument(contentWindow, label);
      } catch (err) {
        warn("Browser document scan failed:", label, err);
      }
    }, Math.max(0, delay));

    shadowBrowserScanTimers.set(browser, timer);
  }

  function installShadowDOMIntegration() {
    if (!settings?.pages || shadowIntegrationInstalled || cleanedUp) return;

    const gBrowser = window.gBrowser;
    if (!gBrowser) {
      warn("gBrowser unavailable; generic tab integration not installed.");
      return;
    }

    shadowIntegrationInstalled = true;

    try {
      const browsers = Array.from(gBrowser.browsers || []);
      browsers.forEach((browser, index) => {
        // Stagger startup scans slightly so a browser with many restored tabs
        // does not synchronously inspect every document in one burst.
        scheduleShadowBrowserScan(
          browser,
          `tab-${index + 1}`,
          index === 0 ? 0 : Math.min(index * 35, 700)
        );
      });
      log("Scheduled one-time open-Shadow-DOM discovery for existing tabs:", browsers.length);
    } catch (err) {
      warn("Could not enumerate existing browser tabs:", err);
    }

    shadowTabOpenHandler = event => {
      const browser = event.target?.linkedBrowser;
      if (browser) scheduleShadowBrowserScan(browser, "new tab", 180);
    };

    try {
      gBrowser.addEventListener("TabOpen", shadowTabOpenHandler, true);
    } catch (err) {
      warn("Could not install tab-open hook:", err);
      shadowTabOpenHandler = null;
    }

    try {
      const flags = Ci.nsIWebProgressListener;
      shadowProgressListener = {
        // A completed top-level document is the only navigation event that
        // needs a discovery pass. SPA route changes are covered by the
        // document's MutationObserver, without observing history or clicks.
        onStateChange(browser, _progress, _request, stateFlags) {
          try {
            if (
              (stateFlags & flags.STATE_IS_DOCUMENT) &&
              (stateFlags & flags.STATE_STOP)
            ) {
              scheduleShadowBrowserScan(browser, "completed document navigation", 90);
            }
          } catch (_) {}
        },
        onLocationChange() {},
        onProgressChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
      };

      gBrowser.addTabsProgressListener(shadowProgressListener);
      shadowProgressListenerInstalled = true;
      log("Navigation-safe Shadow DOM discovery listener installed (document stop only).");
    } catch (err) {
      warn("Tab progress listener unavailable; tab-open discovery remains:", err);
      shadowProgressListener = null;
    }
  }

  function refreshShadowDOMStyles() {
    let updated = 0;
    let removed = 0;
    let iconProtected = 0;

    for (const record of shadowRootRecords.values()) {
      // The page-exception checkbox can change after a root was discovered.
      // Recompute this flag so existing roots respond immediately in both
      // directions instead of keeping a stale protected/unprotected state.
      record.iconHostExcluded = isIconProtectedElement(record.root?.host);

      if (record.iconHostExcluded) {
        updateShadowRootStyle(record);
        iconProtected++;
        continue;
      }

      if (updateShadowRootStyle(record)) {
        if (settings.pages) updated++;
        else removed++;
      }
    }

    log("Generic Shadow DOM styles refreshed:", {
      font: settings.font,
      pagesEnabled: settings.pages,
      rootsUpdated: updated,
      rootsDisabled: removed,
      iconProtectedRoots: iconProtected,
      totalRoots: shadowRootRecords.size,
    });

    return {
      rootsUpdated: updated,
      rootsDisabled: removed,
      iconProtectedRoots: iconProtected,
      totalRoots: shadowRootRecords.size,
    };
  }

  function shadowDOMStatus() {
    let openRoots = 0;
    let activeObservers = 0;
    let observedFrames = 0;
    let adoptedStyleSheets = 0;
    let styleElementFallbacks = 0;
    let iconProtectedRoots = 0;

    for (const record of shadowRootRecords.values()) {
      if (record.mode !== "closed") openRoots++;
      if (record.iconHostExcluded) iconProtectedRoots++;
      if (record.observer) activeObservers++;
      if (record.styleMode === "adoptedStyleSheets") adoptedStyleSheets++;
      if (record.styleMode === "style-element-fallback") styleElementFallbacks++;
    }

    for (const state of shadowDocumentStates.values()) {
      observedFrames += state.frames.size;
    }

    return {
      integrationEnabled: shadowIntegrationInstalled,
      observedDocuments: shadowDocumentStates.size,
      discoveredShadowRoots: shadowRootRecords.size,
      openShadowRoots: openRoots,
      closedRootsInterceptedAfterHook: 0,
      activeRootObservers: activeObservers,
      iconProtectedRoots,
      adoptedStyleSheets,
      styleElementFallbacks,
      observedIframes: observedFrames,
      attachShadowHooks: 0,
      attachShadowInterception: false,
      pendingBrowserScans: shadowBrowserScanTimers.size,
      mutationBatches: shadowMutationBatches,
      pagesFontEnabled: !!settings?.pages,
      genericSelectors: true,
      applicationSpecificSelectors: false,
      limitation: "Only discoverable open Shadow DOM roots are styled. Closed roots are deliberately not intercepted to preserve page-native JavaScript behavior.",
    };
  }

  function cleanupShadowDOMIntegration() {
    for (const timer of shadowBrowserScanTimers.values()) {
      try { window.clearTimeout(timer); } catch (_) {}
    }
    shadowBrowserScanTimers.clear();

    for (const doc of [...shadowDocumentStates.keys()]) {
      cleanupShadowDocument(doc);
    }

    const gBrowser = window.gBrowser;
    try {
      if (gBrowser && shadowTabOpenHandler) {
        gBrowser.removeEventListener("TabOpen", shadowTabOpenHandler, true);
      }
      if (gBrowser && shadowProgressListenerInstalled && shadowProgressListener) {
        gBrowser.removeTabsProgressListener(shadowProgressListener);
      }
    } catch (err) {
      warn("Generic Shadow DOM browser-hook cleanup failed:", err);
    }

    shadowProgressListenerInstalled = false;
    shadowProgressListener = null;
    shadowTabOpenHandler = null;
    shadowIntegrationInstalled = false;
  }

  // ========================================================================
  // Panel data model
  // ========================================================================

  function allFontNames() {
    return sortFonts([
      ...installedFonts,
      ...settings.customFonts,
      ...settings.bookmarks,
      settings.font,
      settings.interfaceFont,
    ]);
  }

  function isBookmarked(name) {
    const key = name.toLocaleLowerCase();
    return settings.bookmarks.some(x => x.toLocaleLowerCase() === key);
  }

  function setActiveFont(name) {
    const font = cleanFontName(name);
    if (!font) return;

    settings.font = font;
    if (!settings.separateInterfaceFont) {
      settings.interfaceFont = font;
    }
    if (!settings.customFonts.some(x => x.toLocaleLowerCase() === font.toLocaleLowerCase())) {
      settings.customFonts.push(font);
    }

    // The main Selected font control and the System Font library represent
    // the same committed font. Synchronize both before saveSettings() calls
    // applyAll() -> refreshPanel(). This prevents Apply Font from reverting
    // to a stale library selection.
    selectedLibraryFont = font;
    pendingLibrarySelectionSync = font;

    saveSettings();
    log("Active page/shared font changed; System Font selection synchronized:", font);
  }

  function setInterfaceFont(name) {
    const font = cleanFontName(name);
    if (!font) return;

    settings.interfaceFont = font;
    if (!settings.customFonts.some(x => x.toLocaleLowerCase() === font.toLocaleLowerCase())) {
      settings.customFonts.push(font);
    }

    saveSettings();
    log("Separate Firefox interface font changed:", font);
  }

  // ========================================================================
  // Panel construction — ordinary HTML overlay, not an anchored XUL popup
  // ========================================================================

  function createPanel() {
    if (panel?.isConnected) return panel;

    panel = element("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Font Changer");
    panel.setAttribute("aria-modal", "false");

    // Titlebar: broad drag surface inspired by Context Menu Editor.
    const titlebar = element("header", "fc-titlebar");
    const titleGroup = element("div", "fc-title-group");
    titleGroup.append(
      element("span", "fc-title", "Font Changer"),
      element("span", "fc-subtitle", "BROWSER APPEARANCE")
    );

    const topClose = button("×", "fc-close");
    topClose.setAttribute("aria-label", "Close Font Changer");
    // Keep the titlebar clean; dragging still works across its empty space.
    titlebar.append(titleGroup, topClose);
    panel.appendChild(titlebar);

    const body = element("div", "fc-body");
    panel.appendChild(body);

    // Apply to section.
    const targetsSection = element("section", "fc-section");
    const targetsHead = element("div", "fc-section-head");
    targetsHead.append(
      element("span", "fc-section-title", "Apply to"),
      element("span", "fc-section-note", "Choose where the font is used")
    );
    targetsSection.appendChild(targetsHead);

    const targets = element("div", "fc-targets");
    const interfaceLabel = element("label", "fc-target");
    const interfaceCheckbox = element("input");
    interfaceCheckbox.type = "checkbox";
    interfaceLabel.append(interfaceCheckbox, element("span", "", "Firefox interface"));

    const pagesLabel = element("label", "fc-target");
    const pagesCheckbox = element("input");
    pagesCheckbox.type = "checkbox";
    pagesLabel.append(pagesCheckbox, element("span", "", "Web pages"));

    const pageExceptionsLabel = element("label", "fc-target fc-target-wide");
    const pageExceptionsCheckbox = element("input");
    pageExceptionsCheckbox.type = "checkbox";
    pageExceptionsCheckbox.setAttribute(
      "aria-label",
      "Preserve icon fonts and site-specific page elements"
    );
    pageExceptionsLabel.append(
      pageExceptionsCheckbox,
      element("span", "", "Preserve icon fonts & site-specific elements")
    );

    pageExceptionsCheckbox.checked = false;
    targets.append(interfaceLabel, pagesLabel);
    targetsSection.appendChild(targets);
    body.appendChild(targetsSection);

    // Current selection section.
    const currentSection = element("section", "fc-section");
    const currentHead = element("div", "fc-section-head");
    currentHead.append(
      element("span", "fc-section-title", "Selected font"),
      element("span", "fc-section-note", "Shared by pages + UI by default")
    );
    currentSection.appendChild(currentHead);

    const fontSelectRow = element("div", "fc-font-select-row");
    const fontSelect = element("select");
    fontSelect.setAttribute("aria-label", "Selected font");
    const selectedFontBookmark = button("☆", "fc-selected-font-bookmark");
    selectedFontBookmark.setAttribute("aria-label", "Bookmark selected font");
    selectedFontBookmark.title = "Bookmark selected font";
    fontSelectRow.append(fontSelect, selectedFontBookmark);
    currentSection.appendChild(fontSelectRow);

    const preview = element("div", "fc-preview", "Aa Bb Yy Zz 0123456789");
    preview.setAttribute("aria-label", "Selected font preview");
    currentSection.appendChild(preview);

    // Optional independent Firefox UI font. Disabled by default so older
    // profiles preserve the original single-font behavior.
    const separateInterfaceLabel = element("label", "fc-separate-toggle");
    const separateInterfaceCheckbox = element("input");
    separateInterfaceCheckbox.type = "checkbox";
    separateInterfaceCheckbox.setAttribute("aria-label", "Use a separate font for the Firefox interface");
    separateInterfaceLabel.append(
      separateInterfaceCheckbox,
      element("span", "", "Use a separate interface font")
    );
    currentSection.appendChild(separateInterfaceLabel);

    const interfaceFontPicker = element("div", "fc-interface-font-picker");
    const interfaceFontHead = element("div", "fc-section-head");
    interfaceFontHead.append(
      element("span", "fc-section-title", "Firefox interface font"),
      element("span", "fc-section-note", "Independent from web pages")
    );
    const interfaceFontSelect = element("select");
    interfaceFontSelect.setAttribute("aria-label", "Firefox interface font");
    const interfaceFontPreview = element("div", "fc-interface-preview", "Aa Bb Yy Zz 0123456789");
    interfaceFontPreview.setAttribute("aria-label", "Firefox interface font preview");
    interfaceFontPicker.append(interfaceFontHead, interfaceFontSelect, interfaceFontPreview);
    currentSection.appendChild(interfaceFontPicker);

    body.appendChild(currentSection);

    // Installed font library section.
    const librarySection = element("section", "fc-section");
    const libraryHead = element("div", "fc-section-head");
    const libraryTitle = element("span", "fc-section-title", "System Font");
    const libraryNote = element("span", "fc-section-note", "Search · preview · bookmark");
    libraryHead.append(libraryTitle, libraryNote);
    librarySection.appendChild(libraryHead);

    const libraryRow = element("div", "fc-lib-row");
    const search = element("input");
    search.type = "search";
    search.placeholder = "Search installed fonts…";
    search.setAttribute("aria-label", "Search installed fonts");

    const filter = element("select");
    const allOption = element("option", "", "All fonts");
    allOption.value = "all";
    const bookmarkOption = element("option", "", "★ Bookmarks");
    bookmarkOption.value = "bookmarks";
    filter.append(allOption, bookmarkOption);
    libraryRow.append(search, filter);
    librarySection.appendChild(libraryRow);

    // A custom row list allows a bookmark button at the right edge of every
    // font without relying on the limited rendering model of a native select.
    const fontList = element("div", "fc-font-list");
    fontList.tabIndex = 0;
    fontList.setAttribute("role", "group");
    fontList.setAttribute("aria-label", "Installed font families");
    fontList.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown Home End Delete Enter");
    librarySection.appendChild(fontList);

    const meta = element("div", "fc-lib-meta");
    const count = element("span");
    const selectedName = element("span", "", "No selection");
    meta.append(count, selectedName);
    librarySection.appendChild(meta);

    const libraryPreview = element("div", "fc-lib-preview", "The quick brown fox jumps over the lazy dog");
    libraryPreview.setAttribute("aria-label", "Installed font preview");
    librarySection.appendChild(libraryPreview);

    librarySection.appendChild(
      element("p", "fc-note", "Type a letter to jump · repeat it to cycle · ↑ / ↓ browse · ★ bookmark · Delete in Bookmarks")
    );
    librarySection.hidden = true;
    librarySection.setAttribute("aria-hidden", "true");
    body.appendChild(librarySection);

    // Footer: a single ordinary button replaces the old Use / Bookmark / Refresh
    // row and the former Remove custom action. Bookmark deletion is keyboard- or
    // star-driven, so the old remove button is no longer needed here.
    const footer = element("footer", "fc-footer");
    const footerHint = element("span", "fc-footer-hint", "Select a font, then apply it.");
    const footerSpacer = element("span", "fc-footer-spacer");
    const applyButton = button("Apply Font", "fc-apply");
    footer.append(footerHint, footerSpacer, applyButton);
    footer.hidden = true;
    footer.setAttribute("aria-hidden", "true");
    panel.appendChild(footer);

    document.documentElement.appendChild(panel);

    controls = {
      titlebar,
      topClose,
      interfaceCheckbox,
      pagesCheckbox,
      pageExceptionsCheckbox,
      fontSelect,
      selectedFontBookmark,
      preview,
      separateInterfaceCheckbox,
      interfaceFontPicker,
      interfaceFontSelect,
      interfaceFontPreview,
      libraryTitle,
      search,
      filter,
      fontList,
      count,
      selectedName,
      libraryPreview,
      footerHint,
      applyButton,
    };

    // Target toggles.
    interfaceCheckbox.addEventListener("change", () => {
      settings.interface = interfaceCheckbox.checked;
      saveSettings();
    });

    pagesCheckbox.addEventListener("change", () => {
      settings.pages = pagesCheckbox.checked;
      saveSettings();
    });

    pageExceptionsCheckbox.addEventListener("change", () => {
      settings.protectPageExceptions = pageExceptionsCheckbox.checked;
      log("Page icon/site-specific exceptions:", settings.protectPageExceptions);
      saveSettings();
    });

    // Quick selector.
    fontSelect.addEventListener("change", () => {
      if (fontSelect.value) setActiveFont(fontSelect.value);
      updateSelectedFontBookmark();
    });
    selectedFontBookmark.addEventListener("click", () => {
      if (fontSelect.value) toggleBookmark(fontSelect.value);
      updateSelectedFontBookmark();
      refreshQuickSelector();
    });
    fontSelect.addEventListener("keydown", event => {
      const names = [...fontSelect.options].map(option => option.value).filter(Boolean);
      handleFontTypeahead(event, fontSelect, names, fontSelect.value, name => {
        fontSelect.value = name;
        fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    separateInterfaceCheckbox.addEventListener("change", () => {
      const enabled = separateInterfaceCheckbox.checked;
      settings.separateInterfaceFont = enabled;
      // When turning the mode on or off, initialize the linked font to the
      // current main font. The user can then choose an independent UI family.
      if (!enabled || !settings.interfaceFont) {
        settings.interfaceFont = settings.font;
      }
      log("Separate interface font mode:", enabled);
      saveSettings();
    });

    interfaceFontSelect.addEventListener("change", () => {
      if (interfaceFontSelect.value) {
        setInterfaceFont(interfaceFontSelect.value);
      }
    });
    interfaceFontSelect.addEventListener("keydown", event => {
      const names = [...interfaceFontSelect.options].map(option => option.value).filter(Boolean);
      handleFontTypeahead(event, interfaceFontSelect, names, interfaceFontSelect.value, name => {
        interfaceFontSelect.value = name;
        interfaceFontSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    // Close control.
    topClose.addEventListener("click", closePanel);

    // Library controls.
    search.addEventListener("input", () => renderFontLibrary());
    search.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" && controls.fontList.children.length) {
        event.preventDefault();
        if (!selectedLibraryFont) {
          selectLibraryFont(controls.fontList.children[0].dataset.font);
        }
        controls.fontList.focus({ preventScroll: true });
        scrollSelectedIntoView();
      }
    });
    filter.addEventListener("change", () => renderFontLibrary(selectedLibraryFont, true));
    fontList.addEventListener("click", () => fontList.focus({ preventScroll: true }));
    fontList.addEventListener("keydown", handleLibraryKeyDown);
    applyButton.addEventListener("click", applyLibrarySelection);

    // Draggable titlebar; interactive controls are deliberately excluded.
    installDragging();

    // Restore a previously saved position if available; otherwise remain truly
    // centered with CSS left:50%, top:50%, transform:translate(-50%,-50%).
    restorePosition();

    refreshPanel();
    renderFontLibrary(settings.font);

    log("HTML font window created.");
    return panel;
  }

  // ========================================================================
  // Draggable panel — pointer capture, viewport clamp, double-click reset
  // ========================================================================

  function isInteractiveTarget(target) {
    return !!target?.closest?.(
      "button, input, select, textarea, a, [contenteditable='true']"
    );
  }

  function clampPosition(left, top) {
    const rect = panel.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const margin = 8;

    return {
      left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
      top: Math.max(margin, Math.min(window.innerHeight - height - margin, top)),
    };
  }

  function restorePosition() {
    const saved = readSavedPosition();
    if (!saved) return;

    const apply = () => {
      if (!panel?.isConnected) return;
      const rect = panel.getBoundingClientRect();
      const position = clampPosition(saved.left, saved.top);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      log("Restored saved window position.");
    };

    // Wait for layout dimensions before clamping the stored coordinates.
    window.requestAnimationFrame(apply);
  }

  function resetPosition() {
    if (!panel) return;
    panel.style.left = "50%";
    panel.style.top = "50%";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.transform = "translate(-50%, -50%)";

    try {
      prefs.setStringPref(POSITION_PREF, "");
    } catch (_) {}

    log("Window returned to center.");
  }

  function installDragging() {
    const handle = controls.titlebar;

    function start(event) {
      if (event.button !== 0 || isInteractiveTarget(event.target)) return;

      const rect = panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: rect.left,
        baseY: rect.top,
      };

      // Convert centered positioning into explicit coordinates on first drag.
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      panel.classList.add("is-moving");

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (_) {
        // Pointer capture is best-effort; movement still works on the handle.
      }

      event.preventDefault();
      event.stopPropagation();
    }

    function move(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const next = clampPosition(
        dragState.baseX + event.clientX - dragState.startX,
        dragState.baseY + event.clientY - dragState.startY
      );

      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
    }

    function stop(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      dragState = null;
      panel.classList.remove("is-moving");

      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {}

      savePosition();
    }

    handle.addEventListener("pointerdown", start);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);

    handle.addEventListener("dblclick", event => {
      if (!isInteractiveTarget(event.target)) resetPosition();
    });

    resizeHandler = () => {
      if (!panel?.classList.contains("is-open")) return;
      if (panel.style.transform !== "none") return;
      const rect = panel.getBoundingClientRect();
      const next = clampPosition(rect.left, rect.top);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
    };

    window.addEventListener("resize", resizeHandler);
  }

  // ========================================================================
  // Library rendering and previews
  // ========================================================================

  function resolveLibrarySelection(
    preferred,
    matches,
    previousSelection,
    preservePreferredSelection = false
  ) {
    const preferredName = cleanFontName(preferred);
    const previousIndex = previousSelection
      ? matches.findIndex(x => x.toLocaleLowerCase() === previousSelection.toLocaleLowerCase())
      : -1;
    const preferredMatch = matches.find(
      x => x.toLocaleLowerCase() === String(preferred || "").toLocaleLowerCase()
    );

    // A committed selector change wins even when filtering hides the row.
    if (preservePreferredSelection && preferredName) return preferredName;

    // For ordinary searches and filter changes, retain the previous visible
    // selection or move to the first result when it is no longer visible.
    return preferredMatch ||
      (previousIndex >= 0 ? matches[previousIndex] : matches[0] || "");
  }

  function renderFontLibrary(
    preferred = selectedLibraryFont || settings.font,
    focusList = false,
    preservePreferredSelection = false
  ) {
    if (!controls) return;

    const query = controls.search.value.trim().toLocaleLowerCase();
    const onlyBookmarks = controls.filter.value === "bookmarks";

    const matches = allFontNames().filter(name => {
      const saved = isBookmarked(name);
      return (!onlyBookmarks || saved) &&
        (!query || name.toLocaleLowerCase().includes(query));
    });

    // Usually, searching/filtering moves the selection to the first visible
    // match when the previous one disappears. A committed change from either
    // font selector is different: preserve that exact font even when the active
    // search/bookmark filter temporarily hides its row. The preview, selected
    // name and Apply button then continue to refer to the same font.
    selectedLibraryFont = resolveLibrarySelection(
      preferred,
      matches,
      selectedLibraryFont,
      preservePreferredSelection
    );

    while (controls.fontList.firstChild) {
      controls.fontList.firstChild.remove();
    }

    if (!matches.length) {
      controls.fontList.appendChild(
        element(
          "div",
          "fc-font-empty",
          onlyBookmarks
            ? "No bookmarked fonts. Click ☆ beside a font to save it."
            : "No fonts match this search."
        )
      );
    }

    matches.forEach((name, index) => {
      const detected = installedFonts.some(
        x => x.toLocaleLowerCase() === name.toLocaleLowerCase()
      );
      const bookmarked = isBookmarked(name);
      const selected = name.toLocaleLowerCase() === selectedLibraryFont.toLocaleLowerCase();

      const row = element("div", "fc-font-row" + (selected ? " is-selected" : ""));
      row.dataset.font = name;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", name);
      row.setAttribute("aria-current", selected ? "true" : "false");

      const nameButton = button(
        `${name}${detected ? "" : " (not detected)"}`,
        "fc-font-name"
      );
      nameButton.tabIndex = -1;
      nameButton.setAttribute("aria-label", name + (detected ? "" : ", not detected as installed"));
      nameButton.addEventListener("click", event => {
        event.preventDefault();
        selectLibraryFont(name, true);
      });
      const starButton = button(bookmarked ? "★" : "☆", "fc-font-star" + (bookmarked ? " is-bookmarked" : ""));
      starButton.tabIndex = -1;
      starButton.setAttribute("aria-label", bookmarked ? `Remove ${name} bookmark` : `Bookmark ${name}`);
      starButton.setAttribute("aria-pressed", String(bookmarked));
      starButton.title = bookmarked ? "Remove bookmark" : "Bookmark this font";
      starButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        selectLibraryFont(name, true);
        toggleBookmark(name);
      });

      row.append(nameButton, starButton);
      controls.fontList.appendChild(row);
    });

    controls.count.textContent = onlyBookmarks
      ? `${matches.length} bookmarked`
      : `${matches.length} shown / ${installedFonts.length} installed`;

    updateLibraryPreview();

    if (focusList) {
      controls.fontList.focus({ preventScroll: true });
      scrollSelectedIntoView();
    }
  }

  function selectLibraryFont(name, focusList = false) {
    if (!name) return;
    selectedLibraryFont = name;
    renderFontLibrary(name, focusList);
  }

  function scrollSelectedIntoView() {
    if (!controls || !selectedLibraryFont) return;

    const row = [...controls.fontList.querySelectorAll(".fc-font-row")].find(
      item => item.dataset.font.toLocaleLowerCase() === selectedLibraryFont.toLocaleLowerCase()
    );

    row?.scrollIntoView({ block: "nearest" });
  }

  function updateLibraryPreview() {
    if (!controls) return;

    const name = selectedLibraryFont;
    controls.libraryPreview.style.fontFamily = name
      ? `${cssString(name)}, sans-serif`
      : "sans-serif";

    controls.selectedName.textContent = name || "No selection";
    controls.applyButton.disabled = !name;

    const bookmarkMode = controls.filter.value === "bookmarks";
    controls.footerHint.textContent = bookmarkMode
      ? "↑ / ↓ browse · Delete removes selected bookmark"
      : "↑ / ↓ browse · ★ on the right saves a bookmark";
  }

  function applyLibrarySelection() {
    const name = selectedLibraryFont;
    if (!name) return;

    setActiveFont(name);
    log("Applied selected library font:", name);
  }

  function saveBookmarksOnly(preferred = selectedLibraryFont) {
    writingPrefs = true;
    try {
      prefs.setStringPref(
        PREF_ROOT + "bookmarks",
        JSON.stringify(sortFonts(settings.bookmarks))
      );
    } finally {
      writingPrefs = false;
    }

    settings = readSettings();
    renderFontLibrary(preferred, true);
  }

  function toggleBookmark(name = selectedLibraryFont) {
    if (!name) return;

    const index = settings.bookmarks.findIndex(
      x => x.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (index >= 0) {
      settings.bookmarks.splice(index, 1);
      log("Bookmark removed:", name);
    } else {
      settings.bookmarks.push(name);
      log("Bookmarked:", name);
    }

    saveBookmarksOnly(name);
  }

  function removeSelectedBookmark() {
    const name = selectedLibraryFont;
    if (!name || controls.filter.value !== "bookmarks" || !isBookmarked(name)) {
      return false;
    }

    const visibleRows = [...controls.fontList.querySelectorAll(".fc-font-row")];
    const oldIndex = visibleRows.findIndex(
      row => row.dataset.font.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    settings.bookmarks = settings.bookmarks.filter(
      x => x.toLocaleLowerCase() !== name.toLocaleLowerCase()
    );

    log("Deleted bookmark using Delete key:", name);

    const remaining = allFontNames().filter(x => {
      const query = controls.search.value.trim().toLocaleLowerCase();
      return isBookmarked(x) && (!query || x.toLocaleLowerCase().includes(query));
    });

    const next = remaining[Math.min(Math.max(oldIndex, 0), remaining.length - 1)] || "";
    saveBookmarksOnly(next);
    return true;
  }

  function removeSelectedCustomFont() {
    const name = selectedLibraryFont;
    if (!name || controls.filter.value !== "all") return false;

    const exists = settings.customFonts.some(
      x => x.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (!exists) return false;

    settings.customFonts = settings.customFonts.filter(
      x => x.toLocaleLowerCase() !== name.toLocaleLowerCase()
    );

    if (settings.font.toLocaleLowerCase() === name.toLocaleLowerCase()) {
      settings.font = DEFAULT_FONT;
    }

    log("Removed custom font entry using Delete key:", name);
    saveSettings();
    return true;
  }

  function moveLibrarySelection(direction) {
    const rows = [...controls.fontList.querySelectorAll(".fc-font-row")];
    if (!rows.length) return;

    let index = rows.findIndex(
      row => row.dataset.font.toLocaleLowerCase() === selectedLibraryFont.toLocaleLowerCase()
    );

    if (index < 0) index = direction > 0 ? -1 : rows.length;
    const nextIndex = Math.max(0, Math.min(rows.length - 1, index + direction));

    selectLibraryFont(rows[nextIndex].dataset.font, true);
  }

  function handleLibraryKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const visibleNames = [...controls.fontList.querySelectorAll(".fc-font-row")]
      .map(row => row.dataset.font)
      .filter(Boolean);

    if (handleFontTypeahead(
      event,
      controls.fontList,
      visibleNames,
      selectedLibraryFont,
      name => selectLibraryFont(name, true)
    )) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveLibrarySelection(1);
        break;

      case "ArrowUp":
        event.preventDefault();
        moveLibrarySelection(-1);
        break;

      case "Home": {
        event.preventDefault();
        const first = controls.fontList.querySelector(".fc-font-row");
        if (first) selectLibraryFont(first.dataset.font, true);
        break;
      }

      case "End": {
        event.preventDefault();
        const rows = controls.fontList.querySelectorAll(".fc-font-row");
        const last = rows[rows.length - 1];
        if (last) selectLibraryFont(last.dataset.font, true);
        break;
      }

      case "Enter":
        event.preventDefault();
        applyLibrarySelection();
        break;

      case "Delete":
      case "Backspace":
        if (controls.filter.value === "bookmarks") {
          if (removeSelectedBookmark()) {
            event.preventDefault();
            event.stopPropagation();
          }
        } else if (removeSelectedCustomFont()) {
          event.preventDefault();
          event.stopPropagation();
        }
        break;
    }
  }

  function refreshInstalledFonts() {
    const previous = selectedLibraryFont || settings.font;
    try {
      installedFonts = enumerateInstalledFonts();
      seedAvailableDefaultBookmarks();
      controls.libraryTitle.textContent = `System Font (${installedFonts.length})`;
      refreshQuickSelector();
      renderFontLibrary(previous);
      log(`Refreshed ${installedFonts.length} installed font families.`);
    } catch (err) {
      error("Font enumeration failed:", err);
      controls.count.textContent = "Font enumeration failed";
    }
  }

  // ========================================================================
  // Main selector / panel refresh
  // ========================================================================

  function updateSelectedFontBookmark() {
    if (!controls?.selectedFontBookmark) return;
    const name = controls.fontSelect.value || settings.font;
    const saved = isBookmarked(name);
    controls.selectedFontBookmark.textContent = saved ? "★" : "☆";
    controls.selectedFontBookmark.classList.toggle("is-bookmarked", saved);
    controls.selectedFontBookmark.setAttribute("aria-pressed", String(saved));
    controls.selectedFontBookmark.setAttribute("aria-label", saved
      ? `Remove ${name} bookmark`
      : `Bookmark ${name}`);
    controls.selectedFontBookmark.title = saved ? "Remove bookmark" : "Bookmark selected font";
  }

  function refreshQuickSelector() {
    if (!controls) return;
    const select = controls.fontSelect;
    while (select.firstChild) select.firstChild.remove();

    const bookmarkedNames = sortFonts(settings.bookmarks);
    const remainingNames = sortFonts([
      ...installedFonts,
      ...settings.customFonts,
      settings.font,
      settings.interfaceFont,
    ]).filter(name => !isBookmarked(name));

    const addGroup = (label, names, bookmarked) => {
      if (!names.length) return;
      const group = element("optgroup");
      group.label = label;
      for (const name of names) {
        const option = element("option", "", `${bookmarked ? "★ " : ""}${name}`);
        option.value = name;
        group.appendChild(option);
      }
      select.appendChild(group);
    };
    addGroup("★ Bookmarks", bookmarkedNames, true);
    addGroup("All fonts", remainingNames, false);

    select.value = settings.font;
    if (select.value !== settings.font) {
      const fallback = element("option", "", settings.font);
      fallback.value = settings.font;
      select.appendChild(fallback);
      select.value = settings.font;
    }

    // Main sample preview intentionally uses the selected page/shared font.
    controls.preview.style.fontFamily = `${cssString(settings.font)}, sans-serif`;

    // The independent interface selector offers the same complete family list
    // as the System Font library, including installed and custom names.
    const interfaceSelect = controls.interfaceFontSelect;
    while (interfaceSelect.firstChild) interfaceSelect.firstChild.remove();
    const systemGroup = element("optgroup");
    systemGroup.label = "Available system fonts";
    for (const name of allFontNames()) {
      const option = element("option", "", name);
      option.value = name;
      systemGroup.appendChild(option);
    }
    interfaceSelect.appendChild(systemGroup);
    interfaceSelect.value = settings.interfaceFont || settings.font;
    if (interfaceSelect.value !== (settings.interfaceFont || settings.font)) {
      interfaceSelect.value = settings.font;
    }
    controls.interfaceFontPreview.style.fontFamily =
      `${cssString(interfaceFontValue())}, sans-serif`;
    controls.separateInterfaceCheckbox.checked = !!settings.separateInterfaceFont;
    controls.interfaceFontPicker.hidden = !settings.separateInterfaceFont;
  }

  function refreshPanel() {
    if (!controls) return;
    controls.interfaceCheckbox.checked = settings.interface;
    controls.pagesCheckbox.checked = settings.pages;
    controls.pageExceptionsCheckbox.checked = false;
    refreshQuickSelector();
    updateSelectedFontBookmark();

    const synchronizedFont = pendingLibrarySelectionSync;
    pendingLibrarySelectionSync = "";
    renderFontLibrary(
      synchronizedFont || selectedLibraryFont || settings.font,
      false,
      !!synchronizedFont
    );
  }

  // Reapply the stylesheet and refresh controls after preferences change.
  // This is shared by the font selector, bookmark changes and cross-window sync.
  function applyAll() {
    applyPageStyle();
    applyInterfaceStyle();
    refreshPanel();

    // Page observers exist only while page-font styling is enabled. Turning
    // the option off disconnects every observer and removes injected Shadow
    // DOM styles instead of leaving a background scanner attached to sites.
    if (settings.pages) {
      installShadowDOMIntegration();
      refreshShadowDOMStyles();
    } else {
      cleanupShadowDOMIntegration();
    }

    forceImmediateRefresh();
  }

  // ========================================================================
  // Panel visibility and keyboard shortcuts
  // ========================================================================

  function openPanel() {
    if (!panel?.isConnected) createPanel();
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    log("Font window opened.");
  }

  function closePanel() {
    if (!panel) return;
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    log("Font window closed.");
  }

  function togglePanel() {
    if (!panel?.isConnected) createPanel();
    if (panel.classList.contains("is-open")) closePanel();
    else openPanel();
  }

  function isFKey(event) {
    return event.code === "KeyF" || String(event.key || "").toLowerCase() === "f";
  }

  function onKeyDown(event) {
    if (!event.isTrusted || event.repeat || event.isComposing) return;

    // The old Ctrl+Alt+F chord was previously used by Font Changer and can
    // collide with Zen's URL-bar shortcut. Consume it without opening anything.
    // Do not intercept AltGr-generated characters on international layouts.
    const isAltGraph = event.getModifierState?.("AltGraph") === true;
    const oldChord = event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && isFKey(event);

    if (oldChord && !isAltGraph) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      log("Legacy Ctrl+Alt+F suppressed; use Ctrl+Shift+F.");

      // If a previous v2/v3 script opened its old XUL popup before this handler,
      // dismiss that stale popup. The current window is a separate HTML overlay.
      try {
        const oldPanel = document.getElementById("uc-font-changer-panel");
        if (oldPanel && oldPanel !== panel) {
          oldPanel.hidePopup?.();
          oldPanel.remove();
        }
      } catch (_) {}
      return;
    }

    const newChord = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && isFKey(event);

    if (newChord) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      log("Ctrl+Shift+F detected.");
      togglePanel();
      return;
    }

    if (event.key === "Escape" && panel?.classList.contains("is-open")) {
      closePanel();
    }
  }

  // ========================================================================
  // Cross-window preference synchronization
  // ========================================================================

  const prefObserver = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed" || writingPrefs || !data || !data.startsWith(PREF_ROOT)) return;
      if (refreshPending) return;
      refreshPending = true;

      window.setTimeout(() => {
        refreshPending = false;
        if (window.closed || cleanedUp) return;
        try {
          settings = readSettings();
          applyAll();
          log("Settings synchronized from another browser window.");
        } catch (err) {
          error("Preference synchronization failed:", err);
        }
      }, 0);
    },
  };

  // ========================================================================
  // Cleanup / diagnostics
  // ========================================================================

  function status() {
    const result = {
      version: VERSION,
      shortcut: "Ctrl+Shift+F",
      legacyCtrlAltF: "suppressed",
      font: settings.font,
      pages: settings.pages,
      interface: settings.interface,
      protectPageExceptions: settings.protectPageExceptions,
      separateInterfaceFont: settings.separateInterfaceFont,
      interfaceFont: interfaceFontValue(),
      installedFontFamilies: installedFonts.length,
      customFonts: settings.customFonts.length,
      bookmarks: settings.bookmarks.length,
      panelOpen: !!panel?.classList.contains("is-open"),
      panelPosition: panel ? (() => {
        const r = panel.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      })() : null,
      draggable: !!controls?.titlebar,
      bookmarkNavigation: !!controls?.fontList,
      typeAhead: {
        selectedFontSelector: !!controls?.fontSelect,
        systemFontList: !!controls?.fontList,
        repeatLetterCycles: true,
        multiLetterPrefix: true,
        timeoutMs: TYPEAHEAD_TIMEOUT_MS,
      },
      applyButton: controls?.applyButton ? {
        fontSize: window.getComputedStyle(controls.applyButton).fontSize,
        boxShadow: window.getComputedStyle(controls.applyButton).boxShadow,
        textShadow: window.getComputedStyle(controls.applyButton).textShadow,
      } : null,
      selectedLibraryFont,
      fontSelectionState: {
        activeFont: settings.font,
        systemFontSelection: selectedLibraryFont,
        synchronized: settings.font.toLocaleLowerCase() === selectedLibraryFont.toLocaleLowerCase(),
        pendingSync: !!pendingLibrarySelectionSync,
      },
      panelExcludedFromGlobalFontRule: UI_EXTRA_EXCLUSIONS.includes(`#${PANEL_ID} *`),
      nativeSelectPopupExcludedFromGlobalFontRule:
        UI_EXTRA_EXCLUSIONS.includes("#ContentSelectDropdown") &&
        UI_EXTRA_EXCLUSIONS.includes("#ContentSelectDropdown *"),
      iconFontProtectionSelectors: ICON_FONT_EXCLUSIONS.length,
      iconFontProtectionAlwaysOn: true,
      explicitTinyMCEIconProtection: ICON_FONT_EXCLUSIONS.includes(".mce-ico"),
      explicitDashiconsProtection: ICON_FONT_EXCLUSIONS.includes(".dashicons"),
      notificationIconProtection: {
        wrapper: ICON_EXCLUSIONS.includes(".notification-icon"),
        descendants: ICON_EXCLUSIONS.includes(".notification-icon *"),
        subtreeProtected: ICON_EXCLUSIONS.includes(".notification-icon") &&
          ICON_EXCLUSIONS.includes(".notification-icon *"),
      },
      tweetTopIconProtection: {
        wrapper: ICON_EXCLUSIONS.includes(".tweet-top-icon"),
        descendants: ICON_EXCLUSIONS.includes(".tweet-top-icon *"),
        subtreeProtected: ICON_EXCLUSIONS.includes(".tweet-top-icon") &&
          ICON_EXCLUSIONS.includes(".tweet-top-icon *"),
      },
      siteSpecificPageExceptionSelectors: PAGE_SPECIFIC_EXCLUSIONS.length,
      activePageExceptionProtection: settings.protectPageExceptions,
      inlineIconFontFamilyProtections: ICON_FONT_EXCLUSIONS.filter(x => x.startsWith('[style*=')).length,
      tooltipAgentSheetRegistered: (() => {
        try {
          const spec = getActiveTooltipSheetSpec();
          return !!spec && sheetService.sheetRegistered(
            io.newURI(spec),
            sheetService.AGENT_SHEET
          );
        } catch (_) {
          return false;
        }
      })(),
      shadowDOM: shadowDOMStatus(),
    };
    log("Status:", result);
    return result;
  }

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    window.removeEventListener("keydown", onKeyDown, true);
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    window.removeEventListener("unload", cleanup);
    cleanupShadowDOMIntegration();

    try {
      prefs.removeObserver(PREF_ROOT, prefObserver);
    } catch (err) {
      warn("Preference observer cleanup failed:", err);
    }

    try {
      panel?.remove();
    } catch (_) {}

    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch (_) {}

    // Do not unregister the shared content stylesheet on window unload:
    // another Firefox window may still be using it. A subsequent settings
    // change (or a new script execution) replaces it when necessary.

    try {
      if (window[RUNTIME_KEY] === runtime) delete window[RUNTIME_KEY];
      if (window.__ucFontChangerRuntime_v7 === runtime) delete window.__ucFontChangerRuntime_v7;
      if (window.__ucFontChangerRuntime_v6 === runtime) delete window.__ucFontChangerRuntime_v6;
      if (window.__ucFontChangerDebug === runtime) delete window.__ucFontChangerDebug;
    } catch (_) {}

    log("Runtime cleaned up.");
  }

  const runtime = {
    version: VERSION,
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    status,
    refreshFonts: refreshInstalledFonts,
    refreshNow: forceImmediateRefresh,
    refreshShadowDOM: refreshShadowDOMStyles,
    shadowDOMStatus,
    resetPosition,
    cleanup,
    get fonts() { return [...installedFonts]; },
    get bookmarks() { return [...settings.bookmarks]; },
    get selectedFont() { return selectedLibraryFont; },
    selectFont(name) { selectLibraryFont(name, true); },
    setLibraryFilter(mode) {
      if (!controls || !["all", "bookmarks"].includes(mode)) return false;
      controls.filter.value = mode;
      renderFontLibrary(selectedLibraryFont, true);
      return true;
    },
    applyFont: applyLibrarySelection,
    setInterfaceFont,
    setSeparateInterfaceFont(enabled) {
      settings.separateInterfaceFont = !!enabled;
      if (!settings.separateInterfaceFont) settings.interfaceFont = settings.font;
      else if (!settings.interfaceFont) settings.interfaceFont = settings.font;
      saveSettings();
      return settings.separateInterfaceFont;
    },
    deleteSelected() { return controls?.filter.value === "bookmarks" ? removeSelectedBookmark() : removeSelectedCustomFont(); },
  };

  window[RUNTIME_KEY] = runtime;
  window.__ucFontChangerDebug = runtime;
  window.__ucFontChangerRuntime_v7 = runtime;
  // Keep the legacy debug alias for existing console workflows.
  window.__ucFontChangerRuntime_v6 = runtime;

  // ========================================================================
  // Initialize
  // ========================================================================

  try {
    settings = readSettings();
    seedAvailableDefaultBookmarks();

    // Install keyboard listener before styles and UI work so the shortcut is
    // active immediately after console execution.
    window.addEventListener("keydown", onKeyDown, true);
    prefs.addObserver(PREF_ROOT, prefObserver);

    if (settings.pages) installShadowDOMIntegration();

    applyPageStyle();
    applyInterfaceStyle();
    createPanel();
    refreshShadowDOMStyles();
    forceImmediateRefresh();

    window.addEventListener("unload", cleanup, { once: true });
	/*
    log("========================================");
    log("INITIALIZATION COMPLETE");
    log("Ctrl+Shift+F opens the centered, draggable font window.");
    log("Type-ahead: press a letter to jump to the next matching font; repeated letters cycle matches.");
    log("System Font list supports Up/Down, type-ahead, and Delete in Bookmarks view.");
    log("Default font candidates are ordinary bookmarks when installed; no font family is protected from selection.");
    log("Apply Font updates page/interface styles synchronously and refreshes the visible page.");
    log("Separate interface font toggle is OFF by default; when enabled, the Firefox UI can use an independent font.");
    log("Generic Firefox and extension tooltips use a dedicated AGENT_SHEET.");
    log("Discoverable open Shadow DOM roots and accessible iframe documents are monitored without modifying page prototypes.");
    log("Ctrl+Alt+F is suppressed as a legacy shortcut.");
    log(`Installed font families: ${installedFonts.length}`);
    log(`Saved bookmarks: ${settings.bookmarks.length}`);
    log("Double-click the titlebar to recenter the window.");
    log("Runtime: window.__ucFontChangerRuntime_v7");
    log("Manual refresh: window.__ucFontChangerRuntime_v7.refreshNow()");
    log("Shadow DOM diagnostics: window.__ucFontChangerRuntime_v7.shadowDOMStatus()");
    log("========================================");
	*/
  } catch (err) {
    error("Initialization failed:", err);
    cleanup();
    throw err;
  }
})();
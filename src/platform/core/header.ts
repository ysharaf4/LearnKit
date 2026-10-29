/**
 * @file src/core/header.ts
 * @summary Shared header bar component used by all top-level LearnKit views (Home, Study,
 * Flashcards, Analytics). Renders a dropdown navigation switcher, expand/collapse width
 * toggle, sync button, and a "More" popover with split-pane and settings actions. Manages
 * popover lifecycle, keyboard navigation, Obsidian theme synchronisation, and
 * ResizeObserver-based responsive visibility of the width toggle.
 *
 * @exports
 *   - LearnKitHeaderPage — type alias for the four navigation page identifiers
 *   - LearnKitHeaderMenuItem — type for items rendered in the More popover menu
 *   - LearnKitHeader — class that installs and manages the header bar DOM
 *   - createViewHeader — factory function that wires a LearnKitHeader to any ItemView
 */
import { MAX_CONTENT_WIDTH, VIEW_TYPE_ANALYTICS, VIEW_TYPE_BROWSER, VIEW_TYPE_REVIEWER, VIEW_TYPE_HOME, VIEW_TYPE_SETTINGS, VIEW_TYPE_NOTE_REVIEW, VIEW_TYPE_EXAM_GENERATOR, VIEW_TYPE_COACH } from "./constants";
import { App, ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { log } from "./logger";
import { placePopover, queryFirst, setCssProps } from "./ui";
import { clearNode } from "./shared-utils";
import { KeyboardShortcutsModal } from "../modals/keyboard-shortcuts-modal";
import { LearnKitCommandPalette } from "./command-palette";
import type LearnKitPlugin from "../../main";
import { LearnKitSettingsView } from "../../views/settings/view/settings-view";
import { t } from "../translations/translator";
import { makeEl, makeSvgEl } from "./dom-factory";

export type LearnKitHeaderPage = "home" | "cards" | "notes" | "exam" | "coach" | "analytics" | "library" | "settings";

export type LearnKitHeaderMenuItem = {
  type?: "action" | "section" | "separator";
  label: string;
  icon?: string; // lucide name used by setIcon
  onActivate?: () => void;
  destructive?: boolean;
};

type Deps = {
  app: App;
  leaf: WorkspaceLeaf;
  plugin?: LearnKitPlugin;

  // the view container (ItemView.containerEl)
  containerEl: HTMLElement;

  // current “wide” state + toggle
  getIsWide: () => boolean;
  toggleWide: () => void;

  // sync action
  runSync: () => void;

  // optional: called after nav
  afterNavigate?: () => void;
};

/** Null-safe alias for clearNode. */
function clearChildren(node: HTMLElement | null) {
  clearNode(node);
}

function isPhoneLayout(): boolean {
  if (typeof Platform !== "undefined" && Platform.isPhone) return true;
  if (typeof activeDocument !== "undefined" && activeDocument.body?.classList?.contains("is-phone")) return true;
  return false;
}

export class LearnKitHeader {
  private deps: Deps;

  private headerNavId: string;
  private topNavPopoverEl: HTMLElement | null = null;
  private topNavWrapperEl: HTMLElement | null = null;
  private topNavCleanup: (() => void) | null = null;

  private moreId: string;
  private moreTriggerEl: HTMLButtonElement | null = null;
  private morePopoverEl: HTMLElement | null = null;
  private moreWrapperEl: HTMLElement | null = null;
  private moreCleanup: (() => void) | null = null;

  private widthBtnEl: HTMLButtonElement | null = null;
  private widthBtnIconEl: HTMLElement | null = null;
  private widthResizeCleanup: (() => void) | null = null;
  private widthResizeObserver: ResizeObserver | null = null;

  private syncBtnIconEl: HTMLElement | null = null;
  private themeObserver: MutationObserver | null = null;
  // Theme button and mode removed; now syncs with Obsidian

  private cmdPalette: LearnKitCommandPalette | null = null;
  private cmdPaletteBtnEl: HTMLButtonElement | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
    this.headerNavId = `learnkit-topnav-${Math.random().toString(36).slice(2, 9)}`;
    this.moreId = `lk-more-${Math.random().toString(36).slice(2, 9)}`;
  }

  private tx(token: string, fallback: string, vars?: Record<string, string | number>): string {
    return t(this.deps.plugin?.settings?.general?.interfaceLanguage, token, fallback, vars);
  }

  private pageLabel(page: LearnKitHeaderPage): string {
    return page === "home"
      ? this.tx("ui.header.page.home", "Home")
      : page === "cards"
        ? this.tx("ui.header.page.flashcards", "Flashcards")
        : page === "notes"
          ? this.tx("ui.header.page.notes", "Notes")
          : page === "exam"
            ? this.tx("ui.header.page.tests", "Tests")
            : page === "coach"
              ? this.tx("ui.header.page.coach", "Coach")
              : page === "analytics"
                ? this.tx("ui.header.page.analytics", "Analytics")
                : page === "library"
                  ? this.tx("ui.header.page.library", "Library")
                  : this.tx("ui.header.page.settings", "Settings");
  }

  private installCenterBrandLogo(viewHeader: HTMLElement) {
    let brandHost =
      queryFirst<HTMLElement>(viewHeader, ":scope > .learnkit-header-center-brand") ??
      queryFirst<HTMLElement>(viewHeader, ".learnkit-header-center-brand");

    if (!brandHost) {
      brandHost = makeEl("div", this.deps.containerEl.ownerDocument);
      brandHost.className = "learnkit-header-center-brand";

      const actionsHost =
        queryFirst<HTMLElement>(viewHeader, ":scope > .view-actions") ??
        queryFirst<HTMLElement>(viewHeader, ".view-actions");
      if (actionsHost) viewHeader.insertBefore(brandHost, actionsHost);
      else viewHeader.appendChild(brandHost);
    }

    clearChildren(brandHost);

    const homeLink = makeEl("a", this.deps.containerEl.ownerDocument);
    homeLink.className = "learnkit-header-center-brand-link";
    homeLink.href = "#";
    homeLink.setAttribute("role", "link");
    brandHost.appendChild(homeLink);

    const logo = makeEl("span", this.deps.containerEl.ownerDocument);
    logo.className = "learnkit-header-center-brand-icon";
    setIcon(logo, "learnkit-brand-horizontal");

    const outerSvg = logo.querySelector(":scope > svg");
    if (outerSvg) {
      outerSvg.removeAttribute("aria-tooltip");
      outerSvg.removeAttribute("aria-label");
      outerSvg.removeAttribute("aria-description");
      outerSvg.removeAttribute("title");
    }

    const innerSvg = logo.querySelector(":scope > svg > svg");
    if (innerSvg) {
      innerSvg.setAttribute("aria-label", this.tx("ui.header.home", "Home"));
      innerSvg.setAttribute("aria-description", this.tx("ui.header.goHome", "Go to home"));
      innerSvg.removeAttribute("aria-tooltip");
      innerSvg.removeAttribute("title");
      innerSvg.removeAttribute("aria-hidden");
      const innerViewBox = innerSvg.getAttribute("viewBox");
      if (innerViewBox && outerSvg) {
        // Match the icon wrapper viewport to the source logo viewport to avoid square-letterboxing.
        outerSvg.setAttribute("viewBox", innerViewBox);
      }
      this.enhanceCenterBrandLogoInteractions(innerSvg);
    }

    homeLink.appendChild(logo);

    const goHome = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.navigate("home");
    };
    homeLink.addEventListener("click", goHome);
    homeLink.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") goHome(ev);
    });
  }

  private enhanceCenterBrandLogoInteractions(innerSvg: Element) {
    if (innerSvg.nodeType !== Node.ELEMENT_NODE) return;
    if (innerSvg.tagName.toLowerCase() !== "svg") return;

    const LOGO_HIT_STROKE_WIDTH = 10;

    const svgHost = innerSvg.closest<HTMLElement>(".svg-icon");
    if (!svgHost) return;

    const logoPaths: SVGPathElement[] = [];
    let clearHoverTimer: number | null = null;
    const pathVisualOrder = new Map<SVGPathElement, number>();

    const randomFloat = (min: number, max: number) => min + Math.random() * (max - min);
    const randomSignedDeg = (minAbs: number, maxAbs: number) => {
      const sign = Math.random() < 0.5 ? -1 : 1;
      return `${(sign * randomFloat(minAbs, maxAbs)).toFixed(2)}deg`;
    };

    const applyRandomHoverMotion = () => {
      svgHost.style.setProperty("--logo-active-translate", `${randomFloat(7.6, 9.8).toFixed(2)}px`);
      svgHost.style.setProperty("--logo-active-scale", randomFloat(1.17, 1.22).toFixed(3));
      svgHost.style.setProperty("--logo-active-rotate", randomSignedDeg(4.8, 7.8));
      svgHost.style.setProperty("--logo-active-brightness", randomFloat(1.33, 1.43).toFixed(3));

      svgHost.style.setProperty("--logo-neighbor-translate", `${randomFloat(4.8, 6.4).toFixed(2)}px`);
      svgHost.style.setProperty("--logo-neighbor-scale", randomFloat(1.08, 1.12).toFixed(3));
      svgHost.style.setProperty("--logo-neighbor-rotate", randomSignedDeg(1.1, 2.9));
      svgHost.style.setProperty("--logo-neighbor-brightness", randomFloat(1.16, 1.24).toFixed(3));

      svgHost.style.setProperty("--logo-next-translate", `${randomFloat(1.6, 3.3).toFixed(2)}px`);
      svgHost.style.setProperty("--logo-next-scale", randomFloat(1.035, 1.065).toFixed(3));
      svgHost.style.setProperty("--logo-next-rotate", randomSignedDeg(0.45, 1.7));
      svgHost.style.setProperty("--logo-next-brightness", randomFloat(1.08, 1.15).toFixed(3));
    };

    const resetExitTiming = () => {
      for (const logoPath of logoPaths) {
        logoPath.style.removeProperty("--logo-in-delay");
        logoPath.style.removeProperty("--logo-out-delay");
        logoPath.style.removeProperty("--logo-out-duration");
        logoPath.style.removeProperty("--logo-out-delay-scale");
        logoPath.style.removeProperty("--logo-out-delay-rotate");
      }
    };

    const applyRandomExitTiming = () => {
      for (const logoPath of logoPaths) {
        // Bubble-pop feel: each symbol waits a little, then scale/rotation unwind in varied order.
        const outDelay = 250 + Math.floor(Math.random() * 380);
        const outDuration = 180 + Math.floor(Math.random() * 170);
        const phaseGap = 90 + Math.floor(Math.random() * 140);
        const rotateFirst = Math.random() < 0.5;
        const scaleDelay = rotateFirst ? outDelay + phaseGap : outDelay;
        const rotateDelay = rotateFirst ? outDelay : outDelay + phaseGap;
        logoPath.style.setProperty("--logo-out-delay", `${outDelay}ms`);
        logoPath.style.setProperty("--logo-out-duration", `${outDuration}ms`);
        logoPath.style.setProperty("--logo-out-delay-scale", `${scaleDelay}ms`);
        logoPath.style.setProperty("--logo-out-delay-rotate", `${rotateDelay}ms`);
      }
    };

    const setNeighborLevels = (activeIndex: number) => {
      const activePath = logoPaths[activeIndex - 1];
      const activeOrder = activePath ? pathVisualOrder.get(activePath) : undefined;
      if (activeOrder === undefined) return;

      for (const logoPath of logoPaths) {
        const order = pathVisualOrder.get(logoPath);
        if (order === undefined) continue;
        const level = Math.min(3, Math.abs(order - activeOrder));
        logoPath.setAttribute("data-logo-level", String(level));
      }
    };

    const applyRandomNeighborInTiming = () => {
      for (const logoPath of logoPaths) {
        const logoPathEl = logoPath as unknown as HTMLElement;
        const level = logoPath.getAttribute("data-logo-level");
        if (level === "0") {
          setCssProps(logoPathEl, "--logo-in-delay", "0ms");
        } else if (level === "1") {
          const neighborDelay = 40 + Math.floor(Math.random() * 150);
          setCssProps(logoPathEl, "--logo-in-delay", `${neighborDelay}ms`);
        } else {
          setCssProps(logoPathEl, "--logo-in-delay", "0ms");
        }
      }
    };

    const clearHover = () => {
      if (clearHoverTimer !== null) {
        window.clearTimeout(clearHoverTimer);
        clearHoverTimer = null;
      }

      applyRandomExitTiming();

      // Keep the active state briefly before release so the shrink feels delayed.
      const holdBeforeReleaseMs = 300 + Math.floor(Math.random() * 180);
      clearHoverTimer = window.setTimeout(() => {
        svgHost.removeAttribute("data-hover-path");
        clearHoverTimer = null;
      }, holdBeforeReleaseMs);
    };

    // Remove stale hit targets if this icon is re-initialized.
    innerSvg.querySelectorAll(".learnkit-logo-hit-target").forEach((node) => node.remove());

    const paths = Array.from(innerSvg.querySelectorAll("path"));
    for (let i = 0; i < paths.length; i += 1) {
      const index = i + 1;
      const path = paths[i];
      path.setAttribute("data-logo-path", String(index));
      path.setAttribute("data-logo-shape", "true");
      logoPaths.push(path);

      const hit = path.cloneNode(false) as SVGPathElement;
      hit.classList.add("learnkit-logo-hit-target", "learnkit-logo-hit-target");
      hit.setAttribute("data-logo-hit", String(index));
      hit.removeAttribute("data-logo-shape");
      hit.removeAttribute("data-logo-path");
      hit.setAttribute("fill", "none");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", String(LOGO_HIT_STROKE_WIDTH));
      hit.setAttribute("vector-effect", "non-scaling-stroke");
      hit.setAttribute("pointer-events", "stroke");
      hit.setAttribute("aria-hidden", "true");

      const setHover = () => {
        if (clearHoverTimer !== null) {
          window.clearTimeout(clearHoverTimer);
          clearHoverTimer = null;
        }
        applyRandomHoverMotion();
        resetExitTiming();
        setNeighborLevels(index);
        applyRandomNeighborInTiming();
        svgHost.setAttribute("data-hover-path", String(index));
      };

      path.addEventListener("pointerenter", setHover);
      path.addEventListener("pointermove", setHover);
      hit.addEventListener("pointerenter", setHover);
      hit.addEventListener("pointermove", setHover);

      innerSvg.appendChild(hit);
    }

    const getPathStartX = (path: SVGPathElement): number | null => {
      const d = path.getAttribute("d") || "";
      const match = d.match(/[Mm]\s*([-+]?\d*\.?\d+)/);
      if (!match) return null;
      const n = Number(match[1]);
      return Number.isFinite(n) ? n : null;
    };

    const getPathCenterX = (path: SVGPathElement): number => {
      // Prefer geometric center from path data because DOM path order may be arbitrary (e.g. 3,2,1,4).
      const startX = getPathStartX(path);
      if (startX !== null) return startX;

      try {
        const box = path.getBBox();
        const centerX = box.x + box.width / 2;
        if (Number.isFinite(centerX)) return centerX;
      } catch {
        // Ignore getBBox failures and use fallback below.
      }

      return 0;
    };

    // Build visual left-to-right order so neighbor falloff matches actual icon position.
    const orderedPaths = [...logoPaths].sort((a, b) => getPathCenterX(a) - getPathCenterX(b));
    for (let i = 0; i < orderedPaths.length; i += 1) {
      pathVisualOrder.set(orderedPaths[i], i);
    }

    innerSvg.addEventListener("pointerleave", clearHover);
  }

  dispose() {
    this.cmdPalette?.dispose();
    this.cmdPalette = null;
    this.closeTopNavPopover();
    this.closeMorePopover();
    try {
      this.widthResizeCleanup?.();
    } catch (e) { log.swallow("dispose: widthResizeCleanup", e); }
    this.widthResizeCleanup = null;
    try {
      this.widthResizeObserver?.disconnect();
    } catch (e) { log.swallow("dispose: widthResizeObserver disconnect", e); }
    this.widthResizeObserver = null;
    try {
      this.themeObserver?.disconnect();
    } catch (e) { log.swallow("dispose: themeObserver disconnect", e); }
    this.themeObserver = null;
  }

  install(active: LearnKitHeaderPage) {
    const viewHeader =
      queryFirst<HTMLElement>(this.deps.containerEl, ":scope > .view-header") ??
      queryFirst<HTMLElement>(this.deps.containerEl, ".view-header");
    if (viewHeader) {
      viewHeader.classList.add("learnkit-header", "learnkit-header");
      // Wrap header in a transparent container if not already wrapped
      if (!viewHeader.parentElement?.classList.contains("learnkit-header-wrap")) {
        const wrap = makeEl("div", this.deps.containerEl.ownerDocument);
        wrap.className = "learnkit-header-wrap";
        viewHeader.parentElement?.insertBefore(wrap, viewHeader);
        wrap.appendChild(viewHeader);
      }

      this.installCenterBrandLogo(viewHeader);
    }

    this.installHeaderActionsButtonGroup(active);
    this.installHeaderDropdownNav(active);

    this.updateWidthButtonLabel();
    this.updateSyncButtonIcon();
    this.syncThemeWithObsidian();

    // Ensure More is CLOSED on install
    this.closeMorePopover();
  }

  updateWidthButtonLabel() {
    if (!this.widthBtnEl) return;

    const isWide = this.deps.getIsWide();
    // Only hide if the available header space is too narrow, not based on the button group width
    const header =
      (this.deps.containerEl ? queryFirst(this.deps.containerEl, ":scope > .view-header") : null) ??
      (this.deps.containerEl ? queryFirst(this.deps.containerEl, ".view-header") : null);
    const availableWidth = header?.clientWidth ?? this.deps.containerEl?.clientWidth ?? 0;
    const hide =
      isPhoneLayout() ||
      (availableWidth > 0 ? availableWidth <= 640 : typeof window !== "undefined" && window.innerWidth <= 640);
    this.widthBtnEl.classList.toggle("learnkit-is-hidden", hide);
    this.widthBtnEl.setAttribute("aria-label", this.tx("ui.header.expandCollapse", "Expand / collapse page"));
    this.widthBtnEl.setAttribute("data-tooltip-position", "bottom");

    if (this.widthBtnIconEl) {
      clearChildren(this.widthBtnIconEl);
      setIcon(this.widthBtnIconEl, isWide ? "minimize-2" : "maximize-2");
    }
  }

  updateSyncButtonIcon() {
    if (!this.syncBtnIconEl) return;
    clearChildren(this.syncBtnIconEl);
    setIcon(this.syncBtnIconEl, "refresh-cw");
  }


  // Sync theme with Obsidian and append .theme-dark to .learnkit wrapper
  private syncThemeWithObsidian() {
    const updateTheme = () => {
      const isDark = activeDocument.body.classList.contains("theme-dark");
      const learnkit = this.deps.containerEl?.closest('.learnkit');
      if (learnkit) {
        learnkit.classList.toggle("theme-dark", isDark);
        learnkit.classList.toggle("theme-light", !isDark);
      }
    };
    updateTheme();
    // Listen for Obsidian theme changes
    this.themeObserver?.disconnect();
    this.themeObserver = new MutationObserver(updateTheme);
    this.themeObserver.observe(activeDocument.body, { attributes: true, attributeFilter: ["class"] });
  }

  // ---------------------------
  // Navigation
  // ---------------------------

  private async navigate(page: LearnKitHeaderPage) {
    const type =
      page === "home"
        ? VIEW_TYPE_HOME
        : page === "cards"
          ? VIEW_TYPE_REVIEWER
          : page === "notes"
            ? VIEW_TYPE_NOTE_REVIEW
          : page === "exam"
            ? VIEW_TYPE_EXAM_GENERATOR
          : page === "coach"
            ? VIEW_TYPE_COACH
          : page === "analytics"
            ? VIEW_TYPE_ANALYTICS
            : page === "library"
              ? VIEW_TYPE_BROWSER
              : VIEW_TYPE_SETTINGS;

    await this.deps.leaf.setViewState?.({ type, active: true });
    void this.deps.app.workspace.revealLeaf(this.deps.leaf);
    this.deps.afterNavigate?.();
  }

  private switchSettingsTab(tab: "settings" | "guide" | "about", reanimate = true) {
    window.setTimeout(() => {
      const settingsLeaf = this.deps.leaf;
      const view = settingsLeaf?.view as {
        navigateToTab?: (tabId: string, options?: { reanimateEntrance?: boolean }) => void;
      } | undefined;
      if (view && typeof view.navigateToTab === "function") {
        view.navigateToTab(tab, { reanimateEntrance: reanimate });
      }
    }, 100);
  }

  private openSettingsTab(tab: "settings" | "guide" | "about") {
    const wasAlreadySettings =
      this.deps.leaf?.view?.getViewType?.() === VIEW_TYPE_SETTINGS;
    if (!wasAlreadySettings && tab !== "settings") {
      LearnKitSettingsView.pendingInitialTab = tab;
    }
    void this.navigate("settings");
    if (wasAlreadySettings) {
      // Leaf already shows settings — switch tab with entrance animation.
      this.switchSettingsTab(tab, true);
    }
  }

  // ---------------------------
  // Top Nav popover (radio)
  // ---------------------------

  /** Detaches a portalled popover wrapper from <body>, swallowing teardown races. */
  private removeWrapper(wrapper: HTMLElement | null, context: string): void {
    if (!wrapper) return;
    try {
      wrapper.remove();
    } catch (e) { log.swallow(`${context}: remove popover wrapper`, e); }
  }

  private closeTopNavPopover() {
    try {
      this.topNavCleanup?.();
    } catch (e) { log.swallow("closeTopNavPopover: topNavCleanup", e); }
    this.topNavCleanup = null;

    if (this.topNavPopoverEl) {
      try {
        this.topNavPopoverEl.classList.remove("is-open");
        this.topNavPopoverEl.remove();
      } catch (e) { log.swallow("closeTopNavPopover: remove popover element", e); }
    }
    this.topNavPopoverEl = null;

    // The popover is portalled to <body> inside a wrapper; removing only the panel leaves an
    // empty, body-level `.learnkit` node behind on every open/close (the same class of leftover
    // `_sweepOrphanedBodyPortals` has to clean up after an update).
    this.removeWrapper(this.topNavWrapperEl, "closeTopNavPopover");
    this.topNavWrapperEl = null;

    const trigger = queryFirst(this.deps.containerEl, `#${this.headerNavId}-trigger`);
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  private openTopNavPopover(trigger: HTMLElement, active: LearnKitHeaderPage) {
    this.closeTopNavPopover();
    trigger.setAttribute("aria-expanded", "true");

    const learnkitWrapper = makeEl("div", this.deps.containerEl.ownerDocument);
    learnkitWrapper.className = "learnkit";
    const root = makeEl("div", this.deps.containerEl.ownerDocument);
    root.className = "dropdown-menu";
    root.classList.add("learnkit-popover-overlay", "learnkit-popover-overlay");
    learnkitWrapper.appendChild(root);

    const panel = makeEl("div", this.deps.containerEl.ownerDocument);
    panel.className = "min-w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 learnkit-pointer-auto learnkit-header-menu-panel";
    root.appendChild(panel);

    const menu = makeEl("div", this.deps.containerEl.ownerDocument);
    menu.setAttribute("role", "menu");
    menu.className = "flex flex-col";
    panel.appendChild(menu);

    const mkNavItem = (label: string, page: LearnKitHeaderPage, icon?: string, showBeta = false) => {
      const item = makeEl("div", this.deps.containerEl.ownerDocument);
      item.className =
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer select-none outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";
      item.setAttribute("role", "menuitem");
      if (active === page) item.setAttribute("aria-current", "page");
      item.tabIndex = 0;

      if (icon) {
        const ic = makeEl("span", this.deps.containerEl.ownerDocument);
        ic.className =
          "inline-flex items-center justify-center [&_svg]:size-4 text-muted-foreground group-hover:text-inherit group-focus:text-inherit";
        ic.setAttribute("aria-hidden", "true");
        setIcon(ic, icon);
        item.appendChild(ic);
      }

      const txt = makeEl("span", this.deps.containerEl.ownerDocument);
      txt.textContent = label;
      item.appendChild(txt);

      if (showBeta) {
        const beta = makeEl("em", this.deps.containerEl.ownerDocument);
        beta.className = "text-xs text-muted-foreground group-hover:text-inherit group-focus:text-inherit";
        beta.textContent = this.tx("ui.common.beta", "Beta");
        item.appendChild(beta);
      }

      const activate = () => {
        this.closeTopNavPopover();
        void this.navigate(page);
      };

      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        activate();
      });

      item.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ev.stopPropagation();
          activate();
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          this.closeTopNavPopover();
          (trigger).focus();
        }
      });

      menu.appendChild(item);
    };

    const mkActionItem = (label: string, onActivate: () => void, icon?: string) => {
      const item = makeEl("div", this.deps.containerEl.ownerDocument);
      item.className =
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer select-none outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";
      item.setAttribute("role", "menuitem");
      item.tabIndex = 0;

      if (icon) {
        const ic = makeEl("span", this.deps.containerEl.ownerDocument);
        ic.className =
          "inline-flex items-center justify-center [&_svg]:size-4 text-muted-foreground group-hover:text-inherit group-focus:text-inherit";
        ic.setAttribute("aria-hidden", "true");
        setIcon(ic, icon);
        item.appendChild(ic);
      }

      const txt = makeEl("span", this.deps.containerEl.ownerDocument);
      txt.textContent = label;
      item.appendChild(txt);

      const activate = () => {
        this.closeTopNavPopover();
        onActivate();
      };

      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        activate();
      });

      item.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ev.stopPropagation();
          activate();
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          this.closeTopNavPopover();
          trigger.focus();
        }
      });

      menu.appendChild(item);
    };

    const mkSection = (label: string) => {
      const item = makeEl("div", this.deps.containerEl.ownerDocument);
      item.className = "px-2 py-1.5 text-sm text-muted-foreground";
      item.textContent = label;
      item.setAttribute("role", "presentation");
      menu.appendChild(item);
    };

    const mkSep = () => {
      const sep = makeEl("div", this.deps.containerEl.ownerDocument);
      sep.className = "my-1 h-px bg-border";
      sep.setAttribute("role", "separator");
      menu.appendChild(sep);
    };

    mkNavItem(this.tx("ui.header.page.home", "Home"), "home", "house");
    mkSep();
    mkSection(this.tx("ui.header.section.study", "Study"));
    mkNavItem(this.tx("ui.header.page.coach", "Coach"), "coach", "target");
    mkNavItem(this.tx("ui.header.page.flashcards", "Flashcards"), "cards", "star");
    mkNavItem(this.tx("ui.header.page.notes", "Notes"), "notes", "notebook-text");
    mkNavItem(this.tx("ui.header.page.tests", "Tests"), "exam", "clipboard-check");
    mkSep();
    mkSection(this.tx("ui.header.section.tools", "Tools"));
    mkNavItem(this.tx("ui.header.page.analytics", "Analytics"), "analytics", "chart-spline");
    mkNavItem(this.tx("ui.header.page.library", "Library"), "library", "table-2");
    mkSep();
    mkSection(this.tx("ui.header.section.resources", "Resources"));
    mkActionItem(this.tx("ui.header.menu.guide", "Guide"), () => this.openSettingsTab("guide"), "compass");
    mkActionItem(this.tx("ui.header.menu.releaseNotes", "Release notes"), () => this.openSettingsTab("about"), "package");
    mkActionItem(this.tx("ui.header.page.settings", "Settings"), () => this.openSettingsTab("settings"), "settings");

    activeDocument.body.appendChild(learnkitWrapper);
    this.topNavPopoverEl = root;
    this.topNavWrapperEl = learnkitWrapper;
    root.classList.add("is-open");

    const isPhone = isPhoneLayout();
    const place = () => {
      placePopover({
        trigger, panel, popoverEl: root,
        setWidth: false,
        align: isPhone ? "right" : "left",
      });
    };

    window.requestAnimationFrame(() => place());

    const onResizeOrScroll = () => place();
    const onVisualViewportResize = () => place();

    const onDocPointerDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (!t) return;
      if (root.contains(t) || trigger.contains(t)) return;
      this.closeTopNavPopover();
    };

    window.addEventListener("resize", onResizeOrScroll, true);
    window.addEventListener("scroll", onResizeOrScroll, true);
    window.visualViewport?.addEventListener("resize", onVisualViewportResize);

    const bodyObserver = new MutationObserver(() => place());
    bodyObserver.observe(activeDocument.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const tid = window.setTimeout(() => {
      activeDocument.addEventListener("pointerdown", onDocPointerDown, true);
    }, 0);

    this.topNavCleanup = () => {
      window.clearTimeout(tid);
      window.removeEventListener("resize", onResizeOrScroll, true);
      window.removeEventListener("scroll", onResizeOrScroll, true);
      window.visualViewport?.removeEventListener("resize", onVisualViewportResize);
      bodyObserver.disconnect();
      activeDocument.removeEventListener("pointerdown", onDocPointerDown, true);
    };
  }

  private installHeaderDropdownNav(active: LearnKitHeaderPage) {
    const isPhone = isPhoneLayout();
    // Render the page-switcher in the left nav area.
    const navHost = isPhone
      ? ((this.deps.containerEl.querySelector<HTMLElement>(":scope > .view-header .view-actions")) ??
          (this.deps.containerEl.querySelector<HTMLElement>(".view-header .view-actions")))
      : ((this.deps.containerEl.querySelector<HTMLElement>(
          ":scope > .view-header .view-header-left .view-header-nav-buttons",
        )) ??
          (this.deps.containerEl.querySelector<HTMLElement>(".view-header .view-header-left .view-header-nav-buttons")));

    if (!navHost) return;

    clearNode(navHost);
    navHost.classList.add("learnkit-nav-host", "learnkit-nav-host");

    const navRoot = makeEl("div", this.deps.containerEl.ownerDocument);
    navRoot.id = this.headerNavId;
    navRoot.className = "dropdown-menu";
    navRoot.classList.add("learnkit-dropdown-root", "learnkit-dropdown-root");
    navHost.appendChild(navRoot);

    const navTrigger = makeEl("button", this.deps.containerEl.ownerDocument);
    navTrigger.type = "button";
    navTrigger.id = `${this.headerNavId}-trigger`;
    navTrigger.className = "learnkit-btn-toolbar h-7 px-2 text-xs inline-flex items-center gap-2";
    if (isPhone) navTrigger.classList.add("learnkit-mobile-nav-trigger", "learnkit-mobile-nav-trigger");
    navTrigger.setAttribute("aria-haspopup", "menu");
    navTrigger.setAttribute("aria-expanded", "false");
    navTrigger.setAttribute("aria-label", this.tx("ui.header.openMenu", "Open menu"));
    navTrigger.setAttribute("data-tooltip-position", "bottom");
    navRoot.appendChild(navTrigger);

    if (!isPhone) {
      const trigText = makeEl("span", this.deps.containerEl.ownerDocument);
      trigText.className = "truncate";
      trigText.textContent = this.pageLabel(active);
      navTrigger.appendChild(trigText);
    }

    const trigIcon = makeEl("span", this.deps.containerEl.ownerDocument);
    trigIcon.className = "inline-flex items-center justify-center [&_svg]:size-4";
    trigIcon.setAttribute("aria-hidden", "true");
    setIcon(trigIcon, isPhone ? "menu" : "chevron-down");
    navTrigger.appendChild(trigIcon);

    navTrigger.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.topNavPopoverEl) this.closeTopNavPopover();
      else this.openTopNavPopover(navTrigger, active);
    });

    this.closeTopNavPopover();

    // Command palette trigger — hidden for now, keeping wiring intact
    // this.installCommandPaletteButton(navHost, navRoot);
  }

  // ---------------------------
  // Command Palette trigger
  // ---------------------------

  private installCommandPaletteButton(navHost: HTMLElement, beforeEl: HTMLElement) {
    const btn = makeEl("button", this.deps.containerEl.ownerDocument);
    btn.type = "button";
    btn.className = "learnkit-btn-toolbar learnkit-cmd-palette-trigger inline-flex items-center justify-center";
    btn.setAttribute("aria-label", this.tx("ui.commandPalette.title", "Command palette"));
    btn.setAttribute("data-tooltip-position", "bottom");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");

    const ic = makeEl("span", this.deps.containerEl.ownerDocument);
    ic.className = "inline-flex items-center justify-center [&_svg]:size-4";
    ic.setAttribute("aria-hidden", "true");
    setIcon(ic, "command");
    btn.appendChild(ic);

    navHost.insertBefore(btn, beforeEl);

    this.cmdPaletteBtnEl = btn;

    // Lazily create the palette instance
    if (!this.cmdPalette && this.deps.plugin) {
      this.cmdPalette = new LearnKitCommandPalette({
        app: this.deps.app,
        leaf: this.deps.leaf,
        plugin: this.deps.plugin,
        trigger: btn,
        navigate: (page: string) => this.navigate(page as LearnKitHeaderPage),
        runSync: () => this.deps.runSync(),
      });
    } else if (this.cmdPalette) {
      // Re-point trigger if header was rebuilt
      (this.cmdPalette as unknown as { deps: { trigger: HTMLElement } }).deps.trigger = btn;
    }

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.cmdPalette?.toggle();
    });
  }


  // ---------------------------
  // “More” popover (custom)
  // ---------------------------

  private closeMorePopover() {
    try {
      this.moreCleanup?.();
    } catch (e) { log.swallow("closeMorePopover: moreCleanup", e); }
    this.moreCleanup = null;

    if (this.morePopoverEl) {
      try {
        this.morePopoverEl.classList.remove("is-open");
        this.morePopoverEl.remove();
      } catch (e) { log.swallow("closeMorePopover: remove popover element", e); }
    }
    this.morePopoverEl = null;

    this.removeWrapper(this.moreWrapperEl, "closeMorePopover");
    this.moreWrapperEl = null;

    if (this.moreTriggerEl) this.moreTriggerEl.setAttribute("aria-expanded", "false");
  }

  private openMorePopover(trigger: HTMLElement, items: LearnKitHeaderMenuItem[]) {
    this.closeMorePopover();
    this.moreTriggerEl = trigger as HTMLButtonElement;
    trigger.setAttribute("aria-expanded", "true");

    const learnkitWrapper = makeEl("div", this.deps.containerEl.ownerDocument);
    learnkitWrapper.className = "learnkit";
    const root = makeEl("div", this.deps.containerEl.ownerDocument);
    root.className = "dropdown-menu";
    root.classList.add("learnkit-popover-overlay", "learnkit-popover-overlay");
    learnkitWrapper.appendChild(root);

    const panel = makeEl("div", this.deps.containerEl.ownerDocument);
    panel.className = "min-w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 learnkit-pointer-auto learnkit-header-menu-panel";
    root.appendChild(panel);

    const menu = makeEl("div", this.deps.containerEl.ownerDocument);
    menu.setAttribute("role", "menu");
    menu.className = "flex flex-col";
    panel.appendChild(menu);

    for (const it of items) {
      if (it.type === "separator") {
        const separator = makeEl("div", this.deps.containerEl.ownerDocument);
        separator.className = "my-1 h-px bg-border";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
        continue;
      }

      if (it.type === "section") {
        const heading = makeEl("div", this.deps.containerEl.ownerDocument);
        heading.className = "px-2 py-1.5 text-sm text-muted-foreground";
        heading.setAttribute("role", "presentation");
        heading.textContent = it.label;
        menu.appendChild(heading);
        continue;
      }

      const row = makeEl("div", this.deps.containerEl.ownerDocument);
      row.setAttribute("role", "menuitem");
      row.tabIndex = 0;

      row.className =
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer select-none outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground";

      if (it.icon) {
        const ic = makeEl("span", this.deps.containerEl.ownerDocument);
        ic.className =
          "inline-flex items-center justify-center [&_svg]:size-4 text-muted-foreground group-hover:text-inherit";
        ic.setAttribute("aria-hidden", "true");
        if (it.icon === "life-buoy") {
          const svgNs = "http://www.w3.org/2000/svg";
          const svg = makeSvgEl("svg", this.deps.containerEl.ownerDocument);
          svg.setAttribute("xmlns", svgNs);
          svg.setAttribute("width", "24");
          svg.setAttribute("height", "24");
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "2");
          svg.setAttribute("stroke-linecap", "round");
          svg.setAttribute("stroke-linejoin", "round");
          svg.setAttribute("class", "svg-icon lucide-life-buoy");

          const circleOuter = makeSvgEl("circle", this.deps.containerEl.ownerDocument);
          circleOuter.setAttribute("cx", "12");
          circleOuter.setAttribute("cy", "12");
          circleOuter.setAttribute("r", "10");
          svg.appendChild(circleOuter);

          const p1 = makeSvgEl("path", this.deps.containerEl.ownerDocument);
          p1.setAttribute("d", "m4.93 4.93 4.24 4.24");
          svg.appendChild(p1);

          const p2 = makeSvgEl("path", this.deps.containerEl.ownerDocument);
          p2.setAttribute("d", "m14.83 9.17 4.24-4.24");
          svg.appendChild(p2);

          const p3 = makeSvgEl("path", this.deps.containerEl.ownerDocument);
          p3.setAttribute("d", "m14.83 14.83 4.24 4.24");
          svg.appendChild(p3);

          const p4 = makeSvgEl("path", this.deps.containerEl.ownerDocument);
          p4.setAttribute("d", "m9.17 14.83-4.24 4.24");
          svg.appendChild(p4);

          const circleInner = makeSvgEl("circle", this.deps.containerEl.ownerDocument);
          circleInner.setAttribute("cx", "12");
          circleInner.setAttribute("cy", "12");
          circleInner.setAttribute("r", "4");
          svg.appendChild(circleInner);

          ic.appendChild(svg);
        } else {
          setIcon(ic, it.icon);
        }
        row.appendChild(ic);
      }

      const txt = makeEl("span", this.deps.containerEl.ownerDocument);
      txt.textContent = it.label;
      row.appendChild(txt);

      const activate = () => {
        this.closeMorePopover();
        it.onActivate?.();
      };

      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        activate();
      });

      row.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ev.stopPropagation();
          activate();
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          this.closeMorePopover();
          (trigger).focus();
        }
      });

      menu.appendChild(row);
    }

    activeDocument.body.appendChild(learnkitWrapper);
    this.morePopoverEl = root;
    this.moreWrapperEl = learnkitWrapper;
    root.classList.add("is-open");

    const place = () => {
      placePopover({
        trigger, panel, popoverEl: root,
        setWidth: false,
        align: "right",
      });
    };

    // Place after layout to ensure correct width measurement
    window.requestAnimationFrame(() => place());

    const onResizeOrScroll = () => place();
    const onVisualViewportResize = () => place();

    const onDocPointerDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (!t) return;
      if (root.contains(t) || trigger.contains(t)) return;
      this.closeMorePopover();
    };

    const onDocKeydown = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.closeMorePopover();
      (trigger).focus();
    };

    window.addEventListener("resize", onResizeOrScroll, true);
    window.addEventListener("scroll", onResizeOrScroll, true);
    window.visualViewport?.addEventListener("resize", onVisualViewportResize);

    const bodyObserver = new MutationObserver(() => place());
    bodyObserver.observe(activeDocument.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const tid = window.setTimeout(() => {
      activeDocument.addEventListener("pointerdown", onDocPointerDown, true);
      activeDocument.addEventListener("keydown", onDocKeydown, true);
    }, 0);

    this.moreCleanup = () => {
      window.clearTimeout(tid);
      window.removeEventListener("resize", onResizeOrScroll, true);
      window.removeEventListener("scroll", onResizeOrScroll, true);
      window.visualViewport?.removeEventListener("resize", onVisualViewportResize);
      bodyObserver.disconnect();
      activeDocument.removeEventListener("pointerdown", onDocPointerDown, true);
      activeDocument.removeEventListener("keydown", onDocKeydown, true);
    };
  }

  private installHeaderActionsButtonGroup(active: LearnKitHeaderPage) {
    const actionsHost =
      (this.deps.containerEl.querySelector<HTMLElement>(":scope > .view-header .view-actions")) ??
      (this.deps.containerEl.querySelector<HTMLElement>(".view-header .view-actions"));

    if (!actionsHost) return;

    try {
      this.widthResizeCleanup?.();
    } catch (e) { log.swallow("installHeaderActionsButtonGroup: widthResizeCleanup", e); }
    this.widthResizeCleanup = null;

    try {
      this.widthResizeObserver?.disconnect();
    } catch (e) { log.swallow("installHeaderActionsButtonGroup: widthResizeObserver disconnect", e); }
    this.widthResizeObserver = null;

    clearNode(actionsHost);

    actionsHost.classList.add("learnkit-view-actions", "learnkit-view-actions");
    actionsHost.classList.add("learnkit-actions-host", "learnkit-actions-host");

    // Collapse/Expand
    const widthBtn = makeEl("button", this.deps.containerEl.ownerDocument);
    widthBtn.type = "button";
    widthBtn.className = "learnkit-btn-toolbar inline-flex items-center gap-2";
    widthBtn.setAttribute("data-learnkit-expand-collapse", "true");
    widthBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.deps.toggleWide();
      this.updateWidthButtonLabel();
    });

    const widthIcon = makeEl("span", this.deps.containerEl.ownerDocument);
    widthIcon.className = "inline-flex items-center justify-center [&_svg]:size-4";
    widthIcon.setAttribute("aria-hidden", "true");
    widthBtn.appendChild(widthIcon);

    actionsHost.appendChild(widthBtn);

    this.widthBtnEl = widthBtn;
    this.widthBtnIconEl = widthIcon;

    const onResize = () => this.updateWidthButtonLabel();
    window.addEventListener("resize", onResize, true);
    this.widthResizeCleanup = () => window.removeEventListener("resize", onResize, true);
    // Observe header/container size changes (e.g., pane resize) to re-show button when width grows
    if (typeof ResizeObserver !== "undefined") {
      try {
        const header =
          (this.deps.containerEl ? queryFirst(this.deps.containerEl, ":scope > .view-header") : null) ??
          (this.deps.containerEl ? queryFirst(this.deps.containerEl, ".view-header") : null);
        const ro = new ResizeObserver(() => this.updateWidthButtonLabel());
        if (header) ro.observe(header);
        if (this.deps.containerEl) ro.observe(this.deps.containerEl);
        this.widthResizeObserver = ro;
      } catch (e) { log.swallow("install: ResizeObserver setup", e); }
    }

    // Sync
    const syncBtn = makeEl("button", this.deps.containerEl.ownerDocument);
    syncBtn.type = "button";
    syncBtn.className = "learnkit-btn-toolbar inline-flex items-center gap-2";
    syncBtn.setAttribute("aria-label", this.tx("ui.header.syncFlashcards", "Sync flashcards"));
    syncBtn.setAttribute("data-tooltip-position", "bottom");
    syncBtn.setAttribute("data-learnkit-sync", "true");
    syncBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.deps.runSync();
    });

    const syncIcon = makeEl("span", this.deps.containerEl.ownerDocument);
    syncIcon.className = "inline-flex items-center justify-center [&_svg]:size-4";
    syncIcon.setAttribute("aria-hidden", "true");
    syncBtn.appendChild(syncIcon);

    actionsHost.appendChild(syncBtn);
    this.syncBtnIconEl = syncIcon;

    // Theme toggle removed; now handled by Obsidian

    // More
    const moreWrap = makeEl("div", this.deps.containerEl.ownerDocument);
    moreWrap.id = this.moreId;
    moreWrap.className = "lk-more-wrap";
    actionsHost.appendChild(moreWrap);

    const moreBtn = makeEl("button", this.deps.containerEl.ownerDocument);
    moreBtn.type = "button";
    moreBtn.id = `${this.moreId}-trigger`;
    moreBtn.className = "btn-icon-outline learnkit-btn-toolbar";
    moreBtn.setAttribute("aria-haspopup", "menu");
    moreBtn.setAttribute("aria-expanded", "false");
    moreBtn.setAttribute("aria-label", this.tx("ui.header.section.tools", "Tools"));
    moreBtn.setAttribute("data-tooltip-position", "bottom");
    moreWrap.appendChild(moreBtn);

    const moreIcon = makeEl("span", this.deps.containerEl.ownerDocument);
    moreIcon.className = "inline-flex items-center justify-center [&_svg]:size-4";
    moreIcon.setAttribute("aria-hidden", "true");
    setIcon(moreIcon, "more-vertical");
    moreBtn.appendChild(moreIcon);

    this.moreTriggerEl = moreBtn;

    const closeTab = () => {
      try {
        this.deps.leaf.detach();
      } catch (e) { log.swallow("closeTab: leaf detach", e); }
    };

    const runCommand = (commandId: string, label: string) => {
      const ok = this.deps.app.commands?.executeCommandById?.(commandId);
      if (!ok) {
        new Notice(this.tx("ui.notice.commandUnavailable", "{label} command is not available.", { label }));
      }
    };

    const ankiNoun = this.tx("ui.common.anki", "Anki");
    const importFromAnkiLabel = this.tx("ui.header.menu.importFrom", "Import from {name}", { name: ankiNoun });
    const exportToAnkiLabel = this.tx("ui.header.menu.exportTo", "Export to {name}", { name: ankiNoun });

    const openAnkiImport = () => runCommand("learnkit:import-anki", importFromAnkiLabel);
    const openAnkiExport = () => runCommand("learnkit:export-anki", exportToAnkiLabel);
    const openSupport = () => {
      window.open("https://github.com/ctrlaltwill/learnkit/issues", "_blank", "noopener,noreferrer");
    };
    const openGithubRepository = () => {
      window.open("https://github.com/ctrlaltwill/learnkit", "_blank", "noopener,noreferrer");
    };

    const menuItems: LearnKitHeaderMenuItem[] = [
      { type: "section", label: ankiNoun },
      { label: exportToAnkiLabel, icon: "folder-up", onActivate: openAnkiExport },
      { label: importFromAnkiLabel, icon: "folder-down", onActivate: openAnkiImport },
      { type: "separator", label: "" },
      { type: "section", label: this.tx("ui.header.section.support", "Support") },
      { label: this.tx("ui.header.menu.getSupport", "Get support"), icon: "life-buoy", onActivate: openSupport },
      { label: this.tx("ui.header.menu.githubRepository", "GitHub repository"), icon: "github", onActivate: openGithubRepository },
      { label: this.tx("ui.header.menu.keyboardShortcuts", "Keyboard shortcuts"), icon: "keyboard", onActivate: () => {
        if (this.deps.plugin) new KeyboardShortcutsModal(this.deps.app, this.deps.plugin).open();
      } },
      { type: "separator", label: "" },
      { label: this.tx("ui.header.menu.closeTab", "Close tab"), icon: "x", onActivate: closeTab },
    ];

    moreBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.morePopoverEl) this.closeMorePopover();
      else this.openMorePopover(moreBtn, menuItems);
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────
/**
 * Creates a {@link LearnKitHeader} with the common wiring shared by all
 * four top-level views (Home, Study, Flashcards, Analytics).
 *
 * Each view only needs to supply:
 *  - `view`          – the ItemView instance (`this`)
 *  - `plugin`        – the LearnKitPlugin (needs `.isWideMode`)
 *  - `onToggleWide`  – callback to run *after* isWideMode is flipped
 *  - `beforeSync?`   – optional hook that runs before sync (e.g. save scroll position)
 */
export function createViewHeader(opts: {
  view: ItemView;
  plugin: { isWideMode: boolean };
  onToggleWide: () => void;
  beforeSync?: () => void;
}): LearnKitHeader {
  const leaf = opts.view.leaf ?? opts.view.app.workspace.getLeaf(false);
  return new LearnKitHeader({
    app: opts.view.app,
    leaf,
    plugin: opts.plugin as LearnKitPlugin,
    containerEl: opts.view.containerEl,
    getIsWide: () => opts.plugin.isWideMode,
    toggleWide: () => {
      opts.plugin.isWideMode = !opts.plugin.isWideMode;
      opts.onToggleWide();
    },
    runSync: () => {
      opts.beforeSync?.();
      const p = opts.plugin as { _runSync?(): void; syncBank?(): void };
      if (typeof p._runSync === "function") void p._runSync();
      else if (typeof p.syncBank === "function") void p.syncBank();
      else {
        const lang = (opts.plugin as LearnKitPlugin | undefined)?.settings?.general?.interfaceLanguage;
        new Notice(t(lang, "ui.notice.syncNotAvailable", "Sync not available (no sync method found)."));
      }
    },
  });
}

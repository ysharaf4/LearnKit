/**
 * UI Theme & Viewport Controller
 *
 * Deep domain module responsible for managing Basecoat runtime initialization,
 * CSS theme preset/accent overrides, canvas zoom & pinch scaling, status bar visibility,
 * and reading-view refresh debouncing.
 */

import { Platform, type App, type EventRef, type ItemView, type WorkspaceLeaf } from "obsidian";
import { clamp } from "../core/utils";
import { getBasecoatApi, patchBasecoatNullGuards, type BasecoatApi } from "../core/basecoat";
import type { LearnKitSettings } from "../core/constants";
import { log } from "../core/logger";
import { initButtonTooltipDefaults } from "../core/tooltip-defaults";
import {
  refreshReadingViewMarkdownLeaves,
  scheduleReadingViewRefresh,
  startMarkdownModeWatcher,
  type ReadingRefreshState,
} from "../../views/reading/reading-refresh-runtime";
import {
  VIEW_TYPE_REVIEWER,
  VIEW_TYPE_NOTE_REVIEW,
  VIEW_TYPE_HOME,
  VIEW_TYPE_BROWSER,
  VIEW_TYPE_ANALYTICS,
  VIEW_TYPE_SETTINGS,
  VIEW_TYPE_EXAM_GENERATOR,
  VIEW_TYPE_COACH,
} from "../core/constants";

export interface UiThemePluginContext {
  app: App;
  getSettings: () => LearnKitSettings;
  saveSettings: () => Promise<void>;
  registerDomEvent: (
    el: Window | Document | HTMLElement,
    type: string,
    callback: (ev: any) => any,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  registerEvent: (eventRef: EventRef) => void;
  register: (cleanup: () => any) => void;
}

export class UiThemeController {
  private _basecoatApi: BasecoatApi | null = null;
  private _basecoatStarted = false;
  private _learnkitZoomValue = 1;
  private _learnkitZoomSaveTimer: number | null = null;

  private _readingViewRefreshTimer: number | null = null;
  private _readingModeWatcherInterval: number | null = null;
  private _markdownLeafModeSnapshot = new WeakMap<WorkspaceLeaf, "source" | "preview">();
  private _markdownLeafContentSnapshot = new WeakMap<WorkspaceLeaf, string>();

  private readonly _hideStatusBarViewTypes = new Set<string>([
    VIEW_TYPE_REVIEWER,
    VIEW_TYPE_NOTE_REVIEW,
  ]);

  private readonly _refreshableViewTypes: string[] = [
    VIEW_TYPE_HOME,
    VIEW_TYPE_BROWSER,
    VIEW_TYPE_ANALYTICS,
    VIEW_TYPE_SETTINGS,
    VIEW_TYPE_EXAM_GENERATOR,
    VIEW_TYPE_COACH,
  ];

  constructor(private readonly ctx: UiThemePluginContext) {}

  get zoomValue(): number {
    return this._learnkitZoomValue;
  }

  get basecoatApi(): BasecoatApi | null {
    return this._basecoatApi;
  }

  initBasecoatRuntime(): void {
    const bc = getBasecoatApi();
    if (!bc) {
      log.warn("Basecoat API not found on window.basecoat (dropdowns may not work).");
      return;
    }

    try {
      patchBasecoatNullGuards(bc);
      bc.stop?.();
      bc.initAll?.();

      if (!Platform.isMobileApp) {
        bc.start?.();
        this._basecoatStarted = true;
      } else {
        this._basecoatStarted = false;
      }

      this._basecoatApi = bc;
      log.info(`Basecoat initAll OK${Platform.isMobileApp ? " (observer disabled on mobile)" : " + start OK"}`);
    } catch (e) {
      log.warn("Basecoat init failed", e);
    }
  }

  stopBasecoatRuntime(): void {
    if (!this._basecoatStarted) return;
    try {
      const bc = getBasecoatApi();
      bc?.stop?.();
    } catch (e) {
      log.swallow("stop basecoat runtime", e);
    }
    this._basecoatStarted = false;
  }

  isActiveHiddenViewType(): boolean {
    const ws = this.ctx.app.workspace;
    const activeLeaf = ws?.getMostRecentLeaf?.() ?? null;
    const viewType = activeLeaf?.view?.getViewType?.();
    return viewType ? this._hideStatusBarViewTypes.has(viewType) : false;
  }

  updateStatusBarVisibility(leaf: WorkspaceLeaf | null): void {
    const viewType = leaf?.view?.getViewType?.();
    const hide = viewType
      ? this._hideStatusBarViewTypes.has(viewType)
      : this.isActiveHiddenViewType();
    activeDocument.body.classList.toggle("learnkit-hide-status-bar", hide);
  }

  applyLearnKitThemeAccentOverride(): void {
    const settings = this.ctx.getSettings();
    const raw = String(settings?.general?.themeAccentOverride ?? "").trim();
    const isHex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw);
    if (isHex) {
      activeDocument.body.style.setProperty("--learnkit-theme-accent-override", raw);
      return;
    }
    activeDocument.body.style.removeProperty("--learnkit-theme-accent-override");
  }

  applyLearnKitThemePreset(): void {
    const settings = this.ctx.getSettings();
    const preset = String(settings?.general?.themePreset ?? "glass").trim() || "glass";
    activeDocument.body.setAttribute("data-learnkit-theme-preset", preset);
  }

  applyLearnKitZoom(value: number): void {
    const next = clamp(Number(value || 1), 0.8, 1.8);
    this._learnkitZoomValue = next;
    if (Math.abs(next - 1) < 0.001) {
      activeDocument.body.style.removeProperty("--learnkit-leaf-zoom");
    } else {
      activeDocument.body.style.setProperty("--learnkit-leaf-zoom", next.toFixed(3));
    }
  }

  queueLearnKitZoomSave(): void {
    if (this._learnkitZoomSaveTimer != null) window.clearTimeout(this._learnkitZoomSaveTimer);
    this._learnkitZoomSaveTimer = window.setTimeout(() => {
      this._learnkitZoomSaveTimer = null;
      void this.ctx.saveSettings();
    }, 250);
  }

  registerLearnKitPinchZoom(): void {
    const settings = this.ctx.getSettings();
    this.applyLearnKitZoom(settings.general.workspaceContentZoom ?? 1);

    this.ctx.registerDomEvent(
      activeDocument,
      "wheel",
      (ev: WheelEvent) => {
        if (!ev.ctrlKey) return;

        const target = ev.target as HTMLElement | null;
        if (!target) return;

        if (target.closest(".modal-container, .menu, .popover, .suggestion-container")) return;

        const learnkitEl = target.closest<HTMLElement>(
          ".workspace-leaf-content.learnkit, .learnkit-widget.learnkit",
        );
        if (!learnkitEl) return;

        ev.preventDefault();
        ev.stopPropagation();

        const factor = Math.exp(-ev.deltaY * 0.006);
        const next = clamp(this._learnkitZoomValue * factor, 0.8, 1.8);
        if (Math.abs(next - this._learnkitZoomValue) < 0.001) return;

        this.applyLearnKitZoom(next);
        this.ctx.getSettings().general.workspaceContentZoom = Number(next.toFixed(3));
        this.queueLearnKitZoomSave();
      },
      { capture: true, passive: false },
    );
  }

  async refreshReadingViewMarkdownLeaves(activeOnly = false): Promise<void> {
    await refreshReadingViewMarkdownLeaves(this.ctx.app, { activeOnly });
  }

  scheduleReadingViewRefresh(delayMs = 90, options?: { activeOnly?: boolean }): void {
    const state: ReadingRefreshState = {
      readingViewRefreshTimer: this._readingViewRefreshTimer,
      readingModeWatcherInterval: this._readingModeWatcherInterval,
      markdownLeafModeSnapshot: this._markdownLeafModeSnapshot,
      markdownLeafContentSnapshot: this._markdownLeafContentSnapshot,
    };
    scheduleReadingViewRefresh({
      state,
      delayMs,
      refresh: () => {
        void this.refreshReadingViewMarkdownLeaves(!!options?.activeOnly);
      },
    });
    this._readingViewRefreshTimer = state.readingViewRefreshTimer;
  }

  startMarkdownModeWatcher(): void {
    const state: ReadingRefreshState = {
      readingViewRefreshTimer: this._readingViewRefreshTimer,
      readingModeWatcherInterval: this._readingModeWatcherInterval,
      markdownLeafModeSnapshot: this._markdownLeafModeSnapshot,
      markdownLeafContentSnapshot: this._markdownLeafContentSnapshot,
    };
    startMarkdownModeWatcher({
      app: this.ctx.app,
      state,
      registerWorkspaceEvent: this.ctx.registerEvent.bind(this.ctx),
      setWatcherInterval: (id: number | null) => {
        this._readingModeWatcherInterval = id;
      },
      scheduleRefresh: ({ delayMs, activeOnly }: { delayMs?: number; activeOnly?: boolean } = {}) => {
        this.scheduleReadingViewRefresh(delayMs, { activeOnly });
      },
    });
  }

  refreshOpenViews(): void {
    for (const type of this._refreshableViewTypes) {
      this.ctx.app.workspace.getLeavesOfType(type).forEach((leaf: WorkspaceLeaf) => {
        const view = leaf.view as ItemView & { onRefresh?(): void };
        view.onRefresh?.();
      });
    }
  }

  initButtonTooltipDefaults(): void {
    this.ctx.register(initButtonTooltipDefaults());
  }
}

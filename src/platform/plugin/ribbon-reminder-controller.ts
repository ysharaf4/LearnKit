/**
 * Ribbon & Reminder Controller
 *
 * Deep domain module responsible for managing Obsidian ribbon icons,
 * reminder engine triggers, and developer console test commands.
 */

import { addIcon } from "obsidian";
import { BRAND } from "../core/constants";
import { createStudyAssistantMatrixConsoleApi } from "../integrations/ai/study-assistant-matrix-runner";
import {
  LEARNKIT_BRAND_ICON_KEY,
  LEARNKIT_BRAND_HORIZONTAL_ICON_KEY,
  LEARNKIT_WIDGET_STUDY_ICON_KEY,
  LEARNKIT_WIDGET_ASSISTANT_ICON_KEY,
  LEARNKIT_RIBBON_BRAND_ICON,
  LEARNKIT_HORIZONTAL_BRAND_ICON,
  LEARNKIT_STUDY_WIDGET_ICON,
  LEARNKIT_ASSISTANT_WIDGET_ICON,
} from "../core/brand-icons";
import type { ReminderEngine } from "../../views/reminders/reminder-engine";
import { log } from "../core/logger";

export interface RibbonReminderPluginContext {
  addRibbonIcon: (icon: string, title: string, callback: (evt: MouseEvent) => void) => HTMLElement;
  openHomeTab: (forceNew: boolean) => Promise<void>;
  getPlugin: () => any;
}

export class RibbonReminderController {
  private _ribbonEls: HTMLElement[] = [];
  private _reminderEngine: ReminderEngine | null = null;
  private readonly _reminderDevConsoleCommandNames: readonly string[] = [
    "learnKitReminderLaunch",
    "learnkitReminderLaunch",
    "learnKitReminderRoutine",
    "learnkitReminderRoutine",
    "learnKitReminderGatekeeper",
    "learnkitReminderGatekeeper",
  ];

  constructor(private readonly ctx: RibbonReminderPluginContext) {}

  get reminderEngine(): ReminderEngine | null {
    return this._reminderEngine;
  }

  setReminderEngine(engine: ReminderEngine | null): void {
    this._reminderEngine = engine;
  }

  refreshReminderEngine(): void {
    this._reminderEngine?.refresh();
  }

  registerReminderDevConsoleCommands(): void {
    if (typeof window === "undefined") return;

    const target = window as unknown as Record<string, unknown>;

    target.learnKitReminderLaunch = (force = false) => {
      const ok = this._reminderEngine?.triggerStartupReminder(!!force) ?? false;
      return ok ? "startup reminder triggered" : "startup reminder not shown";
    };
    target.learnkitReminderLaunch = target.learnKitReminderLaunch;

    target.learnKitReminderRoutine = (force = false) => {
      const ok = this._reminderEngine?.triggerRoutineReminder(!!force) ?? false;
      return ok ? "routine reminder triggered" : "routine reminder not shown";
    };
    target.learnkitReminderRoutine = target.learnKitReminderRoutine;

    target.learnKitReminderGatekeeper = (force = false) => {
      const ok = this._reminderEngine?.triggerGatekeeper(!!force) ?? false;
      return ok ? "gatekeeper popup opened" : "gatekeeper popup not opened";
    };
    target.learnkitReminderGatekeeper = target.learnKitReminderGatekeeper;
  }

  unregisterReminderDevConsoleCommands(): void {
    if (typeof window === "undefined") return;
    const target = window as unknown as Record<string, unknown>;
    for (const name of this._reminderDevConsoleCommandNames) {
      delete target[name];
    }
    delete target.learnKitReminderLaunch;
    delete target.learnKitReminderRoutine;
    delete target.learnKitReminderGatekeeper;
  }

  registerStudyAssistantDevConsoleCommands(): void {
    if (typeof window === "undefined") return;

    const target = window as unknown as Record<string, unknown>;
    const api = createStudyAssistantMatrixConsoleApi(this.ctx.getPlugin());

    target.learnKitAi = api;
    target.learnkitAi = api;
    target.learnKitAiMatrixRun = api.runMatrix;
    target.learnkitAiMatrixRun = api.runMatrix;
  }

  unregisterStudyAssistantDevConsoleCommands(): void {
    if (typeof window === "undefined") return;
    const target = window as unknown as Record<string, unknown>;
    delete target.learnKitAi;
    delete target.learnkitAi;
    delete target.learnKitAiMatrixRun;
    delete target.learnkitAiMatrixRun;
  }

  destroyRibbonIcons(): void {
    for (const el of this._ribbonEls) {
      try {
        el.remove();
      } catch (e) {
        log.swallow("remove ribbon icon", e);
      }
    }
    this._ribbonEls = [];
  }

  registerRibbonIcons(): void {
    this.destroyRibbonIcons();

    const add = (icon: string, title: string, onClick: (ev: MouseEvent) => void) => {
      const el = this.ctx.addRibbonIcon(icon, title, onClick);
      if (typeof (el as any).addClass === "function") {
        (el as any).addClass("learnkit-ribbon-action");
      } else {
        el.classList.add("learnkit-ribbon-action");
      }
      this._ribbonEls.push(el);
      return el;
    };

    add(LEARNKIT_BRAND_ICON_KEY, BRAND, (ev: MouseEvent) => {
      const forceNew = ev.metaKey || ev.ctrlKey;
      void this.ctx.openHomeTab(forceNew);
    });
  }

  registerBrandIcons(): void {
    addIcon(LEARNKIT_BRAND_ICON_KEY, LEARNKIT_RIBBON_BRAND_ICON);
    addIcon(LEARNKIT_BRAND_HORIZONTAL_ICON_KEY, LEARNKIT_HORIZONTAL_BRAND_ICON);
    addIcon(LEARNKIT_WIDGET_STUDY_ICON_KEY, LEARNKIT_STUDY_WIDGET_ICON);
    addIcon(LEARNKIT_WIDGET_ASSISTANT_ICON_KEY, LEARNKIT_ASSISTANT_WIDGET_ICON);
  }
}

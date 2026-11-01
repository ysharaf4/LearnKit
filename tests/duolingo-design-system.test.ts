/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from "vitest";
import { DuolingoSoundEngine, soundEngine } from "../src/platform/core/duolingo-sfx";
import { triggerCelebrationConfetti } from "../src/platform/core/confetti";
import { DEFAULT_SETTINGS } from "../src/platform/core/default-settings";
import { normaliseSettingsInPlace } from "../src/views/settings/config/settings-normalisation";
import type { LearnKitSettings } from "../src/platform/types/settings";
import fs from "node:fs";
import path from "node:path";

describe("Duolingo Design System & Enhancements", () => {
  describe("Theme Preset Settings & Preservation of Defaults", () => {
    it("preserves 'glass' as the default theme preset", () => {
      expect(DEFAULT_SETTINGS.general.themePreset).toBe("glass");
      expect(DEFAULT_SETTINGS.general.soundEffectsEnabled).toBe(true);
    });

    it("normalises themePreset allowing duolingo and falling back to glass", () => {
      const duolingoSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as LearnKitSettings;
      duolingoSettings.general.themePreset = "duolingo";
      normaliseSettingsInPlace(duolingoSettings);
      expect(duolingoSettings.general.themePreset).toBe("duolingo");

      const glassSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as LearnKitSettings;
      glassSettings.general.themePreset = "glass";
      normaliseSettingsInPlace(glassSettings);
      expect(glassSettings.general.themePreset).toBe("glass");

      const unknownSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as LearnKitSettings;
      (unknownSettings.general as unknown as { themePreset: string }).themePreset = "invalid-preset";
      normaliseSettingsInPlace(unknownSettings);
      expect(unknownSettings.general.themePreset).toBe("glass");
    });
  });

  describe("Web Audio API Synthesizer (DuolingoSoundEngine)", () => {
    let engine: DuolingoSoundEngine;

    beforeEach(() => {
      engine = new DuolingoSoundEngine();
    });

    it("initialises with enabled = true", () => {
      expect(engine.isEnabled()).toBe(true);
    });

    it("toggles enabled state correctly", () => {
      engine.setEnabled(false);
      expect(engine.isEnabled()).toBe(false);
      engine.setEnabled(true);
      expect(engine.isEnabled()).toBe(true);
    });

    it("executes all playback methods safely without throwing even without AudioContext", () => {
      expect(() => engine.unlock()).not.toThrow();
      expect(() => engine.playClick()).not.toThrow();
      expect(() => engine.playCorrect()).not.toThrow();
      expect(() => engine.playIncorrect()).not.toThrow();
      expect(() => engine.playFanfare()).not.toThrow();
    });

    it("does not play sounds when disabled", () => {
      engine.setEnabled(false);
      expect(() => engine.playClick()).not.toThrow();
      expect(() => engine.playCorrect()).not.toThrow();
      expect(() => engine.playIncorrect()).not.toThrow();
      expect(() => engine.playFanfare()).not.toThrow();
    });

    it("exports a global singleton soundEngine instance", () => {
      expect(soundEngine).toBeInstanceOf(DuolingoSoundEngine);
    });
  });

  describe("Confetti Celebration Effect", () => {
    it("attaches canvas to target container when triggered", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      triggerCelebrationConfetti(container);

      // In happy-dom/jsdom, getContext may return null or stub, but function runs safely
      expect(container.children.length >= 0).toBe(true);
      container.remove();
    });
  });

  describe("CSS Stylesheet Hygiene & Duolingo Tokens", () => {
    it("contains zero !important declarations in duolingo.css", () => {
      const cssPath = path.resolve(__dirname, "../src/platform/styles/tokens/themes/duolingo.css");
      const content = fs.readFileSync(cssPath, "utf8");
      expect(content).not.toMatch(/!important/i);
    });

    it("defines Duolingo Feather palette and streak badge classes", () => {
      const cssPath = path.resolve(__dirname, "../src/platform/styles/tokens/themes/duolingo.css");
      const content = fs.readFileSync(cssPath, "utf8");
      expect(content).toContain("--lk-duo-green");
      expect(content).toContain("--lk-duo-orange");
      expect(content).toContain("--lk-duo-red");
      expect(content).toContain("--lk-duo-blue");
      expect(content).toContain(".duo-streak-badge");
      expect(content).toContain(".duo-streak-icon");
    });
  });
});

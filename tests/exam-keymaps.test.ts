// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/platform/core/ui", () => ({
  renderMarkdownPreviewInElement: (el: HTMLElement, text: string) => { el.textContent = text; },
  setCssProps: vi.fn(),
}));
vi.mock("../src/platform/core/header", () => ({ createViewHeader: vi.fn() }));

import { LearnKitExamGeneratorView } from "../src/views/exam-generator/exam-generator-view";

Object.assign(HTMLElement.prototype, {
  createEl(this: HTMLElement, tag: string, opts: any = {}) {
    const el = document.createElement(tag);
    el.className = opts.cls ?? "";
    el.textContent = opts.text ?? "";
    if (opts.type) el.setAttribute("type", opts.type);
    for (const [key, value] of Object.entries(opts.attr ?? {})) el.setAttribute(key, String(value));
    this.appendChild(el);
    return el;
  },
  createDiv(this: HTMLElement, opts: any = {}) { return this.createEl("div", opts); },
  createSpan(this: HTMLElement, opts: any = {}) { return this.createEl("span", opts); },
  appendText(this: HTMLElement, text: string) { this.appendChild(document.createTextNode(text)); },
});

describe("exam test runner keymaps", () => {
  function createView(questions: any[]): any {
    const view = Object.create(LearnKitExamGeneratorView.prototype) as any;
    const rootEl = document.createElement("div");
    document.body.appendChild(rootEl);

    Object.assign(view, {
      _mode: "taking",
      _questions: questions,
      _currentIndex: 0,
      _answers: new Map<string, any>(),
      _rootEl: rootEl,
      _config: { timed: false, durationMinutes: 10 },
      app: {
        workspace: {
          getActiveViewOfType: () => view,
        },
      },
      _tx: (_k: string, fallback: string) => fallback,
      _createTakingLabelRow: (text: string) => {
        const d = document.createElement("div");
        d.textContent = text;
        return d;
      },
      _renderTakingMarkdownBlock: (_cls: string, text: string) => {
        const d = document.createElement("div");
        d.textContent = text;
        return d;
      },
      _appendTakingHotkeyKbd: vi.fn(),
      _submitExam: vi.fn(),
      _render: vi.fn(() => {
        rootEl.empty?.();
        view._renderExamRunner(rootEl);
      }),
    });

    view._renderExamRunner(rootEl);
    view._installTakingKeydownHandler();
    return view;
  }

  it("selects MCQ options with digit keys 1-9 in single-select questions", () => {
    const view = createView([
      { id: "q1", type: "mcq", prompt: "Pick one", options: ["Alpha", "Beta", "Gamma"] },
      { id: "q2", type: "mcq", prompt: "Pick two", options: ["One", "Two"] },
    ]);

    // Press '2' to select Beta
    const event = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(view._answers.get("q1")).toBe(1);

    const buttons = view._rootEl.querySelectorAll(".learnkit-exam-generator-option-button");
    expect(buttons[1].classList.contains("learnkit-mcq-selected")).toBe(true);
    expect(buttons[0].classList.contains("learnkit-mcq-selected")).toBe(false);

    // Press '1' to change selection to Alpha
    const event2 = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    document.dispatchEvent(event2);

    expect(view._answers.get("q1")).toBe(0);
    expect(buttons[0].classList.contains("learnkit-mcq-selected")).toBe(true);
    expect(buttons[1].classList.contains("learnkit-mcq-selected")).toBe(false);

    view._uninstallTakingKeydownHandler();
  });

  it("toggles MCQ options with digit keys in multi-select questions", () => {
    const view = createView([
      {
        id: "q-multi",
        type: "mcq",
        prompt: "Pick multiple",
        options: ["Option A", "Option B", "Option C"],
        correctIndices: [0, 2],
      },
    ]);

    // Press '1' then '3'
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true }));

    expect(view._answers.get("q-multi")).toEqual([0, 2]);

    // Press '1' again to toggle it off
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
    expect(view._answers.get("q-multi")).toEqual([2]);

    view._uninstallTakingKeydownHandler();
  });

  it("navigates forward on Enter and submits on last question Enter", () => {
    const view = createView([
      { id: "q1", type: "mcq", prompt: "Q1", options: ["A", "B"] },
      { id: "q2", type: "mcq", prompt: "Q2", options: ["C", "D"] },
    ]);

    expect(view._currentIndex).toBe(0);

    // Enter advances to Q2
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(view._currentIndex).toBe(1);

    // Enter on last question triggers submit
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(view._submitExam).toHaveBeenCalledWith(false);

    view._uninstallTakingKeydownHandler();
  });

  it("navigates with ArrowRight and ArrowLeft", () => {
    const view = createView([
      { id: "q1", type: "mcq", prompt: "Q1", options: ["A", "B"] },
      { id: "q2", type: "mcq", prompt: "Q2", options: ["C", "D"] },
    ]);

    expect(view._currentIndex).toBe(0);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(view._currentIndex).toBe(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(view._currentIndex).toBe(0);

    view._uninstallTakingKeydownHandler();
  });

  it("submits test with Mod+Enter even when focused in an SAQ textarea", () => {
    const view = createView([
      { id: "saq1", type: "saq", prompt: "Explain mitosis", markingGuide: ["Point 1"] },
    ]);

    const textarea = view._rootEl.querySelector("textarea")!;
    textarea.focus();

    // Mod+Enter (Cmd+Enter or Ctrl+Enter)
    const modEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(modEnter);

    expect(view._submitExam).toHaveBeenCalledWith(false);

    view._uninstallTakingKeydownHandler();
  });

  it("does not intercept digit keys when user is typing in a textarea", () => {
    const view = createView([
      { id: "saq1", type: "saq", prompt: "Enter numbers", markingGuide: ["Point 1"] },
    ]);

    const textarea = view._rootEl.querySelector("textarea")!;
    textarea.focus();

    const numEvent = new KeyboardEvent("keydown", {
      key: "1",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(numEvent);

    expect(numEvent.defaultPrevented).toBe(false);
    expect(view._answers.get("saq1")).toBeUndefined();

    view._uninstallTakingKeydownHandler();
  });
});


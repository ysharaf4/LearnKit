# Enhanced Reading View Flashcards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate Reading View flashcards into modern floating cards with ambient depth, hover lift, an integrated top header with face badges (`Question`/`Answer`), styled interactive content chips (MCQ options, Cloze capsules, Sequence rows), and a 3D depth flip animation—with full visual and functional parity between iPad and Desktop.

**Architecture:** 
1. Upgrade `buildFlashcardContentHTML` in `src/views/reading/reading-view.ts` to output an integrated header row containing face badge pills and action buttons, plus modern option chips for MCQs and sequences.
2. In `src/platform/styles/pretty-cards.css`, modernize the card container with subtle shadow elevation, rounded borders, touch/hover parity (`@media (hover: hover)` lift vs `@media (hover: none)` active press), and dynamic 3D flip animation with depth and scaling.
3. Validate DOM output, localized labels, and cross-platform CSS rules using targeted Vitest suites and the full verification pipeline.

**Tech Stack:** TypeScript, Obsidian DOM/Plugin API, CSS3 (3D transforms, CSS variables, CSS media queries for touch/hover parity), Vitest (jsdom).

**Spec:** Agreed design from `/grill-me` session with explicit iPad & Desktop parity requirement.

## Global Constraints
- **DOM Safety**: Never use `innerHTML`/`outerHTML` directly for unsanitized data; use `replaceChildrenWithHTML` or DOM primitives (`makeEl`, `createEl`).
- **Stylesheets**: Never write `!important` declarations in CSS (enforced by `tests/source-hygiene.test.ts`).
- **Backdrop Blur**: Route any backdrop blur through `var(--lk-backdrop-blur)`.
- **Localization**: Never hardcode user-facing strings; use `t(undefined, "ui.common.question", "Question")` and `t(undefined, "ui.common.answer", "Answer")`.
- **Testing**: Test files interacting with DOM nodes must have `/** @vitest-environment jsdom */` as the very first line.
- **iPad & Desktop Parity**: 
  - Action buttons must be accessible on touch without requiring mouse hover (`@media (hover: none)` sets visible discrete opacity).
  - Tap target sizes must be comfortable (minimum 36px touch bounds).
  - Hover lift effects must be scoped to `@media (hover: hover)`, while touch devices get responsive `:active` feedback without sticky hover states.

## Review Focus
1. **iPad / Touch Action Button Accessibility**: Ensure the Edit and Audio buttons can be tapped on iPad without sticky hover bugs or missing hover events.
2. **Click Propagation on Flip**: Verify clicking the Edit button or Speaker button does not trigger the card flip on both touch and mouse.
3. **Card Face Transitions**: Ensure both Front (Question) and Back (Answer) display their respective badge pill cleanly through repeated flips.
4. **Responsive Layout on Narrow Viewports (iPad Split-View)**: Confirm options, badges, and text never overflow or get clipped in compact widths.
5. **Dark & Light Mode Contrast**: Verify borders, shadows, chips, and badges use Obsidian theme variables (`--background-modifier-box-shadow`, `--color-base-20`, `--color-base-30`, `--interactive-accent`) and look crisp in both modes.

---

### Task 1: Update Flashcard HTML Structure with Integrated Header & Styled Content

**Files:**
- Modify: `src/views/reading/reading-view.ts:3050-3160`
- Test: `tests/reading-flashcard-rendering.test.ts`

**Interfaces:**
- Consumes: `card: LearnKitCard`, `options: { includeSpeakerButton?: boolean; includeEditButton?: boolean }`
- Produces: Enhanced HTML string from `buildFlashcardContentHTML` with:
  - `.learnkit-flashcard-header` (Top bar)
  - `.learnkit-flashcard-badge` (Pill with icon and localized "Question" / "Answer" text)
  - `.learnkit-flashcard-actions` (Right-aligned container with edit/speaker buttons)
  - `.learnkit-flashcard-option-chip` (MCQ options with `.learnkit-option-badge` for letter)

- [ ] **Step 1: Write the failing test for the new header structure and option chips**

Create `tests/reading-flashcard-rendering.test.ts`:
```ts
/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { buildFlashcardContentHTML } from "../src/views/reading/reading-view";
import type { LearnKitCard } from "../src/views/reading/reading-helpers";

describe("Reading View Flashcard Rendering & Structure", () => {
  it("renders integrated header with Question/Answer badge on front and back", () => {
    const card: LearnKitCard = {
      anchorId: "test-card-1",
      type: "basic",
      fields: { Q: "Capital of France?", A: "Paris" },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: false,
      includeEditButton: true,
    });

    expect(html).toContain("learnkit-flashcard-header");
    expect(html).toContain("learnkit-flashcard-badge");
    expect(html).toContain("Question");
    expect(html).toContain("Answer");
    expect(html).toContain("learnkit-flashcard-badge-icon");
  });

  it("renders MCQ options as styled option chips with letter badges", () => {
    const card: LearnKitCard = {
      anchorId: "test-mcq-1",
      type: "mcq",
      fields: {
        MCQ: "Select the prime number:",
        O: ["4", "6", "8"],
        A: "7",
      },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: false,
      includeEditButton: false,
    });

    expect(html).toContain("learnkit-flashcard-option-chip");
    expect(html).toContain("learnkit-option-badge");
    expect(html).toContain("learnkit-option-correct");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reading-flashcard-rendering.test.ts`
Expected: FAIL (missing `.learnkit-flashcard-header`, `.learnkit-flashcard-badge`, etc.)

- [ ] **Step 3: Update `buildFlashcardContentHTML` in `src/views/reading/reading-view.ts`**

Update `buildFlashcardContentHTML` to:
1. Define a helper `buildFaceHeader(side: 'front' | 'back')` that renders:
   ```html
   <div class="learnkit-flashcard-header">
     <div class="learnkit-flashcard-badge">
       <svg class="learnkit-flashcard-badge-icon" ... viewBox="0 0 24 24" ...>
         <!-- rotate/flip icon -->
       </svg>
       <span>${side === 'front' ? t(undefined, "ui.common.question", "Question") : t(undefined, "ui.common.answer", "Answer")}</span>
     </div>
     ${actionsFor(side)}
   </div>
   ```
2. Update MCQ option generation to wrap options in `.learnkit-flashcard-option-chip` with circular `.learnkit-option-badge` (A, B, C, D) and `.learnkit-option-correct` on the back side.
3. Integrate the header at the top of `.learnkit-flashcard-question` and `.learnkit-flashcard-answer`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reading-flashcard-rendering.test.ts tests/reading-flashcard-audio-button.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/views/reading/reading-view.ts tests/reading-flashcard-rendering.test.ts
git commit -m "feat: add integrated header and styled option chips to reading view flashcards"
```

---

### Task 2: Implement Modern Floating Card Styling & iPad/Desktop Parity in CSS

**Files:**
- Modify: `src/platform/styles/pretty-cards.css`
- Test: `tests/source-hygiene.test.ts`

**Interfaces:**
- Consumes: `.learnkit-pretty-card.learnkit-macro-flashcards` DOM classes
- Produces: Comprehensive styling for:
  - Modern floating container (`box-shadow`, `border-radius: var(--radius-l)`, softer background)
  - Header row & badge pill (`.learnkit-flashcard-header`, `.learnkit-flashcard-badge`)
  - Styled option chips and cloze capsules
  - Dynamic 3D depth flip keyframe animation (`learnkit-parent-flip`)
  - Touch vs Mouse parity (`@media (hover: hover)` vs `@media (hover: none)`, `body:is(.is-mobile, .is-tablet)`)

- [ ] **Step 1: Write CSS rules in `src/platform/styles/pretty-cards.css`**

1. **Card Container**:
   - Update `.learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-question` and `.learnkit-flashcard-answer`:
     - `border-radius: var(--radius-l);`
     - `border: 1px solid var(--color-base-30);`
     - `background: var(--color-base-20);`
     - `box-shadow: 0 2px 8px var(--background-modifier-box-shadow);`
     - `transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;`
     - `touch-action: manipulation;`
     - `-webkit-tap-highlight-color: transparent;`
2. **Desktop Hover Lift**:
   ```css
   @media (hover: hover) {
     .learnkit-pretty-card.learnkit-macro-flashcards:hover :is(.learnkit-flashcard-question, .learnkit-flashcard-answer) {
       transform: translateY(-2px);
       box-shadow: 0 6px 18px var(--background-modifier-box-shadow);
       border-color: var(--color-base-40);
     }
   }
   ```
3. **iPad / Touch Active Feedback & Action Visibility**:
   ```css
   @media (hover: none) {
     .learnkit-pretty-card.learnkit-macro-flashcards:active :is(.learnkit-flashcard-question, .learnkit-flashcard-answer) {
       transform: scale(0.985);
     }
     .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-actions {
       opacity: 0.85;
       pointer-events: auto;
     }
   }
   body:is(.is-mobile, .is-tablet) .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-actions {
     opacity: 0.85;
     pointer-events: auto;
   }
   ```
4. **Header & Badge Styling**:
   ```css
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-header {
     display: flex;
     align-items: center;
     justify-content: space-between;
     width: 100%;
     padding-bottom: 8px;
     margin-bottom: 8px;
     border-bottom: 1px solid var(--color-base-30);
   }
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-badge {
     display: inline-flex;
     align-items: center;
     gap: 5px;
     padding: 2px 8px;
     font-size: 11px;
     font-weight: 600;
     text-transform: uppercase;
     letter-spacing: 0.05em;
     border-radius: var(--radius-full, 9999px);
     background: var(--color-base-30);
     color: var(--text-muted);
   }
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-badge-icon {
     width: 12px;
     height: 12px;
     stroke-width: 2.2;
   }
   ```
5. **MCQ Option Chips & Cloze Capsules**:
   ```css
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-option-chip {
     display: flex;
     align-items: center;
     gap: 10px;
     width: 100%;
     padding: 6px 10px;
     margin: 4px 0;
     border-radius: var(--radius-m);
     background: var(--color-base-25, var(--color-base-20));
     border: 1px solid var(--color-base-30);
     text-align: left;
   }
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-option-chip.learnkit-option-correct {
     border-color: var(--interactive-accent);
     background: rgba(var(--interactive-accent-rgb, 100, 150, 255), 0.12);
   }
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-option-badge {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     width: 20px;
     height: 20px;
     border-radius: 50%;
     font-size: 11px;
     font-weight: 700;
     background: var(--color-base-30);
     color: var(--text-normal);
     flex-shrink: 0;
   }
   .learnkit-pretty-card.learnkit-macro-flashcards .learnkit-flashcard-cloze-blank {
     display: inline-block;
     padding: 1px 10px;
     border-radius: var(--radius-s);
     background: var(--color-base-30);
     border: 1px dashed var(--color-base-40);
     color: var(--text-muted);
     font-weight: 600;
   }
   ```
6. **3D Depth Flip Keyframe**:
   ```css
   @keyframes learnkit-parent-flip {
     0% {
       transform: perspective(1000px) rotateY(0deg) scale(1);
       box-shadow: 0 2px 8px var(--background-modifier-box-shadow);
     }
     50% {
       transform: perspective(1000px) rotateY(90deg) scale(0.97);
       box-shadow: 0 12px 28px var(--background-modifier-box-shadow);
     }
     100% {
       transform: perspective(1000px) rotateY(0deg) scale(1);
       box-shadow: 0 2px 8px var(--background-modifier-box-shadow);
     }
   }
   ```

- [ ] **Step 2: Run source-hygiene test to verify no `!important` or forbidden tokens**

Run: `npx vitest run tests/source-hygiene.test.ts`
Expected: PASS (4/4 tests)

- [ ] **Step 3: Run full build to ensure CSS bundling & PostCSS succeed**

Run: `npm run build`
Expected: exit code 0 (`dist/styles.css` compiled cleanly)

- [ ] **Step 4: Commit changes**

```bash
git add src/platform/styles/pretty-cards.css dist/styles.css
git commit -m "style: modernize reading view flashcards with 3D depth flip and iPad parity"
```

---

### Task 3: Regression Testing & Full Verification Loop

**Files:**
- Test: `tests/reading-flashcard-rendering.test.ts`
- Test: `tests/reading-flashcard-audio-button.test.ts`
- Test: `tests/source-hygiene.test.ts`

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`
Expected: exit code 0 (no TypeScript errors)

- [ ] **Step 2: Check translation parity**

Run: `npm run translations:check`
Expected: exit code 0 (`[translations] OK`)

- [ ] **Step 3: Run full Vitest test suite**

Run: `npm test`
Expected: all test files passing (128 test files)

- [ ] **Step 4: Run production build**

Run: `npm run build`
Expected: exit code 0

- [ ] **Step 5: Commit & wrap up**

```bash
git add dist/
git commit -m "build: compile production bundle for enhanced reading view flashcards"
```

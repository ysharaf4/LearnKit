---
name: LearnKit
description: Markdown-native active recall and spaced repetition design system for Obsidian
colors:
  primary: "#5ea500"
  primary-foreground: "#f7fee7"
  ring: "#9ae600"
  rating-again: "#ef4444"
  rating-hard: "#eab308"
  rating-good: "#22c55e"
  rating-easy: "#000000"
  destructive: "#e7000b"
  surface: "#ffffff"
  surface-dark: "#1e1e1e"
  text-normal: "#111111"
  text-muted: "#666666"
typography:
  display:
    fontFamily: "var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
  headline:
    fontFamily: "var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)"
    fontSize: "1.3125rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)"
    fontSize: "1.125rem"
    fontWeight: 500
    lineHeight: 1.3
  body:
    fontFamily: "var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "30px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text-normal}"
    rounded: "{rounded.md}"
    padding: "0.375rem"
    height: "36px"
  card-session:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-normal}"
    rounded: "{rounded.lg}"
    padding: "16px"
  rating-button-good:
    backgroundColor: "{colors.rating-good}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
---

# Design System: LearnKit

## Overview

**Creative North Star: "The Vault Glasswork"**

LearnKit integrates active recall directly into the Obsidian knowledge base. Rather than feeling like an external application bolted into a side pane, LearnKit lives as a set of precision study instruments crafted from translucent glass surfaces, seamlessly floating over the user's personal vault notes. The aesthetic reflects academic rigor, calm focus, and mathematical pacing without the noise of gamified distractions or clashing visual metaphors.

The system is defined by crisp typographic rhythm, high-contrast readability, and respectful alignment with Obsidian's theme architecture. Surfaces use layered color-mix values and subtle backdrop blur (`var(--lk-backdrop-blur)`) that adopt the host's light or dark mode palette automatically. Primary energy concentrates in a distinct vibrant sprout-lime accent for focus states and system brand marks, while study session cards emphasize the flashcard content with zero visual friction.

**Key Characteristics:**
- **Host Theme Symbiosis**: Inherits Obsidian's active theme tokens (`--color-base-*`, `--background-primary`, `--text-normal`) rather than imposing rigid hardcoded backgrounds.
- **Glass Transparency & Restraint**: Uses translucent surfaces with calibrated fallback blur instead of opaque modal slabs.
- **Flat-at-Rest Controls**: Buttons and inputs eliminate resting drop-shadows to preserve a clean, calm reading canvas.
- **Semantic Spaced Repetition Palette**: FSRS review ratings (Again, Hard, Good, Easy) use instantly recognizable, accessible color coding balanced with surface tinting.

## Colors

LearnKit's color architecture combines Obsidian host token synchronization with a signature vibrant sprout brand accent and semantic spaced-repetition feedback tones.

### Primary
- **Electric Sprout** (#5ea500 / `rgb(94, 165, 0)`): Primary brand mark, primary actions, and key active toggles. Sits cleanly against both light vault paper and deep dark themes.
- **Spring Neon Ring** (#9ae600 / `rgb(154, 230, 0)`): High-visibility accessible focus ring for keyboard navigation.

### Secondary
- **Theme Accent Passthrough** (`var(--theme-accent)`): Dynamically maps to the user's active Obsidian accent color for unobtrusive secondary controls, chart highlights, and contextual anchors.

### Neutral
- **Base Canvas** (`var(--learnkit-base-background, #ffffff)` / dark `#1e1e1e`): Dynamic canvas surface mapped directly to Obsidian's primary workspace background.
- **Card Tint** (`var(--color-base-05)`): Subtle tinted background layer (5% foreground mix) creating card depth without stark borders.
- **Card Border** (`var(--color-base-30)` / `var(--color-base-35)`): Low-contrast hairline container boundaries (0.5px solid) that demarcate cards cleanly.
- **Primary Text** (`var(--learnkit-base-foreground, #111111)`): Mapped to Obsidian `--text-normal` for comfortable long-form reading.
- **Muted Text** (`var(--color-base-40)` / dark `--color-base-60`): Contextual cues, shortcuts, study counters, and secondary metadata.

### Rating Palette (FSRS Spaced Repetition)
- **Again (Crimson)** (#ef4444 / dark `rgb(185, 28, 28)`): Card lapse or failed recall. Blended into button backgrounds at 16% opacity with full-contrast keycap labels.
- **Hard (Amber)** (#eab308 / dark `rgb(161, 98, 7)`): Difficult recall requiring shorter interval.
- **Good (Clover)** (#22c55e / dark `rgb(21, 128, 61)`): Target recall success sustaining normal FSRS progression.
- **Easy (Slate / Obsidian)** (#000000 / dark `rgb(60, 60, 60)`): Immediate, effortless recall triggering interval leaps.

### Named Rules
**The Host Harmony Rule.** LearnKit surfaces must inherit from Obsidian's host theme tokens (`--color-base-00` to `--color-base-100`, `--background-primary`, `--text-normal`). Never force an opaque hardcoded background or override user accent settings.

**The Rating Tint Rule.** Review rating buttons mix semantic rating hues at 16% tint into the surface background at rest (24% on hover), reserving high-saturation solid fills for badge pills and hotkey keycaps.

## Typography

**Display Font:** System UI / Obsidian Text Font (`var(--font-text, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)`)
**Body Font:** Obsidian Text Font (`var(--font-text)`)
**Code/Mono Font:** Monospace Stack (`var(--font-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)`)

**Character:** Clean, distraction-free typographic hierarchy optimized for fast scanning during rapid-fire flashcard review sessions and long-form note study.

### Hierarchy
- **Display** (600, `1.5rem` [24px], line-height `1.2`): Modal and main view titles (Reviewer, Analytics, Exam Coach).
- **Headline** (600, `1.3125rem` [21px], line-height `1.25`): Study session deck headers and section dividing titles.
- **Title** (500, `1.125rem` [18px], line-height `1.3`): Sub-deck names, card question prompts, and popup headers.
- **Body** (400, `1rem` [16px], line-height `1.5`): Card body content, cloze sentences, and note review text. Max line length 65–75ch.
- **Label** (500, `0.75rem` [12px], line-height `1.4`): Keyboard shortcut keycaps, FSRS interval projections, and metadata badges.

### Named Rules
**The Monospace Code Isolation Rule.** Inline card code and cloze syntax must always render in monospace (`var(--font-monospace)`), with compact padding (`0.2rem 0.4rem`) and a subtle tinted background (`var(--color-base-20)`) to distinguish syntax anchors from surrounding markdown prose.

## Layout

LearnKit adapts between desktop Obsidian leaf workspaces and mobile phone touch screens:
- **Desktop Shell**: Center-aligned review canvas constrained to `max-width: 1280px` (`--lk-review-max-width`) with `80px` shell gutters (`--lk-shell-gutter-desktop`) and `16px` inner padding.
- **Mobile / Phone Shell**: Full-bleed responsive adaptation (`--lk-shell-gutter-desktop: 32px`, `--lk-shell-padding-mobile: 8px`) with stacked action rows and full-width rating button trays.
- **Spatial Rhythm**: Core spacing relies on a 4px/8px baseline grid: `--lk-space-1` (4px), `--lk-space-2` (8px), `--lk-space-4` (16px), `--lk-space-6` (24px), and `--lk-space-8` (32px).
- **Uniform Row Heights**: Data rows, deck items, and toolbar strips adhere to a standard 42px row height (`--lk-row-height-default`).

## Elevation & Depth

LearnKit employs a flat-by-default visual model paired with selective ambient elevation. Surfaces sit flush on the Obsidian canvas at rest, conveying structure through subtle 0.5px hairline borders (`var(--color-base-35)`) and tonal background shifts (`var(--color-base-05)`). Depth is strictly reserved for overlays that genuinely float above the study flow.

### Shadow Vocabulary
- **Modal Depth** (`0 16px 48px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.12)`): Card editor modals, assistant chat sheets, and exam generator dialogues (`--lk-shadow-modal`).
- **Popover Ambient** (`0 4px 16px rgba(0, 0, 0, 0.12)` / dark `0 4px 16px rgba(0, 0, 0, 0.35)`): Tooltips, deck selector dropdowns, and rating shortcut menus (`--lk-shadow-popover-md`).
- **Subtle Popover** (`0 4px 12px rgba(0, 0, 0, 0.08)` / dark `0 4px 12px rgba(0, 0, 0, 0.3)`): Compact preview popovers and inline card hover previews (`--lk-shadow-popover-subtle`).

### Named Rules
**The Zero-Shadow Button Rule.** Buttons, inputs, and form controls have `box-shadow: none` at rest. Shadows belong exclusively to floating overlays, modals, and dropdown popovers.

**The Backdrop Blur Fallback Rule.** Surface blur must always be routed through `var(--lk-backdrop-blur)` or Obsidian's `--blur-s/m/l` with a fallback, never hardcoding `backdrop-filter: blur(Npx)`. This ensures translucency is cleanly disabled on systems or themes where repainting causes visual artifacts.

## Shapes

- **Radius Strategy**:
  - **Cards & Surface Shells**: `16px` (`--lk-radius-lg` / `var(--radius-lg)`), creating comfortable, approachable card silhouettes.
  - **Buttons & Toolbar Controls**: `12px` (`--lk-radius-md`) or `8px` (`--lk-radius-sm`), maintaining tactile pill-shaped targets.
  - **Pills & Badges**: Fully rounded `9999px` (`--lk-radius-xl`) for tag pills, study status chips, and hotkey keycaps.
- **Borders**: 0.5px hairline strokes using `--color-base-30` or `--color-base-35`. At rest on header actions, borders remain transparent and reveal upon hover or focus.

## Components

### Buttons
- **Shape**: Rounded corners (12px radius, `--radius-md`).
- **Dimensions**: Uniform 36px minimum height (`min-height: 36px`), font-weight 400.
- **Icon Outline Button (`.btn-icon-outline`)**: Transparent or base canvas background at rest, 0.5px hairline border, hover transition to `var(--color-base-25)` background with `var(--color-base-35)` border. Focus ring uses 2px accent outline with 2px offset.
- **Ghost Icon Button (`.btn-icon-ghost`)**: Transparent background and border at rest; reveals subtle background wash on hover.
- **Primary Button (`.btn-primary`)**: Solid Electric Sprout (#5ea500) background with high-contrast light text (`#f7fee7`), transitioning to darker sprout on hover.

### FSRS Rating Buttons
- **Shape**: Compact rounded rectangle (8px radius, `--radius-sm`).
- **Dimensions**: 36px height, flexible inline-flex layout with label and keyboard keycap badge.
- **Style**: Semantic background tint (16% opacity) with matching border tone at rest.
- **Hover/Active**: Elevates tint to 24% background opacity and 60% border opacity with smooth 0.15s color transition.

### Cards / Review Surfaces
- **Corner Style**: Rounded-lg (16px radius, `--radius-lg`).
- **Background**: `var(--color-base-05)` translucent layer.
- **Border**: 0.5px hairline border (`var(--color-base-30)` or `var(--color-base-35)`).
- **Shadow Strategy**: Zero drop shadow (`box-shadow: none`).
- **Padding**: 16px (`1.2rem` on desktop, `0.8rem` on mobile).

### Tag Box & Pills
- **Tag Box**: Fixed 38px height container with horizontal flex wrapping, form-field background, and zero box-shadow.
- **Tag Pill**: Fully rounded pill (9999px radius), 22px height, 0 to 8px horizontal padding, with integrated inline remove icon button.

### Inputs & Form Fields
- **Style**: Hairline border (`var(--color-base-40)`), zero resting box-shadow, background matching `var(--background-modifier-form-field)`.
- **Focus**: High-visibility Spring Neon accent ring (`#9ae600`) with clean outline offset.

## Do's and Don'ts

### Do:
- **Do** inherit colors from Obsidian's host theme tokens (`--color-base-00` through `--color-base-100`, `--background-primary`, `--text-normal`).
- **Do** route all backdrop blur declarations through `var(--lk-backdrop-blur)` or Obsidian's `--blur-s/m/l` with a fallback.
- **Do** maintain a uniform 36px minimum height for all interactive buttons and toolbar controls.
- **Do** keep buttons and cards flat at rest with `box-shadow: none`.
- **Do** construct SVGs and elements using standard DOM methods (`document.createElementNS`, `createEl`) to comply with Obsidian security invariants.

### Don't:
- **Don't** use `innerHTML` or `outerHTML` under any circumstances (strictly prohibited by Obsidian review standards).
- **Don't** write `!important` declarations in stylesheets.
- **Don't** hardcode static background colors (like `#ffffff` or `#000000`) on cards or containers—always use dynamic theme tokens.
- **Don't** add drop-shadows to resting buttons or inputs.
- **Don't** use hardcoded `backdrop-filter: blur(10px)` directly without variable indirection.

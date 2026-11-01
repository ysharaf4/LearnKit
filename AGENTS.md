# LearnKit Agent Guide

Agent reference and navigation guide for the LearnKit codebase.

## Navigation Map

Front-loaded pointers to primary collaborators by subsystem:

- **Reviewer View & Card Sessions**: [`review-view.ts`](file:///Users/ysharaf/LearnKit/src/views/reviewer/review-view.ts) manages leaf lifecycle, queues, and keyboard shortcuts; [`render-session.ts`](file:///Users/ysharaf/LearnKit/src/views/reviewer/render-session.ts) handles card DOM rendering, button bars, audio buttons, and rating transitions.
- **Reading View & Hover Cards**: [`reading-view.ts`](file:///Users/ysharaf/LearnKit/src/views/reading/reading-view.ts) handles reading mode markdown decorations, embedded widgets, hover flashcards, and hotkeys.
- **Audio Playback**: [`audio-player.ts`](file:///Users/ysharaf/LearnKit/src/platform/integrations/audio/audio-player.ts) provides event-driven audio playback via `AudioPlaybackController`, sound wave animations, stop/reset lifecycle, and DOM-decoupled button subscriptions.
- **Card Parsing & Serialization**: [`card-text-parser.ts`](file:///Users/ysharaf/LearnKit/src/engine/parser/card-text-parser.ts) extracts cards from markdown delimiters; [`derived-card-generator.ts`](file:///Users/ysharaf/LearnKit/src/platform/integrations/sync/derived-card-generator.ts) expands cloze, reversed, and combo variants.
- **Study Sessions & Scheduling**: [`study-session.ts`](file:///Users/ysharaf/LearnKit/src/engine/study-session/study-session.ts) runs FSRS/SM-2 spaced repetition, queue ordering, bury, suspend, and undo frames.
- **Card Editor & Creation**: [`card-editor.ts`](file:///Users/ysharaf/LearnKit/src/platform/card-editor/card-editor.ts) modal editor for creating, editing, and validating flashcards.
- **AI Companion**: [`assistant-conversation.ts`](file:///Users/ysharaf/LearnKit/src/platform/integrations/ai/assistant-conversation.ts) and [`assistant-popup.ts`](file:///Users/ysharaf/LearnKit/src/views/study-assistant/popup/assistant-popup.ts) manage streaming chat, note editing proposals, and test generation.
- **Anki Integration**: [`anki-package.ts`](file:///Users/ysharaf/LearnKit/src/platform/integrations/anki/anki-package.ts) imports and exports `.apkg` packages and media files.
- **Translations & Locales**: [`locales/en-base.json`](file:///Users/ysharaf/LearnKit/src/platform/translations/locales/en-base.json) (canonical English keys), [`locales/zh-cn.json`](file:///Users/ysharaf/LearnKit/src/platform/translations/locales/zh-cn.json), and [`translator.ts`](file:///Users/ysharaf/LearnKit/src/platform/translations/translator.ts).

## Invariants & Code Standards

Enforce these mechanical standards across all edits:

1. **DOM Construction**: Never use `innerHTML` or `outerHTML` (forbidden by Obsidian security guidelines). Construct SVGs and elements using `document.createElementNS("http://www.w3.org/2000/svg", ...)` or standard DOM methods (`createEl`, `appendChild`).
2. **Type Narrowing**: Never cast vault files with `as TFile`. Check `if (file instanceof TFile)` before accessing file properties.
3. **Module State**: Never attach temporary flags or listeners to `(window as any)` or global window objects. Store session state in module-scoped typed variables or class instances.
4. **Localization**: Never hardcode user-facing strings. Use `t(locale, "token.key", "Fallback")` or `t("token.key", "Fallback")`. Every new token in `en-base.json` must be added to `zh-cn.json`. Verify with `npm run translations:check`.
5. **Stylesheets**: Never write `!important` declarations in CSS. Route backdrop blur values through the LearnKit design tokens (`var(--lk-backdrop-blur)`).
6. **Terminology**: Adhere to [`GLOSSARY.md`](file:///Users/ysharaf/LearnKit/GLOSSARY.md). Use domain terms (_Study Session_, _Card_, _Scope_, _Rating_, _Bury_, _Suspend_).

## Verification Loop

Run the tight verification loop before finishing:

```bash
npm run typecheck                    # TypeScript type checking (tsc --noEmit)
npm run translations:check          # Locale key completeness and parity
npx vitest run tests/source-hygiene.test.ts  # Source hygiene & security rules
npm test                             # Full test suite
npm run build                        # esbuild + CSS build
```

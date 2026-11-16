# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Obsidian users—specifically students, medical and exam candidates, academic researchers, and knowledge workers—who capture and organize information in Markdown notes and need to retain that knowledge long-term. They operate during demanding study sessions, exam preparation cycles, or daily professional learning routines where app-switching friction between note-taking and flashcard apps (such as Anki) disrupts focus and retention habits.

## Product Purpose

Transform Obsidian from a passive repository for storing notes into an active system for durable knowledge retention. LearnKit bridges note-taking, active recall, and spaced repetition directly inside the vault, enabling learners to remember what they write without fragmenting their workflow.

## Positioning

Markdown-native active recall. Unlike external flashcard applications or siloed database extensions, LearnKit cards and review schedules live directly in the vault's Markdown files through persistent anchors and natural shorthand syntax. Notes remain the durable source of truth, augmented by modern FSRS scheduling, note review workflows, audio/TTS support, and an opt-in, bring-your-own-key AI Companion.

## Operating Context

- Obsidian workspace across desktop and mobile devices (leaf lifecycle, reviewer view, reading mode markdown decorations, side-dock ribbon, and modal dialogs).
- Core study routines: daily review queues, active recall study sessions, free practice sessions, exam sprint coaching, note reviewing, and on-the-fly card creation while reading or drafting.
- Local Markdown files (`.md`), vault attachments (images for occlusion, audio recordings), and Anki archive packages (`.apkg`).

## Capabilities and Constraints

- Capabilities: FSRS (and SM-2) spaced repetition algorithms, multi-type card parsing (basic, reversed, cloze deletions, combo, multiple choice, image occlusion, shorthand `::` syntax), audio player with waveform animations and TTS, note review mode, study analytics (charts, heatmaps, retention curves), exam study coach, AI Companion (chat, agentic note editing, test generation), and Anki package import/export.
- Technical & Security Constraints: Strict Obsidian security guidelines—forbidden `innerHTML`/`outerHTML` (imperative DOM/SVG creation only); no `!important` CSS rules; theme tokens (`var(--lk-backdrop-blur)`); single-pass state restoration; strict localization parity between English (`en-base.json`) and Chinese (`zh-cn.json`); domain vocabulary alignment with `GLOSSARY.md`.
- Responsive Constraints: Works on both desktop and mobile viewports with touch-friendly controls and keyboard shortcut navigation.

## Brand Commitments

- Name: LearnKit.
- Voice: Clear, focused, dependable, respectful of the learner's attention, and distraction-free. Avoids gimmicky gamification, intrusive nags, or condescending copy.
- Identity: Blends seamlessly with Obsidian's native visual language and community themes (both light and dark modes) while maintaining crisp typography, structured layouts, and fluid micro-interactions.

## Evidence on Hand

- Published Obsidian Community Plugin (version 1.8.6+).
- Official documentation site built with Astro Starlight (`site/`).
- Brand banners and visual feature assets (`site/branding/`).
- Comprehensive domain language specification in `GLOSSARY.md`.
- Architectural standards and engineering invariants in `AGENTS.md`.

## Product Principles

- **Vault as Single Source of Truth**: Flashcards and retention metadata are anchored in Markdown notes rather than locked inside an opaque proprietary database.
- **Frictionless Active Recall**: Moving from capturing an idea to studying it must take seconds and require zero window-switching.
- **Mathematical Scheduling Rigor**: Spaced repetition intervals rely on modern FSRS adaptive modeling with transparent review states (undo frames, bury, suspend).
- **Privacy & Sovereignty First**: Operates entirely offline and locally by default; AI companion features require explicit opt-in and user-supplied API keys with zero data leakage.

## Accessibility & Inclusion

- Complete keyboard navigation for study sessions, card flipping, ratings, and modal workflows.
- High-contrast visual readability across light and dark theme variations.
- Integrated audio playback and text-to-speech for language learners and auditory comprehension.
- Full localization architecture with automated parity checks across supported languages.

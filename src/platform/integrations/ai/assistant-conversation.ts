/**
 * @file src/platform/integrations/ai/assistant-conversation.ts
 * @summary Deep domain module coordinating AI study assistant conversation
 * workflows: intent routing, streaming responses, edit proposals, suggestion
 * generation with automatic retry loops, and inline exam workflows.
 */

import type { LearnKitSettings } from "../../types/settings";
import type {
  StudyAssistantChatInput,
  StudyAssistantChatMode,
  StudyAssistantChatResult,
  StudyAssistantGeneratorInput,
  StudyAssistantGeneratorResult,
  StudyAssistantReviewDepth,
  StudyAssistantSuggestion,
  StudyAssistantEditProposal,
  StudyAssistantCardType,
  StudyAssistantImageDescriptor,
} from "./study-assistant-types";
import {
  generateStudyAssistantChatReplyStreaming,
  generateStudyAssistantSuggestionsStreaming,
  classifyUserIntent,
  extractVisibleEditResponseText,
  parseEditProposal,
  type UserIntentClassification,
} from "./study-assistant-generator";
import { inferStudyAssistantIntentHeuristically } from "../../../views/study-assistant/chat/intent-routing";
import { validateEditProposal, mentionsFrontmatter } from "../../../views/study-assistant/chat/edit-helpers";
import {
  isTestGenerationRequest,
  parseTestConfigFromRequest,
} from "../../../views/study-assistant/chat/generation-helpers";
import { generateExamQuestions, gradeFullTest } from "./exam-generator-ai";
import type {
  ExamGeneratorConfig,
  GeneratedExamQuestion,
  FullTestGradeResult,
} from "../../../views/exam-generator/exam-generator-types";
import {
  buildSuggestionMarkdownLines,
  parseSuggestionRows,
  type GeneratorOutputOptions,
} from "../../../views/study-assistant/popup/assistant-popup-suggestion-rows";
import { formatInsertBlock } from "../../../views/study-assistant/popup/assistant-popup-text";
import { validateGeneratedCardBlock } from "../../../views/study-assistant/popup/assistant-popup-validation";

// ── Stream Event Types ──

export type CompanionStreamEvent =
  | { type: "intent"; intent: UserIntentClassification }
  | { type: "token"; delta: string; accumulated: string }
  | { type: "edit-proposal"; proposal: StudyAssistantEditProposal; rawText: string }
  | { type: "suggestions"; suggestions: StudyAssistantSuggestion[]; isFinal?: boolean; rejectedReasons?: string[] }
  | { type: "test-questions"; questions: GeneratedExamQuestion[]; markdown: string; config: ExamGeneratorConfig }
  | { type: "test-graded"; result: FullTestGradeResult; markdown: string }
  | {
      type: "done";
      text: string;
      role: "assistant";
      intent?: UserIntentClassification;
      editProposal?: StudyAssistantEditProposal;
      suggestions?: StudyAssistantSuggestion[];
      conversationId?: string;
    }
  | { type: "error"; error: string; rawError?: unknown };

// ── Port Interface ──

export interface AiProviderPort {
  chatStream(params: {
    settings: LearnKitSettings["studyAssistant"];
    input: StudyAssistantChatInput;
    onChunk: (token: string) => void;
    signal?: AbortSignal;
  }): Promise<StudyAssistantChatResult>;

  suggestionsStream(params: {
    settings: LearnKitSettings["studyAssistant"];
    input: StudyAssistantGeneratorInput;
    onSuggestion: (suggestion: StudyAssistantSuggestion) => void;
    signal?: AbortSignal;
  }): Promise<StudyAssistantGeneratorResult>;

  classifyIntent(params: {
    settings: LearnKitSettings["studyAssistant"];
    userMessage: string;
    recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
  }): Promise<UserIntentClassification>;

  generateExam(params: {
    settings: LearnKitSettings["studyAssistant"];
    notes: Array<{ path: string; title: string; content: string }>;
    config: ExamGeneratorConfig;
    attachedFileDataUrls?: string[];
  }): Promise<GeneratedExamQuestion[]>;

  gradeExam(params: {
    settings: LearnKitSettings["studyAssistant"];
    questions: GeneratedExamQuestion[];
    userAnswerText: string;
    difficulty: ExamGeneratorConfig["difficulty"];
  }): Promise<FullTestGradeResult>;
}

export class DefaultAiProviderPort implements AiProviderPort {
  chatStream(params: {
    settings: LearnKitSettings["studyAssistant"];
    input: StudyAssistantChatInput;
    onChunk: (token: string) => void;
    signal?: AbortSignal;
  }): Promise<StudyAssistantChatResult> {
    return generateStudyAssistantChatReplyStreaming(params);
  }

  suggestionsStream(params: {
    settings: LearnKitSettings["studyAssistant"];
    input: StudyAssistantGeneratorInput;
    onSuggestion: (suggestion: StudyAssistantSuggestion) => void;
    signal?: AbortSignal;
  }): Promise<StudyAssistantGeneratorResult> {
    return generateStudyAssistantSuggestionsStreaming(params);
  }

  classifyIntent(params: {
    settings: LearnKitSettings["studyAssistant"];
    userMessage: string;
    recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
  }): Promise<UserIntentClassification> {
    return classifyUserIntent(params);
  }

  generateExam(params: {
    settings: LearnKitSettings["studyAssistant"];
    notes: Array<{ path: string; title: string; content: string }>;
    config: ExamGeneratorConfig;
    attachedFileDataUrls?: string[];
  }): Promise<GeneratedExamQuestion[]> {
    return generateExamQuestions(params);
  }

  gradeExam(params: {
    settings: LearnKitSettings["studyAssistant"];
    questions: GeneratedExamQuestion[];
    userAnswerText: string;
    difficulty: ExamGeneratorConfig["difficulty"];
  }): Promise<FullTestGradeResult> {
    return gradeFullTest(params);
  }
}

// ── Markdown Formatting Helpers ──

export function formatTestQuestionsAsMarkdown(
  questions: GeneratedExamQuestion[],
  config: Pick<ExamGeneratorConfig, "difficulty" | "questionMode" | "questionCount">,
): string {
  const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const header = `**Here's your test** (${questions.length} question${questions.length === 1 ? "" : "s"}, ${config.difficulty} difficulty):\n\nReply with your answers to get graded.\n`;
  const items = questions.map((q, i) => {
    const num = i + 1;
    const lines: string[] = [`**${num}.** ${q.prompt}`];
    if (q.type === "mcq" && q.options) {
      const isMultiSelect = Array.isArray(q.correctIndices) && q.correctIndices.length > 1;
      if (isMultiSelect) lines.push("*(select all that apply)*");
      for (let j = 0; j < q.options.length; j++) {
        lines.push(`  ${OPTION_LABELS[j] ?? String(j + 1)}) ${q.options[j]}`);
      }
    }
    return lines.join("\n");
  });
  return `${header}\n${items.join("\n\n")}`;
}

export function formatTestResultsAsMarkdown(
  gradeResult: FullTestGradeResult,
  questions: GeneratedExamQuestion[],
): string {
  const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const header = `**Results: ${gradeResult.overallScorePercent}%**\n`;
  const items = gradeResult.results.map((r) => {
    const q = questions[r.questionNumber - 1];
    const icon = r.correct ? "✅" : "❌";
    const lines: string[] = [`**Q${r.questionNumber}.** ${icon} (${r.scorePercent}%) — ${r.feedback}`];
    if (q) {
      if (q.type === "mcq" && q.options) {
        const indices = q.correctIndices ?? (q.correctIndex != null ? [q.correctIndex] : []);
        const labels = indices.map((idx) => OPTION_LABELS[idx] ?? String(idx + 1));
        const answers = indices.map((idx) => q.options![idx]).filter(Boolean);
        lines.push(`Correct answer: ${labels.join(", ")} — ${answers.join("; ")}`);
      }
      if (q.explanation) lines.push(`*${q.explanation}*`);
    }
    return lines.join("\n");
  });
  return `${header}\n${items.join("\n\n")}`;
}

export function validateSuggestionsWithRecovery(
  suggestions: StudyAssistantSuggestion[],
  notePath: string,
  generatorOutputOptions: GeneratorOutputOptions,
  tx: (token: string, fallback: string, vars?: Record<string, string | number>) => string,
): { validSuggestions: StudyAssistantSuggestion[]; rejectedReasons: string[] } {
  const validSuggestions: StudyAssistantSuggestion[] = [];
  const rejectedReasons: string[] = [];

  for (const suggestion of suggestions) {
    const text = formatInsertBlock(buildSuggestionMarkdownLines(suggestion, generatorOutputOptions).join("\n"));
    const validationError = validateGeneratedCardBlock(notePath, suggestion, text, tx);
    if (!validationError) {
      validSuggestions.push(suggestion);
      continue;
    }

    // Recovery path: rebuild rows from parsed fields
    const hasExplicitRows = Array.isArray(suggestion.noteRows) && suggestion.noteRows.length > 0;
    if (hasExplicitRows) {
      const parsed = parseSuggestionRows(suggestion);
      const normalizedSuggestion: StudyAssistantSuggestion = {
        ...suggestion,
        question: parsed.question || suggestion.question,
        answer: parsed.answer || suggestion.answer,
        clozeText: parsed.clozeText || suggestion.clozeText,
        options: parsed.options.length ? parsed.options : suggestion.options,
        correctOptionIndexes: parsed.correctOptionIndexes.length
          ? parsed.correctOptionIndexes
          : suggestion.correctOptionIndexes,
        steps: parsed.steps.length ? parsed.steps : suggestion.steps,
        ioSrc: parsed.ioSrc || suggestion.ioSrc,
        noteRows: undefined,
      };

      const normalizedText = formatInsertBlock(buildSuggestionMarkdownLines(normalizedSuggestion, generatorOutputOptions).join("\n"));
      const normalizedError = validateGeneratedCardBlock(notePath, normalizedSuggestion, normalizedText, tx);
      if (!normalizedError) {
        validSuggestions.push(normalizedSuggestion);
        continue;
      }
    }

    rejectedReasons.push(validationError);
  }

  return { validSuggestions, rejectedReasons };
}

// ── Conversation Module ──

export interface NoteContextData {
  path: string;
  title?: string;
  noteContent: string;
  noteContentForAi: string;
  imageRefs?: string[];
  imageDataUrls?: string[];
  attachedFileDataUrls?: string[];
  imageDescriptors?: StudyAssistantImageDescriptor[];
}

export interface AssistantConversationContext {
  settings: LearnKitSettings["studyAssistant"];
  providerPort?: AiProviderPort;
  translator?: (token: string, fallback: string, vars?: Record<string, string | number>) => string;
}

export interface SendMessageOptions {
  userMessage: string;
  noteContext?: NoteContextData;
  recentMessages?: Array<{ role: "user" | "assistant"; text: string }>;
  hasPriorGenerateContext?: boolean;
  attachedFileDataUrls?: string[];
  reviewDepth?: StudyAssistantReviewDepth;
  forceIntent?: UserIntentClassification;
  enabledGeneratorTypes?: StudyAssistantCardType[];
  targetSuggestionCount?: number;
  generatorOutputOptions?: GeneratorOutputOptions;
  conversationId?: string;
}

export interface GenerateCardsOptions {
  noteContext: NoteContextData;
  userMessage?: string;
  enabledTypes: StudyAssistantCardType[];
  targetSuggestionCount?: number;
  generatorOutputOptions?: GeneratorOutputOptions;
  customInstructions?: string;
  conversationId?: string;
  attachedFileDataUrls?: string[];
}

export class AssistantConversation {
  private _port: AiProviderPort;
  private _settings: LearnKitSettings["studyAssistant"];
  private _tx: (token: string, fallback: string, vars?: Record<string, string | number>) => string;
  private _abortController: AbortController | null = null;
  private _pendingTestQuestions: GeneratedExamQuestion[] | null = null;
  private _pendingTestDifficulty: ExamGeneratorConfig["difficulty"] = "medium";
  private _activeConversationId: string | undefined;

  constructor(context: AssistantConversationContext) {
    this._settings = context.settings;
    this._port = context.providerPort ?? new DefaultAiProviderPort();
    this._tx = context.translator ?? ((_, fallback, vars) => {
      if (!vars) return fallback;
      return Object.entries(vars).reduce((acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, "g"), String(v)), fallback);
    });
  }

  updateSettings(settings: LearnKitSettings["studyAssistant"]): void {
    this._settings = settings;
  }

  abort(): void {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  get isStreaming(): boolean {
    return this._abortController !== null;
  }

  hasPendingTest(): boolean {
    return Array.isArray(this._pendingTestQuestions) && this._pendingTestQuestions.length > 0;
  }

  getPendingTest(): { questions: GeneratedExamQuestion[]; difficulty: ExamGeneratorConfig["difficulty"] } | null {
    if (!this.hasPendingTest()) return null;
    return {
      questions: this._pendingTestQuestions!,
      difficulty: this._pendingTestDifficulty,
    };
  }

  setPendingTest(
    questions: GeneratedExamQuestion[] | null,
    difficulty: ExamGeneratorConfig["difficulty"] = "medium",
  ): void {
    this._pendingTestQuestions = questions;
    this._pendingTestDifficulty = difficulty;
  }

  getConversationId(): string | undefined {
    return this._activeConversationId;
  }

  setConversationId(id: string | undefined): void {
    this._activeConversationId = id;
  }

  // ── Unified Send Message Workflow ──

  async *sendMessage(options: SendMessageOptions): AsyncIterable<CompanionStreamEvent> {
    const draft = String(options.userMessage || "").trim();
    const hasAttachments = (options.attachedFileDataUrls?.length ?? 0) > 0;
    if (!draft && !hasAttachments) return;

    // 1. Pending Inline Test Intercept
    if (draft && this.hasPendingTest()) {
      yield* this.gradePendingTest(draft);
      return;
    }

    // 2. Intent Determination
    let intent: UserIntentClassification = options.forceIntent ?? "ask";
    if (!options.forceIntent && draft) {
      const priorMessages = options.recentMessages ?? [];
      const routing = inferStudyAssistantIntentHeuristically({
        text: draft,
        recentMessages: priorMessages,
        hasPriorGenerateContext: options.hasPriorGenerateContext,
      });
      intent = routing.intent;

      if (routing.requiresClassifierFallback) {
        try {
          intent = await this._port.classifyIntent({
            settings: this._settings,
            userMessage: draft,
            recentMessages: priorMessages,
          });
        } catch {
          intent = routing.intent;
        }
      }
    }

    yield { type: "intent", intent };

    // 3. Dispatch to Intent-specific Workflow
    switch (intent) {
      case "generate": {
        if (isTestGenerationRequest(draft)) {
          yield* this.generateInlineTest({
            userMessage: draft,
            noteContext: options.noteContext,
            attachedFileDataUrls: options.attachedFileDataUrls,
          });
        } else {
          yield* this.generateCardsWorkflow({
            userMessage: draft,
            noteContext: options.noteContext,
            enabledTypes: options.enabledGeneratorTypes ?? ["basic", "cloze"],
            targetSuggestionCount: options.targetSuggestionCount,
            generatorOutputOptions: options.generatorOutputOptions,
            attachedFileDataUrls: options.attachedFileDataUrls,
            conversationId: options.conversationId ?? this._activeConversationId,
          });
        }
        break;
      }

      case "edit": {
        yield* this.chatStreamingWorkflow({
          mode: "edit",
          userMessage: draft,
          noteContext: options.noteContext,
          recentMessages: options.recentMessages,
          attachedFileDataUrls: options.attachedFileDataUrls,
          conversationId: options.conversationId ?? this._activeConversationId,
        });
        break;
      }

      case "review": {
        yield* this.chatStreamingWorkflow({
          mode: "review",
          userMessage: draft,
          noteContext: options.noteContext,
          recentMessages: options.recentMessages,
          attachedFileDataUrls: options.attachedFileDataUrls,
          reviewDepth: options.reviewDepth ?? "standard",
          conversationId: options.conversationId ?? this._activeConversationId,
        });
        break;
      }

      case "ask":
      default: {
        yield* this.chatStreamingWorkflow({
          mode: "ask",
          userMessage: draft,
          noteContext: options.noteContext,
          recentMessages: options.recentMessages,
          attachedFileDataUrls: options.attachedFileDataUrls,
          conversationId: options.conversationId ?? this._activeConversationId,
        });
        break;
      }
    }
  }

  // ── Streaming Chat Workflow (ask / edit / review) ──

  private async *chatStreamingWorkflow(params: {
    mode: StudyAssistantChatMode;
    userMessage: string;
    noteContext?: NoteContextData;
    recentMessages?: Array<{ role: "user" | "assistant"; text: string }>;
    attachedFileDataUrls?: string[];
    reviewDepth?: StudyAssistantReviewDepth;
    conversationId?: string;
  }): AsyncIterable<CompanionStreamEvent> {
    const { mode, userMessage, noteContext, recentMessages, attachedFileDataUrls, reviewDepth, conversationId } = params;

    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    let accumulatedText = "";
    const tokenQueue: Array<{ delta: string; accumulated: string }> = [];
    let resolveToken: (() => void) | null = null;
    let streamFinished = false;
    let streamError: unknown = null;

    const includeImages = mode === "review"
      ? !!this._settings.privacy?.includeImagesInReview
      : !!this._settings.privacy?.includeImagesInAsk;

    const chatInput: StudyAssistantChatInput = {
      mode,
      notePath: noteContext?.path ?? "",
      noteContent: noteContext?.noteContentForAi ?? noteContext?.noteContent ?? "",
      imageRefs: noteContext?.imageRefs ?? [],
      imageDataUrls: noteContext?.imageDataUrls ?? [],
      attachedFileDataUrls: attachedFileDataUrls ?? noteContext?.attachedFileDataUrls ?? [],
      includeImages,
      userMessage,
      customInstructions: String(this._settings.prompts?.assistant || "").trim(),
      reviewDepth,
      conversationId: conversationId ?? this._activeConversationId,
      conversationHistory: recentMessages,
    };

    const completionPromise = this._port
      .chatStream({
        settings: this._settings,
        input: chatInput,
        onChunk: (token: string) => {
          accumulatedText += token;
          tokenQueue.push({ delta: token, accumulated: accumulatedText });
          if (resolveToken) {
            resolveToken();
            resolveToken = null;
          }
        },
        signal,
      })
      .then((res) => {
        streamFinished = true;
        if (resolveToken) resolveToken();
        return res;
      })
      .catch((err) => {
        streamFinished = true;
        streamError = err;
        if (resolveToken) resolveToken();
        return null;
      });

    try {
      while (!streamFinished || tokenQueue.length > 0) {
        if (tokenQueue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveToken = resolve;
          });
        }
        while (tokenQueue.length > 0) {
          const item = tokenQueue.shift()!;
          yield { type: "token", delta: item.delta, accumulated: item.accumulated };
        }
      }

      if (streamError) {
        if (signal.aborted) {
          yield { type: "done", text: accumulatedText, role: "assistant" };
          return;
        }
        throw streamError;
      }

      const result = await completionPromise;
      if (!result) {
        yield { type: "done", text: accumulatedText, role: "assistant" };
        return;
      }

      this._activeConversationId = result.conversationId;

      if (mode === "edit") {
        const rawText = result.rawResponseText || accumulatedText;
        const visibleText = extractVisibleEditResponseText(rawText);
        const parsed = parseEditProposal(rawText);

        if (parsed && noteContext?.noteContent) {
          const allowFrontmatter = mentionsFrontmatter(userMessage);
          const validation = validateEditProposal(parsed.edits, noteContext.noteContent, allowFrontmatter);

          if (validation.validEdits.length > 0) {
            const proposal: StudyAssistantEditProposal = {
              summary: parsed.summary,
              edits: validation.validEdits,
            };
            yield { type: "edit-proposal", proposal, rawText };
            yield {
              type: "done",
              text: visibleText,
              role: "assistant",
              intent: "edit",
              editProposal: proposal,
              conversationId: result.conversationId,
            };
            return;
          }
        }

        yield {
          type: "done",
          text: visibleText || accumulatedText,
          role: "assistant",
          intent: "edit",
          conversationId: result.conversationId,
        };
      } else {
        yield {
          type: "done",
          text: result.reply || accumulatedText,
          role: "assistant",
          intent: mode,
          conversationId: result.conversationId,
        };
      }
    } catch (e) {
      if (signal.aborted) {
        yield { type: "done", text: accumulatedText, role: "assistant" };
      } else {
        const errorMsg = e instanceof Error ? e.message : String(e);
        yield { type: "error", error: errorMsg, rawError: e };
      }
    } finally {
      this._abortController = null;
    }
  }

  // ── Flashcard Generation Workflow (with 50% invalid auto-retry loop) ──

  async *generateCardsWorkflow(options: {
    userMessage?: string;
    noteContext?: NoteContextData;
    enabledTypes: StudyAssistantCardType[];
    targetSuggestionCount?: number;
    generatorOutputOptions?: GeneratorOutputOptions;
    attachedFileDataUrls?: string[];
    conversationId?: string;
  }): AsyncIterable<CompanionStreamEvent> {
    const {
      userMessage,
      noteContext,
      enabledTypes,
      targetSuggestionCount = 5,
      generatorOutputOptions = { includeTitle: true, includeInfo: true, includeGroups: true },
      attachedFileDataUrls,
      conversationId,
    } = options;

    if (!noteContext) {
      yield { type: "error", error: this._tx("ui.studyAssistant.generator.noNote", "Open a markdown note to generate flashcards.") };
      return;
    }

    if (!enabledTypes.length) {
      yield { type: "error", error: this._tx("ui.studyAssistant.generator.noTypes", "Enable at least one flashcard type in settings before generating.") };
      return;
    }

    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    const streamedSuggestions: StudyAssistantSuggestion[] = [];
    const streamedKeys = new Set<string>();

    const baseInput: StudyAssistantGeneratorInput = {
      notePath: noteContext.path,
      noteContent: noteContext.noteContentForAi || noteContext.noteContent,
      imageRefs: noteContext.imageRefs ?? [],
      imageDescriptors: noteContext.imageDescriptors ?? [],
      imageDataUrls: noteContext.imageDataUrls ?? [],
      attachedFileDataUrls: attachedFileDataUrls ?? noteContext.attachedFileDataUrls ?? [],
      includeImages: !!this._settings.privacy?.includeImagesInFlashcard,
      enabledTypes,
      targetSuggestionCount,
      includeTitle: generatorOutputOptions.includeTitle,
      includeInfo: generatorOutputOptions.includeInfo,
      includeGroups: generatorOutputOptions.includeGroups,
      customInstructions: String(this._settings.prompts?.assistant || "").trim(),
      userRequestText: userMessage,
      conversationId: conversationId ?? this._activeConversationId,
    };

    try {
      let result = await this._port.suggestionsStream({
        settings: this._settings,
        input: baseInput,
        onSuggestion: (s) => {
          const key = `${s.type}-${s.question || s.clozeText || s.title}`;
          if (!streamedKeys.has(key)) {
            streamedKeys.add(key);
            streamedSuggestions.push(s);
          }
        },
        signal,
      });

      this._activeConversationId = result.conversationId;

      // Validate Suggestions
      let validation = validateSuggestionsWithRecovery(
        streamedSuggestions,
        noteContext.path,
        generatorOutputOptions,
        this._tx,
      );

      const invalidRetryThreshold = 0.5;
      const rejectedRatio = streamedSuggestions.length > 0
        ? validation.rejectedReasons.length / streamedSuggestions.length
        : 0;

      // Auto-retry loop if rejection ratio exceeds threshold and not aborted
      if (rejectedRatio > invalidRetryThreshold && !signal.aborted) {
        const retryInstructions = [
          baseInput.customInstructions,
          "IMPORTANT: Several previously generated flashcards failed strict syntax validation:",
          ...validation.rejectedReasons.map((r, i) => `${i + 1}. ${r}`),
          "Regenerate valid cards ensuring exact syntax.",
        ].filter(Boolean).join("\n\n");

        streamedSuggestions.length = 0;
        streamedKeys.clear();

        result = await this._port.suggestionsStream({
          settings: this._settings,
          input: {
            ...baseInput,
            customInstructions: retryInstructions,
            conversationId: result.conversationId,
          },
          onSuggestion: (s) => {
            const key = `${s.type}-${s.question || s.clozeText || s.title}`;
            if (!streamedKeys.has(key)) {
              streamedKeys.add(key);
              streamedSuggestions.push(s);
            }
          },
          signal,
        });

        validation = validateSuggestionsWithRecovery(
          streamedSuggestions,
          noteContext.path,
          generatorOutputOptions,
          this._tx,
        );
      }

      yield {
        type: "suggestions",
        suggestions: validation.validSuggestions,
        isFinal: true,
        rejectedReasons: validation.rejectedReasons,
      };

      const summaryText = `Generated ${validation.validSuggestions.length} flashcard${validation.validSuggestions.length === 1 ? "" : "s"}.`;
      yield {
        type: "done",
        text: summaryText,
        role: "assistant",
        intent: "generate",
        suggestions: validation.validSuggestions,
        conversationId: result.conversationId,
      };
    } catch (e) {
      if (signal.aborted) {
        yield { type: "suggestions", suggestions: streamedSuggestions, isFinal: true };
        yield { type: "done", text: "Generation stopped.", role: "assistant" };
      } else {
        const errorMsg = e instanceof Error ? e.message : String(e);
        yield { type: "error", error: errorMsg, rawError: e };
      }
    } finally {
      this._abortController = null;
    }
  }

  // ── Inline Exam Generation & Grading Workflows ──

  async *generateInlineTest(options: {
    userMessage: string;
    noteContext?: NoteContextData;
    attachedFileDataUrls?: string[];
  }): AsyncIterable<CompanionStreamEvent> {
    const { userMessage, noteContext, attachedFileDataUrls } = options;

    if (!noteContext) {
      yield { type: "error", error: this._tx("ui.studyAssistant.chat.noNote", "Open a markdown note to generate a test.") };
      return;
    }

    const parsed = parseTestConfigFromRequest(userMessage);
    const config: ExamGeneratorConfig = {
      difficulty: parsed.difficulty ?? "medium",
      questionMode: parsed.questionMode ?? "mixed",
      questionCount: parsed.questionCount ?? 5,
      testName: "",
      appliedScenarios: parsed.appliedScenarios ?? false,
      timed: false,
      durationMinutes: 15,
      customInstructions: String(this._settings.prompts?.tests || "").trim(),
      includeFlashcards: false,
      sourceMode: "selected",
      folderPath: "",
      includeSubfolders: false,
      maxFolderNotes: 20,
    };

    try {
      const questions = await this._port.generateExam({
        settings: this._settings,
        notes: [{
          path: noteContext.path,
          title: noteContext.title || noteContext.path,
          content: noteContext.noteContentForAi || noteContext.noteContent,
        }],
        config,
        attachedFileDataUrls: attachedFileDataUrls ?? noteContext.attachedFileDataUrls,
      });

      if (!questions.length) {
        const noQuestionsMsg = this._tx(
          "ui.studyAssistant.test.noQuestions",
          "I couldn't generate questions from this note. Try a note with more educational content.",
        );
        yield { type: "done", text: noQuestionsMsg, role: "assistant" };
        return;
      }

      this._pendingTestQuestions = questions;
      this._pendingTestDifficulty = config.difficulty;

      const markdown = formatTestQuestionsAsMarkdown(questions, config);
      yield { type: "test-questions", questions, markdown, config };
      yield { type: "done", text: markdown, role: "assistant" };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      yield { type: "error", error: errorMsg, rawError: e };
    }
  }

  async *gradePendingTest(userAnswerText: string): AsyncIterable<CompanionStreamEvent> {
    const questions = this._pendingTestQuestions;
    if (!questions?.length) return;
    const difficulty = this._pendingTestDifficulty;

    // Clear pending test questions so subsequent user messages route normally
    this._pendingTestQuestions = null;

    try {
      const result = await this._port.gradeExam({
        settings: this._settings,
        questions,
        userAnswerText,
        difficulty,
      });

      const markdown = formatTestResultsAsMarkdown(result, questions);
      yield { type: "test-graded", result, markdown };
      yield { type: "done", text: markdown, role: "assistant" };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      yield { type: "error", error: errorMsg, rawError: e };
    }
  }
}

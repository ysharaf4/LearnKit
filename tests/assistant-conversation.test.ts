/**
 * @file tests/assistant-conversation.test.ts
 * @summary Headless unit tests for the deep AssistantConversation module.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AssistantConversation,
  type AiProviderPort,
  type CompanionStreamEvent,
  formatTestQuestionsAsMarkdown,
  formatTestResultsAsMarkdown,
} from "../src/platform/integrations/ai/assistant-conversation";
import type { LearnKitSettings } from "../src/platform/types/settings";
import type {
  StudyAssistantChatResult,
  StudyAssistantGeneratorResult,
  StudyAssistantSuggestion,
} from "../src/platform/integrations/ai/study-assistant-types";
import type {
  GeneratedExamQuestion,
  FullTestGradeResult,
} from "../src/views/exam-generator/exam-generator-types";

function createMockSettings(): LearnKitSettings["studyAssistant"] {
  return {
    provider: "openai",
    model: "gpt-4o",
    apiKey: "test-key",
    endpointOverride: "",
    timeoutSeconds: 30,
    generatorTargetCount: 5,
    location: "floating",
    modalButtonVisibility: "show",
    generatorTypes: {
      basic: true,
      reversed: false,
      cloze: true,
      combo: false,
      list: false,
      choice: false,
      steps: false,
      io: false,
    },
    generatorOutput: {
      includeTitle: true,
      includeInfo: true,
      includeGroups: true,
    },
    prompts: {
      assistant: "You are a helpful tutor.",
      tests: "Generate exam questions.",
    },
    privacy: {
      autoSendOnOpen: false,
      includeImagesInAsk: true,
      includeImagesInReview: true,
      includeImagesInFlashcard: true,
      includeAttachmentsInCompanion: false,
      includeLinkedNotesInCompanion: false,
      includeAttachmentsInExam: false,
      includeLinkedNotesInExam: false,
      includeLinkedAttachmentsInCompanion: false,
      includeLinkedAttachmentsInExam: false,
      syncDeletesToProvider: false,
      allowPii: false,
      allowTelemetry: false,
      contextLimitPreset: "standard",
      textAttachmentLimitPreset: "standard",
    },
  };
}

describe("AssistantConversation", () => {
  it("routes heuristic question to 'ask' and streams tokens incrementally", async () => {
    const mockPort: AiProviderPort = {
      chatStream: vi.fn(async ({ onChunk }) => {
        onChunk("Hello ");
        onChunk("world!");
        return {
          reply: "Hello world!",
          payloadPreview: "",
          rawResponseText: "Hello world!",
          attachmentRoute: "none",
          conversationId: "conv-123",
        };
      }),
      suggestionsStream: vi.fn(),
      classifyIntent: vi.fn(),
      generateExam: vi.fn(),
      gradeExam: vi.fn(),
    };

    const conv = new AssistantConversation({
      settings: createMockSettings(),
      providerPort: mockPort,
    });

    const events: CompanionStreamEvent[] = [];
    for await (const ev of conv.sendMessage({
      userMessage: "What is mitochondrial respiration?",
      noteContext: {
        path: "Biology/Cell.md",
        noteContent: "Mitochondria produce ATP.",
        noteContentForAi: "Mitochondria produce ATP.",
      },
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "intent", intent: "ask" },
      { type: "token", delta: "Hello ", accumulated: "Hello " },
      { type: "token", delta: "world!", accumulated: "Hello world!" },
      {
        type: "done",
        text: "Hello world!",
        role: "assistant",
        intent: "ask",
        conversationId: "conv-123",
      },
    ]);
    expect(conv.getConversationId()).toBe("conv-123");
  });

  it("triggers classifier fallback on ambiguous intent", async () => {
    const mockPort: AiProviderPort = {
      chatStream: vi.fn(async () => ({
        reply: "Applying your changes.",
        payloadPreview: "",
        rawResponseText: "Applying your changes.",
        attachmentRoute: "none",
      })),
      suggestionsStream: vi.fn(),
      classifyIntent: vi.fn(async () => "edit"),
      generateExam: vi.fn(),
      gradeExam: vi.fn(),
    };

    const conv = new AssistantConversation({
      settings: createMockSettings(),
      providerPort: mockPort,
    });

    const events: CompanionStreamEvent[] = [];
    for await (const ev of conv.sendMessage({
      userMessage: "sounds good, do it",
      recentMessages: [
        { role: "user", text: "What do you think of this section?" },
        { role: "assistant", text: "The section explains mitosis well." },
      ],
      noteContext: {
        path: "Notes/Draft.md",
        noteContent: "This is draft text.",
        noteContentForAi: "This is draft text.",
      },
    })) {
      events.push(ev);
    }

    expect(mockPort.classifyIntent).toHaveBeenCalled();
    const intentEvent = events.find((e) => e.type === "intent");
    expect(intentEvent).toEqual({ type: "intent", intent: "edit" });
  });

  it("parses and validates edit proposal blocks against note content", async () => {
    const rawAiReply = `Here is the revised sentence:
<learnkit-edit-proposal>{"summary":"Fix spelling of mitochondria","edits":[{"original":"Mitochondria produce ATP","replacement":"Mitochondria generate cellular ATP"}]}</learnkit-edit-proposal>`;

    const mockPort: AiProviderPort = {
      chatStream: vi.fn(async () => ({
        reply: rawAiReply,
        payloadPreview: "",
        rawResponseText: rawAiReply,
        attachmentRoute: "none",
      })),
      suggestionsStream: vi.fn(),
      classifyIntent: vi.fn(),
      generateExam: vi.fn(),
      gradeExam: vi.fn(),
    };

    const conv = new AssistantConversation({
      settings: createMockSettings(),
      providerPort: mockPort,
    });

    const noteContent = `# Biology\n\nMitochondria produce ATP.\n`;
    const events: CompanionStreamEvent[] = [];

    for await (const ev of conv.sendMessage({
      userMessage: "Rewrite the sentence about mitochondria",
      forceIntent: "edit",
      noteContext: {
        path: "Bio.md",
        noteContent,
        noteContentForAi: noteContent,
      },
    })) {
      events.push(ev);
    }

    const proposalEvent = events.find((e) => e.type === "edit-proposal");
    expect(proposalEvent).toBeDefined();
    if (proposalEvent?.type === "edit-proposal") {
      expect(proposalEvent.proposal.summary).toBe("Fix spelling of mitochondria");
      expect(proposalEvent.proposal.edits).toHaveLength(1);
      expect(proposalEvent.proposal.edits[0]).toEqual({
        original: "Mitochondria produce ATP",
        replacement: "Mitochondria generate cellular ATP",
      });
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      expect(doneEvent.text).toBe("Here is the revised sentence:");
      expect(doneEvent.editProposal).toBeDefined();
    }
  });

  it("executes suggestion generation with auto-retry loop when initial cards fail validation", async () => {
    let callCount = 0;
    const mockPort: AiProviderPort = {
      chatStream: vi.fn(),
      suggestionsStream: vi.fn(async ({ onSuggestion }) => {
        callCount++;
        if (callCount === 1) {
          // Bad card (empty answer) + good card
          onSuggestion({
            type: "basic",
            difficulty: 1,
            question: "Question without answer?",
            answer: "",
          });
          onSuggestion({
            type: "basic",
            difficulty: 1,
            question: "Another broken card?",
            answer: "",
          });
          return {
            suggestions: [],
            payloadPreview: "",
            rawResponseText: "",
            attachmentRoute: "none",
          };
        } else {
          // Retry yields valid cards
          const validCard: StudyAssistantSuggestion = {
            type: "basic",
            difficulty: 1,
            question: "What is ATP?",
            answer: "Energy currency of the cell.",
          };
          onSuggestion(validCard);
          return {
            suggestions: [validCard],
            payloadPreview: "",
            rawResponseText: "",
            attachmentRoute: "none",
          };
        }
      }),
      classifyIntent: vi.fn(),
      generateExam: vi.fn(),
      gradeExam: vi.fn(),
    };

    const conv = new AssistantConversation({
      settings: createMockSettings(),
      providerPort: mockPort,
    });

    const events: CompanionStreamEvent[] = [];
    for await (const ev of conv.generateCardsWorkflow({
      noteContext: {
        path: "Notes/Biology.md",
        noteContent: "ATP is the energy currency.",
        noteContentForAi: "ATP is the energy currency.",
      },
      enabledTypes: ["basic"],
      targetSuggestionCount: 2,
    })) {
      events.push(ev);
    }

    // Verify retry happened
    expect(callCount).toBe(2);

    const suggestionsEvent = events.find((e) => e.type === "suggestions");
    expect(suggestionsEvent).toBeDefined();
    if (suggestionsEvent?.type === "suggestions") {
      expect(suggestionsEvent.suggestions).toHaveLength(1);
      expect(suggestionsEvent.suggestions[0].question).toBe("What is ATP?");
    }
  });

  it("orchestrates inline test generation and two-turn answer grading", async () => {
    const mockQuestions: GeneratedExamQuestion[] = [
      {
        type: "mcq",
        prompt: "Where does glycolysis occur?",
        options: ["Cytoplasm", "Mitochondria", "Nucleus"],
        correctIndex: 0,
        explanation: "Glycolysis occurs in the cytoplasm.",
      },
    ];

    const mockGradeResult: FullTestGradeResult = {
      overallScorePercent: 100,
      passed: true,
      results: [
        {
          questionNumber: 1,
          type: "mcq",
          correct: true,
          scorePercent: 100,
          feedback: "Correct! Glycolysis occurs in the cytosol/cytoplasm.",
        },
      ],
    };

    const mockPort: AiProviderPort = {
      chatStream: vi.fn(),
      suggestionsStream: vi.fn(),
      classifyIntent: vi.fn(),
      generateExam: vi.fn(async () => mockQuestions),
      gradeExam: vi.fn(async () => mockGradeResult),
    };

    const conv = new AssistantConversation({
      settings: createMockSettings(),
      providerPort: mockPort,
    });

    // Turn 1: Generate test
    const turn1Events: CompanionStreamEvent[] = [];
    for await (const ev of conv.sendMessage({
      userMessage: "Generate a test on glycolysis with 1 question",
      noteContext: {
        path: "Cell.md",
        noteContent: "Glycolysis takes place in the cytoplasm.",
        noteContentForAi: "Glycolysis takes place in the cytoplasm.",
      },
    })) {
      turn1Events.push(ev);
    }

    expect(conv.hasPendingTest()).toBe(true);
    const testEvent = turn1Events.find((e) => e.type === "test-questions");
    expect(testEvent).toBeDefined();
    if (testEvent?.type === "test-questions") {
      expect(testEvent.questions).toEqual(mockQuestions);
      expect(testEvent.markdown).toContain("Where does glycolysis occur?");
    }

    // Turn 2: User answers the test -> intercept routes directly to grading!
    const turn2Events: CompanionStreamEvent[] = [];
    for await (const ev of conv.sendMessage({
      userMessage: "1. A",
      noteContext: {
        path: "Cell.md",
        noteContent: "Glycolysis takes place in the cytoplasm.",
        noteContentForAi: "Glycolysis takes place in the cytoplasm.",
      },
    })) {
      turn2Events.push(ev);
    }

    expect(conv.hasPendingTest()).toBe(false);
    expect(mockPort.gradeExam).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: mockQuestions,
        userAnswerText: "1. A",
      }),
    );

    const gradeEvent = turn2Events.find((e) => e.type === "test-graded");
    expect(gradeEvent).toBeDefined();
    if (gradeEvent?.type === "test-graded") {
      expect(gradeEvent.result.overallScorePercent).toBe(100);
      expect(gradeEvent.markdown).toContain("100%");
      expect(gradeEvent.markdown).toContain("Correct answer: A");
    }
  });

  it("aborts active stream cleanly", async () => {
    let cancelSignaled = false;
    const mockPort: AiProviderPort = {
      chatStream: vi.fn(async ({ onChunk, signal }) => {
        onChunk("Part 1 ");
        if (signal) {
          signal.addEventListener("abort", () => {
            cancelSignaled = true;
          });
        }
        await new Promise((r) => setTimeout(r, 200));
        onChunk("Part 2");
        return {
          reply: "Part 1 Part 2",
          payloadPreview: "",
          rawResponseText: "Part 1 Part 2",
          attachmentRoute: "none",
        };
      }),
      suggestionsStream: vi.fn(),
      classifyIntent: vi.fn(),
      generateExam: vi.fn(),
      gradeExam: vi.fn(),
    };

    const conv = new AssistantConversation({
      settings: createMockSettings(),
      providerPort: mockPort,
    });

    const iterator = conv.sendMessage({
      userMessage: "Tell me a long story",
      noteContext: {
        path: "Story.md",
        noteContent: "Story notes",
        noteContentForAi: "Story notes",
      },
    })[Symbol.asyncIterator]();

    // Read first event (intent)
    await iterator.next();
    // Read second event (token: "Part 1 ")
    await iterator.next();

    expect(conv.isStreaming).toBe(true);
    conv.abort();
    expect(cancelSignaled).toBe(true);
  });
});

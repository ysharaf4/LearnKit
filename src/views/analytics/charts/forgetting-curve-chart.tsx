/**
 * Charting engine note — please read before changing the chart library.
 *
 * This module (and its siblings in this folder) renders with Recharts, which is
 * built on Redux Toolkit internally: recharts -> @reduxjs/toolkit -> redux,
 * immer, redux-thunk, react-redux. Nothing in LearnKit imports Redux directly.
 *
 * Community review reports one warning against the shipped bundle:
 *
 *   "Plugin assembles domain names at runtime - split/join domain assembly"
 *
 * The only text in the bundle that matches that shape is Redux's own random
 * action-token generator, which decorates a random string with dots:
 *
 *   Math.random().toString(36).substring(7).split("").join(".")
 *
 * It is not a domain, nothing is assembled at runtime to hide an endpoint, and
 * every host this plugin can reach is a literal string in
 * src/platform/integrations/ (see the README's Privacy & Disclosures section).
 *
 * This is deliberately NOT patched at build time. Rewriting vendored code would
 * silently stop matching when Recharts or Redux is next bumped, so the warning
 * is accepted and explained instead. Removing it for good would mean rendering
 * these charts with a library that has no Redux inside it.
 */

/**
 * @file src/analytics/forgetting-curve-chart.tsx
 * @summary Interactive forgetting-curve chart that lets users search for and select
 * up to three cards, then plots each card's FSRS retrievability over time as a line
 * chart. It replays each card's review history through the scheduler to reconstruct
 * a stability timeline and uses the FSRS forgetting curve formula to project future
 * memory retention.
 *
 * @exports
 *   - ForgettingCurveChart — React component rendering a multi-card forgetting-curve line chart with card search and selection
 */
import {  } from "obsidian";

import * as React from "react";
import { Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { generatorParameters, forgetting_curve } from "ts-fsrs";
import type { CardRecord, CardState, ReviewLogEntry } from "../../../platform/core/store";
import type { ReviewResult } from "../../../platform/types/review";
import { gradeFromPassFail, gradeFromRating, resetCardScheduling, type SchedulerSettings } from "../../../engine/scheduler/scheduler";
import { useAnalyticsPopoverZIndex } from "../filter-styles";
import { cssClassForProps } from "../../../platform/core/ui";
import { interfaceLocaleToIntlLocale } from "../../../platform/translations/locale-registry";
import { t } from "../../../platform/translations/translator";

function InfoIcon(props: { text: string }) {
  return (
    <span
      className="inline-flex items-center text-muted-foreground"
      data-tooltip={props.text}
      data-tooltip-position="right"
    >
      <svg
        className="svg-icon lucide-info"
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    </span>
  );
}

const MS_DAY = 24 * 60 * 60 * 1000;
const MAX_SELECTIONS = 3;
const DEFAULT_SCHEDULER: SchedulerSettings = {
  learningStepsMinutes: [10, 1440],
  relearningStepsMinutes: [10],
  requestRetention: 0.9,
  enableFuzz: true,
};

const LINE_COLORS = [
  "var(--chart-accent-1)",
  "var(--chart-accent-2)",
  "var(--chart-accent-3)",
  "var(--chart-accent-4)",
  "var(--theme-accent)",
];

const LINE_PATTERNS: Array<string | undefined> = [
  undefined, // solid
  "6 4",     // dashed
  "2 3",     // dotted
];

function createEmptySearch(): SearchState {
  return { query: "", error: null };
}

type CurveMeta = {
  id: string;
  label: string;
  fullQuestion: string;
  color: string;
  strokeDasharray?: string;
  stabilityDays: number;
  lastReviewAt: number;
  firstReviewAt: number;
  horizon: number;
  timeline: Array<{ at: number; stability: number }>;
  title?: string | null;
  location?: string | null;
  currentRetrievability?: number | null;
  elapsedDays?: number | null;
  dueDay?: number | null;
  dueStatus?: string | null;
};

type CurveIssue = {
  id: string;
  reason: string;
};

type DataRow = {
  day: number;
  [key: string]: number | null;
};

type SearchResult = {
  id: string;
  label: string;
  location: string;
  title: string;
  preview: string;
  score: number;
};

type SearchState = {
  query: string;
  error: string | null;
};

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function minutesToStepUnit(m: number): `${number}m` | `${number}h` | `${number}d` {
  const mm = Math.max(1, Math.round(m));
  if (mm % 1440 === 0) return `${mm / 1440}d`;
  if (mm % 60 === 0) return `${mm / 60}h`;
  return `${mm}m`;
}

function buildFsrsParams(cfg?: SchedulerSettings | null) {
  const safeCfg = cfg ?? DEFAULT_SCHEDULER;
  const learning = (safeCfg.learningStepsMinutes ?? []).map(minutesToStepUnit);

  const relearningRaw = Array.isArray(safeCfg.relearningStepsMinutes) ? safeCfg.relearningStepsMinutes : [];
  const relearning =
    relearningRaw.length > 0
      ? relearningRaw.map(minutesToStepUnit)
      : [(learning.length ? learning[0] : "10m")];

  const requestRetention = clamp(Number(safeCfg.requestRetention) || 0.9, 0.8, 0.97);

  return generatorParameters({
    request_retention: requestRetention,
    maximum_interval: 36500,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: learning.length ? learning : ["10m"],
    relearning_steps: relearning,
  });
}

function extractNineDigitId(raw: string): string | null {
  const match = raw.match(/\d{9}/);
  return match ? match[0] : null;
}

function formatCardLabel(id: string) {
  const digits = extractNineDigitId(id);
  return digits ?? id;
}

function cleanCardText(raw: unknown): string {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/\*{2,}/g, "").replace(/\*/g, "");
  s = s.replace(/(?<!\w)_|_(?!\w)/g, "");
  s = s.replace(/==/g, "").replace(/~~/g, "");
  s = s.replace(/`+/g, "");
  s = s.replace(/\{\{c\d+::/gi, "").replace(/\}\}/g, "");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

function getCardDisplayLabel(card?: CardRecord | null, id?: string, maxChars = 28): string {
  if (card) {
    const text = card.q ?? card.stem ?? card.clozeText ?? card.prompt ?? card.title ?? "";
    const cleaned = cleanCardText(text);
    if (cleaned) {
      return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
    }
    if (card.title?.trim()) {
      const t = cleanCardText(card.title);
      return t.length <= maxChars ? t : `${t.slice(0, maxChars - 1)}…`;
    }
  }
  if (id) {
    const digits = extractNineDigitId(id);
    return digits ? `#${digits}` : id;
  }
  return "Card";
}

function normalizeSearchText(raw: string) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function formatLocation(path: string | null | undefined) {
  const raw = String(path ?? "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/\.md$/i, "").replace(/\s*\/\s*/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) return "";
  const tail = parts.slice(-2).join("/");
  return parts.length > 2 ? `.../${tail}` : tail;
}

function getQuestionPreview(card: CardRecord, maxChars = 48) {
  const raw =
    card.q ??
    card.stem ??
    card.clozeText ??
    card.prompt ??
    "";
  const cleaned = cleanCardText(raw);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

function getCardStability(state?: CardState | null) {
  if (!state) return 0;
  if (state.stage === "new") return 0;
  const stabilityDays = Number(state.stabilityDays ?? 0);
  if (Number.isFinite(stabilityDays) && stabilityDays > 0) return Math.max(0.1, stabilityDays);
  const scheduledDays = Number(state.scheduledDays ?? 0);
  if (state.stage === "review" && Number.isFinite(scheduledDays) && scheduledDays > 0) return Math.max(0.1, scheduledDays);
  return 0;
}

function normalizeReviewResult(result: ReviewResult | null | undefined): Exclude<ReviewResult, "skip"> | null {
  const r = String(result ?? "").toLowerCase();
  if (r === "pass" || r === "fail") return r;
  if (r === "again" || r === "hard" || r === "good" || r === "easy") return r;
  if (r === "skip") return null;
  return null;
}

function buildStabilityTimeline(
  cardId: string,
  entries: ReviewLogEntry[],
  scheduler: SchedulerSettings,
): Array<{ at: number; stability: number }> {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  let state: CardState = resetCardScheduling(
    {
      id: cardId,
      stage: "new",
      due: sorted[0].at,
      reps: 0,
      lapses: 0,
      learningStepIndex: 0,
      scheduledDays: 0,
    },
    sorted[0].at,
  );

  const timeline: Array<{ at: number; stability: number }> = [];
  for (const entry of sorted) {
    const rating = normalizeReviewResult(entry.result);
    if (!rating) continue;
    const now = Number(entry.at);
    const graded =
      rating === "pass" || rating === "fail"
        ? gradeFromPassFail(state, rating, now, { scheduling: scheduler })
        : gradeFromRating(state, rating, now, { scheduling: scheduler });
    state = graded.nextState;
    const stability = getCardStability(state);
    timeline.push({ at: now, stability });
  }
  return timeline;
}

function CardCurveTooltip(props: {
  active?: boolean;
  payload?: Array<{ value?: number; name?: string; dataKey?: string; color?: string }>;
  label?: number;
  baseStart: number;
  curveMetaMap?: Map<string, CurveMeta>;
  requestRetention?: number;
  locale?: string;
  tx: (token: string, fallback: string, vars?: Record<string, string | number>) => string;
}) {
  if (!props.active || !props.payload?.length) return null;
  const dayIndex = typeof props.label === "number" ? props.label : 0;
  const date = new Date(props.baseStart + dayIndex * MS_DAY).toLocaleDateString(props.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return (
    <div className="learnkit-data-tooltip-surface p-2.5 max-w-xs shadow-md rounded border border-border/40">
      <div className="text-xs font-semibold text-background mb-1.5 flex items-center justify-between">
        <span>{date}</span>
        {typeof props.requestRetention === "number" ? (
          <span className="text-[10px] font-normal text-background/70">
            {props.tx("ui.analytics.forgettingCurve.due", "Due")}: {Math.round(props.requestRetention * 100)}%
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {props.payload.map((entry) => {
          const cardId = String(entry?.dataKey ?? "");
          const meta = props.curveMetaMap?.get(cardId);
          const value = Number(entry?.value ?? 0);
          const label = meta?.label ?? String(entry?.name ?? cardId);
          const dueStatus = meta?.dueStatus;
          const dash = meta?.strokeDasharray;

          return (
            <div key={cardId} className="flex flex-col gap-0.5 border-t border-background/15 pt-1.5 first:border-0 first:pt-0">
              <div className="flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <svg width="14" height="6" className="shrink-0" aria-hidden="true">
                    <line
                      x1="0"
                      y1="3"
                      x2="14"
                      y2="3"
                      stroke={entry.color}
                      strokeWidth="2.5"
                      strokeDasharray={dash}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="font-medium text-background truncate max-w-[150px]" title={meta?.fullQuestion || label}>
                    {label}
                  </span>
                </div>
                <span className="font-bold text-background shrink-0">{Math.round(value * 100)}%</span>
              </div>
              {dueStatus ? (
                <div className="text-[10px] text-background/75 pl-5">
                  {dueStatus}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ForgettingCurveChart(props: {
  cards: CardRecord[];
  states: Record<string, CardState>;
  reviewLog?: ReviewLogEntry[];
  scheduler?: SchedulerSettings | null;
  nowMs: number;
  enableAnimations?: boolean;
  locale?: string;
}) {
  const tx = React.useMemo(() => (token: string, fallback: string, vars?: Record<string, string | number>) => t(props.locale, token, fallback, vars), [props.locale]);
  const intlLocale = React.useMemo(() => interfaceLocaleToIntlLocale(props.locale), [props.locale]);
  const [search, setSearch] = React.useState<SearchState>(() => createEmptySearch());
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const seededRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  useAnalyticsPopoverZIndex(open, wrapRef);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    activeDocument.addEventListener("mousedown", onDocClick, true);
    return () => activeDocument.removeEventListener("mousedown", onDocClick, true);
  }, [open]);

  React.useEffect(() => {
    if (!open) return undefined;
    const popover = popoverRef.current;
    if (!popover) return undefined;
    popover.classList.add("learnkit-ana-popover", "learnkit-ana-popover", "learnkit-ana-popover-right", "learnkit-ana-popover-right", "learnkit-ana-popover-md", "learnkit-ana-popover-md");
    return undefined;
  }, [open]);


  const cardById = React.useMemo(() => {
    const map = new Map<string, CardRecord>();
    for (const card of props.cards ?? []) {
      if (!card) continue;
      map.set(String(card.id), card);
    }
    return map;
  }, [props.cards]);

  const reviewLog = React.useMemo(() => props.reviewLog ?? [], [props.reviewLog]);

  React.useEffect(() => {
    if (seededRef.current) return;
    if (!reviewLog.length) return;
    if (selectedIds.length) return;

    const lastById = new Map<string, number>();
    for (const entry of reviewLog) {
      if (!entry || !entry.at) continue;
      const id = String(entry.id ?? "");
      if (!id) continue;
      const at = Number(entry.at);
      if (!Number.isFinite(at)) continue;
      const prev = lastById.get(id) ?? 0;
      if (at > prev) lastById.set(id, at);
    }

    const top = Array.from(lastById.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SELECTIONS)
      .map(([id]) => id)
      .filter((id) => cardById.has(id));

    if (top.length) {
      setSelectedIds(top);
      seededRef.current = true;
    }
  }, [reviewLog, selectedIds.length, cardById]);

  const applyPreset = React.useCallback(
    (preset: "recent" | "hardest" | "dueSoon") => {
      setSearch((prev) => ({ ...prev, error: null }));
      if (preset === "recent") {
        const lastById = new Map<string, number>();
        for (const entry of reviewLog) {
          if (!entry || !entry.at) continue;
          const id = String(entry.id ?? "");
          if (!id) continue;
          const at = Number(entry.at);
          if (!Number.isFinite(at)) continue;
          const prev = lastById.get(id) ?? 0;
          if (at > prev) lastById.set(id, at);
        }
        const top = Array.from(lastById.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_SELECTIONS)
          .map(([id]) => id)
          .filter((id) => cardById.has(id));
        if (top.length) setSelectedIds(top);
      } else if (preset === "hardest") {
        const candidates: Array<{ id: string; stability: number; lapses: number }> = [];
        for (const [id] of cardById.entries()) {
          const state = props.states?.[id];
          if (!state || state.stage === "new") continue;
          const stab = getCardStability(state);
          if (stab > 0) {
            candidates.push({ id, stability: stab, lapses: state.lapses ?? 0 });
          }
        }
        const top = candidates
          .sort((a, b) => {
            if (a.stability !== b.stability) return a.stability - b.stability;
            return b.lapses - a.lapses;
          })
          .slice(0, MAX_SELECTIONS)
          .map((c) => c.id);
        if (top.length) setSelectedIds(top);
      } else if (preset === "dueSoon") {
        const candidates: Array<{ id: string; diffMs: number }> = [];
        for (const [id] of cardById.entries()) {
          const state = props.states?.[id];
          if (!state || state.stage === "new" || !state.due) continue;
          candidates.push({ id, diffMs: state.due - props.nowMs });
        }
        const top = candidates
          .sort((a, b) => a.diffMs - b.diffMs)
          .slice(0, MAX_SELECTIONS)
          .map((c) => c.id);
        if (top.length) setSelectedIds(top);
      }
    },
    [reviewLog, cardById, props.states, props.nowMs],
  );

  const searchIndex = React.useMemo(() => {
    const PARENT_TYPES = new Set(["cloze", "reversed", "io", "io-parent", "io_parent", "ioparent"]);
    return (props.cards ?? [])
      .filter((card) => !PARENT_TYPES.has(String(card?.type ?? "").toLowerCase()))
      .map((card) => {
      const id = String(card.id);
      const label = getCardDisplayLabel(card, id, 30);
      const idDigits = extractNineDigitId(id) ?? "";
      const title = String(card.title ?? "").trim();
      const location = formatLocation(card.sourceNotePath);
      const preview = getQuestionPreview(card);
      const combined = normalizeSearchText([id, idDigits, title, location, preview, label].join(" "));
      return { card, id, label, idDigits, title, location, preview, combined };
    });
  }, [props.cards]);

  const getSearchResults = React.useCallback(
    (query: string) => {
      const q = normalizeSearchText(query);
      if (!q) return [] as SearchResult[];

      const results: SearchResult[] = [];
      for (const entry of searchIndex) {
        let score = 99;
        const idMatch = entry.idDigits && entry.idDigits === q;
        const idIncludes = entry.idDigits && entry.idDigits.includes(q);
        const titleNorm = normalizeSearchText(entry.title);
        const previewNorm = normalizeSearchText(entry.preview);
        const locationNorm = normalizeSearchText(entry.location);

        if (entry.id === q || idMatch) score = 0;
        else if (idIncludes || entry.id.includes(q)) score = 1;
        else if (titleNorm.startsWith(q)) score = 2;
        else if (titleNorm.includes(q)) score = 3;
        else if (previewNorm.includes(q)) score = 4;
        else if (locationNorm.includes(q)) score = 5;
        else if (entry.combined.includes(q)) score = 6;
        else continue;

        results.push({
          id: entry.id,
          label: entry.label,
          location: entry.location,
          title: entry.title,
          preview: entry.preview,
          score,
        });
      }

      return results
        .sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          return a.label.localeCompare(b.label);
        })
        .slice(0, 5);
    },
    [searchIndex],
  );

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= MAX_SELECTIONS) {
        setSearch((cur) => ({ ...cur, error: `Select up to ${MAX_SELECTIONS} cards.` }));
        return prev;
      }
      return [...prev, id];
    });
  };

  const searchIndexById = React.useMemo(() => {
    const map = new Map<string, (typeof searchIndex)[number]>();
    searchIndex.forEach((entry) => map.set(entry.id, entry));
    return map;
  }, [searchIndex]);

  const selectedResults = React.useMemo(() => {
    const uniq = Array.from(new Set(selectedIds));
    return uniq.map((id) => {
      const entry = searchIndexById.get(id);
      const card = cardById.get(id);
      return {
        id,
        label: entry?.label ?? getCardDisplayLabel(card, id, 30),
        location: entry?.location ?? formatLocation(card?.sourceNotePath),
        preview: entry?.preview ?? (card ? getQuestionPreview(card) : "No question text."),
      };
    });
  }, [selectedIds, searchIndexById, cardById]);

  const resetFilters = () => {
    setSearch(createEmptySearch());
    setSelectedIds([]);
  };

  const params = React.useMemo(() => buildFsrsParams(props.scheduler), [props.scheduler]);
  const schedulerCfg = React.useMemo(() => props.scheduler ?? DEFAULT_SCHEDULER, [props.scheduler]);
  const requestRetention = React.useMemo(
    () => clamp(Number(schedulerCfg.requestRetention) || 0.9, 0.8, 0.97),
    [schedulerCfg.requestRetention],
  );

  const { rawCurves, issues, baseStart } = React.useMemo(() => {
    const curveList: CurveMeta[] = [];
    const issueList: CurveIssue[] = [];
    let minFirstReview = Number.POSITIVE_INFINITY;

    selectedIds.forEach((id, index) => {
      const card = cardById.get(id);
      const cardReviews = reviewLog.filter((entry) => String(entry.id) === id);
      const pastReviews = cardReviews.filter((entry) => Number(entry.at) <= props.nowMs);
      const timeline = buildStabilityTimeline(id, pastReviews, schedulerCfg);

      if (!card) {
        issueList.push({ id, reason: tx("ui.analytics.forgettingCurve.issue.cardNotFound", "Card not found") });
        return;
      }

      if (!timeline.length) {
        issueList.push({ id, reason: tx("ui.analytics.forgettingCurve.issue.notStudiedYet", "Not studied yet") });
        return;
      }

      const firstReviewAt = timeline[0]?.at ?? 0;
      const lastReviewAt = timeline[timeline.length - 1]?.at ?? firstReviewAt;
      const elapsedSinceFirst = Math.max(0, (props.nowMs - firstReviewAt) / MS_DAY);
      const horizon = Math.max(1, Math.ceil(elapsedSinceFirst * 2));
      if (Number.isFinite(firstReviewAt) && firstReviewAt > 0) {
        minFirstReview = Math.min(minFirstReview, firstReviewAt);
      }

      const stability = timeline[timeline.length - 1]?.stability ?? 0;
      if (!Number.isFinite(stability) || stability <= 0) {
        issueList.push({ id, reason: tx("ui.analytics.forgettingCurve.issue.notStudiedYet", "Not studied yet") });
        return;
      }

      const elapsedSinceLast = Math.max(0, (props.nowMs - lastReviewAt) / MS_DAY);
      const currentRetrievability = forgetting_curve(params.w, elapsedSinceLast, stability);

      const cardState = props.states?.[id];
      let dueStatus: string | null = null;
      if (cardState && Number.isFinite(cardState.due) && cardState.due > 0) {
        const msUntilDue = cardState.due - props.nowMs;
        const daysDiff = Math.round(msUntilDue / MS_DAY);
        if (daysDiff < 0) {
          dueStatus = tx("ui.analytics.forgettingCurve.overdue", `Overdue (${Math.abs(daysDiff)}d)`, { days: String(Math.abs(daysDiff)) });
        } else if (daysDiff === 0) {
          dueStatus = tx("ui.analytics.forgettingCurve.dueToday", "Due today");
        } else {
          dueStatus = tx("ui.analytics.forgettingCurve.dueIn", `Due in ${daysDiff}d`, { days: String(daysDiff) });
        }
      }

      const fullQuestion = getQuestionPreview(card, 120);
      const displayLabel = getCardDisplayLabel(card, id, 24);
      const location = formatLocation(card.sourceNotePath);

      curveList.push({
        id,
        label: displayLabel,
        fullQuestion,
        color: LINE_COLORS[index % LINE_COLORS.length],
        strokeDasharray: LINE_PATTERNS[index % LINE_PATTERNS.length],
        stabilityDays: stability,
        lastReviewAt,
        firstReviewAt,
        horizon,
        timeline,
        title: card.title ?? null,
        location,
        elapsedDays: elapsedSinceLast,
        currentRetrievability,
        dueStatus,
      });
    });

    const base = Number.isFinite(minFirstReview) && minFirstReview > 0 ? minFirstReview : props.nowMs;
    return { rawCurves: curveList, issues: issueList, baseStart: base };
  }, [selectedIds, cardById, reviewLog, schedulerCfg, props.nowMs, props.states, params.w, tx]);

  const elapsedDays = React.useMemo(
    () => Math.max(14, Math.ceil((props.nowMs - baseStart) / MS_DAY)),
    [props.nowMs, baseStart],
  );
  const maxDays = React.useMemo(() => elapsedDays * 2, [elapsedDays]);
  const todayDay = React.useMemo(
    () => Math.round((props.nowMs - baseStart) / MS_DAY),
    [props.nowMs, baseStart],
  );

  const curves = React.useMemo(() => {
    return rawCurves.map((curve) => {
      const { lastReviewAt, stabilityDays } = curve;
      let dueDay: number | null = null;
      for (let day = 0; day <= maxDays; day += 1) {
        const absoluteTs = baseStart + day * MS_DAY;
        if (absoluteTs < lastReviewAt) continue;
        const elapsed = Math.max(0, (absoluteTs - lastReviewAt) / MS_DAY);
        const r = forgetting_curve(params.w, elapsed, stabilityDays);
        if (r <= requestRetention) {
          dueDay = day;
          break;
        }
      }

      let dueStatus = curve.dueStatus;
      if (!dueStatus && dueDay !== null) {
        const diff = dueDay - todayDay;
        if (diff < 0) {
          dueStatus = tx("ui.analytics.forgettingCurve.overdue", `Overdue (${Math.abs(diff)}d)`, { days: String(Math.abs(diff)) });
        } else if (diff === 0) {
          dueStatus = tx("ui.analytics.forgettingCurve.dueToday", "Due today");
        } else {
          dueStatus = tx("ui.analytics.forgettingCurve.dueIn", `Due in ${diff}d`, { days: String(diff) });
        }
      }

      return { ...curve, dueDay, dueStatus };
    });
  }, [rawCurves, baseStart, maxDays, params.w, requestRetention, todayDay, tx]);

  const curveMetaMap = React.useMemo(() => {
    const map = new Map<string, CurveMeta>();
    for (const c of curves) {
      map.set(c.id, c);
    }
    return map;
  }, [curves]);

  const data = React.useMemo(() => {
    if (!curves.length) return [] as DataRow[];
    const rows: DataRow[] = [];
    for (let day = 0; day <= maxDays; day += 1) {
      const row: DataRow = { day };
      for (const curve of curves) {
        const { firstReviewAt, timeline } = curve;
        if (!Number.isFinite(firstReviewAt) || !timeline.length) {
          row[curve.id] = 0;
          continue;
        }
        const absoluteTs = baseStart + day * MS_DAY;
        if (absoluteTs < firstReviewAt) {
          row[curve.id] = null;
          continue;
        }
        let active = timeline[0];
        for (let i = 0; i < timeline.length; i += 1) {
          if (timeline[i].at <= absoluteTs) active = timeline[i];
          else break;
        }
        const elapsed = Math.max(0, (absoluteTs - active.at) / MS_DAY);
        row[curve.id] = forgetting_curve(params.w, elapsed, active.stability);
      }
      rows.push(row);
    }
    return rows;
  }, [curves, params.w, baseStart, maxDays]);

  const tickFormatter = (value: number) => {
    const ts = baseStart + Number(value) * MS_DAY;
    return new Date(ts).toLocaleDateString(intlLocale, { month: "short", day: "numeric" });
  };
  const yTickFormatter = (value: number) => `${Math.round(Number(value) * 100)}%`;

  const legendItems = React.useMemo(() => {
    const items: Array<{
      id: string;
      label: string;
      color: string;
      strokeDasharray?: string;
      tooltip?: string;
      status?: string;
    }> = [];
    const curveIds = new Set<string>();
    for (const curve of curves) {
      curveIds.add(curve.id);
      const card = cardById.get(curve.id);
      const title = curve.title ? String(curve.title) : "";
      const question = curve.fullQuestion || (card ? getQuestionPreview(card, 80) : "");
      const loc = curve.location ? `(${curve.location})` : "";
      const idFormatted = formatCardLabel(curve.id);
      const tooltip = [title, question, loc, `#${idFormatted}`].filter(Boolean).join(" · ");
      items.push({
        id: curve.id,
        label: curve.label,
        color: curve.color,
        strokeDasharray: curve.strokeDasharray,
        tooltip,
      });
    }
    for (const issue of issues) {
      if (curveIds.has(issue.id)) continue;
      const card = cardById.get(issue.id);
      const title = card ? String(card.title ?? "") : "";
      const question = card ? getQuestionPreview(card, 80) : "";
      const idFormatted = formatCardLabel(issue.id);
      const tooltip = [title, question, `#${idFormatted}`].filter(Boolean).join(" · ");
      items.push({
        id: issue.id,
        label: getCardDisplayLabel(card, issue.id, 24),
        color: "var(--destructive)",
        strokeDasharray: undefined,
        tooltip,
        status: issue.reason,
      });
    }
    return items;
  }, [curves, issues, cardById]);

  const legendContent = () => {
    if (!legendItems.length) return null;
    return (
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground learnkit-ana-chart-legend pt-1">
        {legendItems.map((item) => (
          <div key={item.id} className="inline-flex items-center gap-1.5 max-w-[240px]">
            <svg width="18" height="6" className="shrink-0" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke={item.color}
                strokeWidth="2.5"
                strokeDasharray={item.strokeDasharray}
                strokeLinecap="round"
              />
            </svg>
            <span className="truncate" data-tooltip={item.tooltip || undefined}>
              {item.label}
            </span>
            {item.status ? <span className="text-muted-foreground shrink-0">({item.status})</span> : null}
          </div>
        ))}
        {curves.length > 0 && (
          <div className="inline-flex items-center gap-1.5 shrink-0 text-muted-foreground/80">
            <svg width="18" height="6" className="shrink-0" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke="var(--chart-accent-4, #eab308)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                strokeLinecap="round"
              />
            </svg>
            <span className="text-[11px]">
              {tx("ui.analytics.forgettingCurve.targetRetention", `Target (${Math.round(requestRetention * 100)}%)`, {
                retention: String(Math.round(requestRetention * 100)),
              })}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="card learnkit-ana-card learnkit-forgetting-curve-card h-full overflow-visible p-4 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1">
            <div className="font-semibold lk-home-section-title">{tx("ui.analytics.forgettingCurve.title", "Forgetting curve")}</div>
            <InfoIcon text={tx("ui.analytics.forgettingCurve.info", "Estimated recall probability over time for the selected cards based on review history.")} />
          </div>
          <div className="text-xs text-muted-foreground">{tx("ui.analytics.forgettingCurve.subtitle", "Recall probability over time")}</div>
        </div>

        <div
          ref={wrapRef}
          className="relative inline-flex"
          style={{ zIndex: open ? "var(--lk-z-analytics-popover)" : undefined }}
        >
          <button
            type="button"
            className="learnkit-btn-toolbar learnkit-btn-filter h-7 px-2 text-sm inline-flex items-center gap-2 cursor-pointer"
            aria-haspopup="listbox"
            aria-expanded={open ? "true" : "false"}
            onClick={() => setOpen((prev) => !prev)}
          >
            <svg
              className="svg-icon lucide-filter text-foreground"
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3" />
            </svg>
            <span>{tx("ui.analytics.forgettingCurve.filter", "Filter")}</span>
          </button>

          {open ? (
            <div
              aria-hidden="false"
              ref={popoverRef}
              className="rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-0 flex flex-col learnkit-ana-popover learnkit-ana-popover-right learnkit-ana-popover-md"
            >
              <div className="p-1">
                <div className="px-2 pt-1 pb-2">
                  <div className="text-xs font-medium text-muted-foreground pb-1.5">{tx("ui.analytics.forgettingCurve.presets", "Presets")}</div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      className="learnkit-btn-pill text-xs px-2 py-0.5 rounded border border-border hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                      onClick={() => applyPreset("recent")}
                    >
                      {tx("ui.analytics.forgettingCurve.preset.recent", "Recent")}
                    </button>
                    <button
                      type="button"
                      className="learnkit-btn-pill text-xs px-2 py-0.5 rounded border border-border hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                      onClick={() => applyPreset("hardest")}
                    >
                      {tx("ui.analytics.forgettingCurve.preset.hardest", "Hardest")}
                    </button>
                    <button
                      type="button"
                      className="learnkit-btn-pill text-xs px-2 py-0.5 rounded border border-border hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                      onClick={() => applyPreset("dueSoon")}
                    >
                      {tx("ui.analytics.forgettingCurve.preset.dueSoon", "Due Soon")}
                    </button>
                  </div>
                </div>

                <div className="h-px bg-border my-1" role="separator" />

                <div className="text-sm text-muted-foreground px-2 py-1">{tx("ui.analytics.forgettingCurve.searchCards", "Search cards")}</div>
                <div className="px-2 pb-2">
                  <input
                    className="input w-full text-sm"
                    type="text"
                    placeholder={tx("ui.analytics.forgettingCurve.searchInputPlaceholder", "Search by ID, title, question")}
                    value={search.query}
                    onChange={(event) => {
                      setSearch({ query: event.currentTarget.value, error: null });
                    }}
                  />
                </div>

                {search.error ? <div className="text-xs text-muted-foreground px-2 pb-2">{search.error}</div> : null}

                {selectedResults.length ? (
                  <div className="px-2 pb-2">
                    <div className="text-xs text-muted-foreground px-2 pb-1">{tx("ui.analytics.forgettingCurve.selectedCards", "Selected cards")}</div>
                    <div className="flex flex-col">
                      {selectedResults.map((result) => (
                        <div
                          key={`selected-${result.id}`}
                          role="menuitemradio"
                          aria-checked="true"
                          tabIndex={0}
                          className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer select-none outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground min-w-0"
                          onClick={() => toggleSelection(result.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              toggleSelection(result.id);
                            }
                          }}
                        >
                          <span className="size-3 rounded-full border border-muted-foreground/40 flex items-center justify-center shrink-0">
                            <span className="size-1.5 rounded-full bg-foreground" />
                          </span>
                          <div className="flex flex-col min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span
                                className="truncate learnkit-ana-truncate-row"
                              >
                                {result.location}
                              </span>
                              <span className="shrink-0 text-[11px] opacity-70">#{formatCardLabel(result.id)}</span>
                            </div>
                            <div
                              className="truncate learnkit-ana-truncate font-medium text-xs"
                            >
                              {result.label}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {search.query.trim().length ? (
                  <div className="px-2 pb-2">
                    {(() => {
                      const selectedSet = new Set(selectedIds);
                      const results = getSearchResults(search.query).filter((result) => !selectedSet.has(result.id));
                      return results.length ? (
                        <div className="flex flex-col">
                          {results.map((result) => {
                            const disabled = selectedIds.length >= MAX_SELECTIONS;
                            return (
                              <div
                                key={result.id}
                                role="menuitemradio"
                                aria-checked="false"
                                tabIndex={0}
                                className={
                                  `bc group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer select-none outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground min-w-0${disabled ? " is-disabled" : ""}`
                                }
                                onClick={() => {
                                  if (disabled) return;
                                  toggleSelection(result.id);
                                }}
                                onKeyDown={(event) => {
                                  if (disabled) return;
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    toggleSelection(result.id);
                                  }
                                }}
                              >
                                <span className="size-3 rounded-full border border-muted-foreground/40 flex items-center justify-center shrink-0" />
                                <div className="flex flex-col min-w-0 flex-1">
                                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                    <span
                                      className="truncate learnkit-ana-truncate-row"
                                    >
                                      {result.location || tx("ui.analytics.forgettingCurve.unknownLocation", "Unknown location")}
                                    </span>
                                    <span className="shrink-0 text-[11px] opacity-70">#{formatCardLabel(result.id)}</span>
                                  </div>
                                  <div
                                    className="truncate learnkit-ana-truncate font-medium text-xs"
                                  >
                                    {result.label}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">{tx("ui.analytics.forgettingCurve.noMatches", "No matches.")}</div>
                      );
                    })()}
                  </div>
                ) : null}

                <div className="h-px bg-border my-1" role="separator" />
                <div className="text-sm text-muted-foreground cursor-pointer px-2 py-1 hover:text-foreground transition-colors" onClick={resetFilters}>
                  {tx("ui.analytics.forgettingCurve.resetFilters", "Reset filters")}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {curves.length ? (
        <div className="learnkit-analytics-chart">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data} margin={{ top: 28, right: 12, left: 16, bottom: 0 }}>
              <XAxis
                dataKey="day"
                ticks={[0, maxDays / 2, maxDays]}
                tickFormatter={tickFormatter}
                tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={{ stroke: "var(--border)" }}
                label={{ value: "", position: "insideBottomRight", offset: -6 }}
              />
              <YAxis
                domain={[0, 1]}
                ticks={[0, 0.5, 1]}
                tickFormatter={yTickFormatter}
                tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={{ stroke: "var(--border)" }}
              />
              <Tooltip
                content={
                  <CardCurveTooltip
                    baseStart={baseStart}
                    locale={intlLocale}
                    curveMetaMap={curveMetaMap}
                    requestRetention={requestRetention}
                    tx={tx}
                  />
                }
                isAnimationActive={false}
              />
              {todayDay / maxDays > 0.1 && (
                <ReferenceLine
                  x={todayDay}
                  stroke="var(--border)"
                  strokeDasharray="4 4"
                  label={{ value: tx("ui.view.coach.readiness.today", "Today"), position: "top", fill: "var(--text-muted)", fontSize: 11 }}
                />
              )}
              <ReferenceLine
                y={requestRetention}
                stroke="var(--chart-accent-4, #eab308)"
                strokeDasharray="3 3"
                strokeWidth={1.5}
                label={{
                  value: tx("ui.analytics.forgettingCurve.targetRetention", `Target (${Math.round(requestRetention * 100)}%)`, {
                    retention: String(Math.round(requestRetention * 100)),
                  }),
                  position: "insideTopRight",
                  fill: "var(--text-muted)",
                  fontSize: 10,
                }}
              />
              {curves.map((curve) => {
                if (curve.dueDay === null || curve.dueDay === undefined || curve.dueDay < 0 || curve.dueDay > maxDays) return null;
                return (
                  <ReferenceDot
                    key={`due-dot-${curve.id}`}
                    x={curve.dueDay}
                    y={requestRetention}
                    r={4}
                    fill={curve.color}
                    stroke="var(--background)"
                    strokeWidth={1.5}
                  />
                );
              })}
              {curves.map((curve) => (
                <Line
                  key={curve.id}
                  type="monotone"
                  dataKey={curve.id}
                  name={curve.label}
                  stroke={curve.color}
                  strokeDasharray={curve.strokeDasharray}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={props.enableAnimations ?? true}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {selectedIds.length ? tx("ui.analytics.forgettingCurve.notStudied", "Selected cards have not been studied yet.") : tx("ui.analytics.forgettingCurve.searchPlaceholder", "Search for cards to plot forgetting curves.")}
        </div>
      )}

      <div className="learnkit-ana-scroll-48">
        {legendContent()}
      </div>

    </div>
  );
}

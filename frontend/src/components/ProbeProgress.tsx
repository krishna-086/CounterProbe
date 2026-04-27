"use client";

/**
 * ProbeProgress — Step 3 of the audit flow.
 *
 * Three internal phases:
 *   "ready"    — show baseline recap + base-profile slider + Run button.
 *   "probing"  — SSE connected; render progress bar + 3 live counters.
 *                Includes a "preparing" sub-state for the slow Gemini
 *                variant-generation phase before the first probe lands
 *                (the backend can sit silent for 30+s otherwise).
 *   "complete" — final summary + auto-fired CVE grading + advance button.
 *
 * Anomaly counter pulses red whenever it increments — the demo moment.
 *
 * The component owns probe + CVE fetches and emits a single onComplete
 * callback once the user clicks "View vulnerability report" (and CVE
 * grading has resolved). The parent then transitions to step 4 with all
 * the data already in hand.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Play,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ApiError, gradeCVEs, runProbes } from "@/lib/api";
import type {
  CVEEntry,
  ProbeProgress as ProbeProgressEvent,
  ProbeResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import type { BaselineConfirmedPayload } from "./BaselineConfig";

type Phase = "ready" | "probing" | "complete" | "error";

export interface ProbeStepCompletePayload {
  results: ProbeResult[];
  summary: ProbeProgressEvent;
  cves: CVEEntry[];
}

interface ProbeProgressProps {
  sessionId: string;
  baseline: BaselineConfirmedPayload;
  onComplete: (payload: ProbeStepCompletePayload) => void;
}

const MIN_BASE = 10;
const MAX_BASE = 100;
const DEFAULT_BASE = 50;

export function ProbeProgress({
  sessionId,
  baseline,
  onComplete,
}: ProbeProgressProps) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [numBaseProfiles, setNumBaseProfiles] = useState(DEFAULT_BASE);

  const [progress, setProgress] = useState<ProbeProgressEvent | null>(null);
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [summary, setSummary] = useState<ProbeProgressEvent | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [cves, setCves] = useState<CVEEntry[] | null>(null);
  const [gradingError, setGradingError] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);

  const [advancing, setAdvancing] = useState(false);
  const [pulse, setPulse] = useState(false);
  const previousAnomalies = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Pulse the anomaly card whenever the running count goes up.
  useEffect(() => {
    const current = progress?.anomalies_found ?? 0;
    if (current > previousAnomalies.current) {
      setPulse(true);
      const handle = window.setTimeout(() => setPulse(false), 700);
      previousAnomalies.current = current;
      return () => window.clearTimeout(handle);
    }
    previousAnomalies.current = current;
  }, [progress?.anomalies_found]);

  // Abort an in-flight stream if the component unmounts (user clicked back).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function startProbes() {
    setPhase("probing");
    setStreamError(null);
    setGradingError(null);
    setResults([]);
    setSummary(null);
    setCves(null);
    setProgress(null);
    previousAnomalies.current = 0;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await runProbes(
        { session_id: sessionId, num_base_profiles: numBaseProfiles },
        {
          signal: controller.signal,
          onProgress: setProgress,
          onComplete: ({ results, summary }) => {
            setResults(results);
            setSummary(summary);
            setProgress(summary);
            setPhase("complete");
            // Kick off CVE grading immediately so it's already loading
            // while the user reads the summary.
            void runGrading();
          },
          onError: (detail) => {
            setStreamError(detail);
            setPhase("error");
          },
        },
      );
    } catch (e) {
      if (controller.signal.aborted) return; // Intentional cancel.
      setStreamError(
        e instanceof ApiError ? e.message : "Probe stream failed unexpectedly.",
      );
      setPhase("error");
    }
  }

  async function runGrading() {
    setGrading(true);
    setGradingError(null);
    try {
      const list = await gradeCVEs(sessionId);
      setCves(list);
    } catch (e) {
      setGradingError(
        e instanceof ApiError ? e.message : "Failed to grade CVEs.",
      );
    } finally {
      setGrading(false);
    }
  }

  async function handleAdvance() {
    if (!summary) return;
    setAdvancing(true);
    let payloadCves = cves;
    if (!payloadCves) {
      try {
        payloadCves = await gradeCVEs(sessionId);
        setCves(payloadCves);
      } catch (e) {
        setGradingError(
          e instanceof ApiError ? e.message : "Failed to grade CVEs.",
        );
        setAdvancing(false);
        return;
      }
    }
    onComplete({ results, summary, cves: payloadCves });
  }

  return (
    <div className="space-y-6">
      <BaselineRecap
        baseline={baseline}
        numProfiles={numBaseProfiles}
        phase={phase}
      />

      {phase === "ready" ? (
        <ReadyState
          numBaseProfiles={numBaseProfiles}
          setNumBaseProfiles={setNumBaseProfiles}
          onStart={startProbes}
        />
      ) : null}

      {phase === "probing" || phase === "complete" || phase === "error" ? (
        <RunningState
          phase={phase}
          progress={progress}
          summary={summary}
          pulse={pulse}
        />
      ) : null}

      {phase === "complete" && summary ? (
        <CompleteState
          summary={summary}
          cves={cves}
          grading={grading}
          gradingError={gradingError}
          advancing={advancing}
          onAdvance={handleAdvance}
          onRegrade={runGrading}
        />
      ) : null}

      {phase === "error" && streamError ? (
        <ErrorState message={streamError} onRetry={startProbes} />
      ) : null}
    </div>
  );
}

// ---------- Sections --------------------------------------------------------

function BaselineRecap({
  baseline,
  numProfiles,
  phase,
}: {
  baseline: BaselineConfirmedPayload;
  numProfiles: number;
  phase: Phase;
}) {
  return (
    <Card className="border-white/5 bg-card">
      <CardHeader>
        <CardTitle className="text-xl font-semibold text-zinc-100">
          Run counterfactual probes
        </CardTitle>
        <CardDescription className="text-zinc-400">
          CounterProbe samples real rows from your dataset, asks Gemini for
          realistic counterfactual variants that change ONLY protected
          attributes, then fires both through your model. Decision flips are
          anomalies.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-3">
          <RecapBlock
            accent="emerald"
            label="Legitimate"
            items={baseline.legitimate_factors}
          />
          <RecapBlock
            accent="rose"
            label="Protected"
            items={baseline.protected_attributes}
          />
          <RecapBlock
            accent="indigo"
            label="Target"
            items={[baseline.target_column]}
            footer={`${numProfiles} base profiles · ${
              phase === "ready" ? "ready" : phase
            }`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function RecapBlock({
  accent,
  label,
  items,
  footer,
}: {
  accent: "emerald" | "rose" | "indigo";
  label: string;
  items: string[];
  footer?: string;
}) {
  const accentBorder =
    accent === "emerald"
      ? "border-emerald-400/20"
      : accent === "rose"
        ? "border-rose-400/20"
        : "border-indigo-400/20";
  const dot =
    accent === "emerald"
      ? "bg-emerald-400"
      : accent === "rose"
        ? "bg-rose-400"
        : "bg-indigo-400";

  return (
    <div
      className={cn(
        "rounded-md border bg-white/[0.02] p-4",
        accentBorder,
      )}
    >
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        <span className={cn("h-2 w-2 rounded-full", dot)} />
        {label}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {items.map((name) => (
          <span
            key={name}
            className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[12px] font-medium text-zinc-200"
          >
            {name}
          </span>
        ))}
      </div>
      {footer ? (
        <p className="mt-3 text-xs text-zinc-500">{footer}</p>
      ) : null}
    </div>
  );
}

function ReadyState({
  numBaseProfiles,
  setNumBaseProfiles,
  onStart,
}: {
  numBaseProfiles: number;
  setNumBaseProfiles: (n: number) => void;
  onStart: () => void;
}) {
  return (
    <Card className="border-white/5 bg-card">
      <CardHeader>
        <CardTitle className="text-base font-semibold text-zinc-100">
          Ready to fire
        </CardTitle>
        <CardDescription className="text-zinc-400">
          Each base profile spawns ~8 counterfactual variants. More profiles
          means a stronger signal but a longer wait — Gemini calls dominate
          the runtime.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="space-y-1.5">
            <Label
              htmlFor="num-bases"
              className="text-xs font-semibold uppercase tracking-wider text-zinc-500"
            >
              Number of base profiles
            </Label>
            <Input
              id="num-bases"
              type="number"
              min={MIN_BASE}
              max={MAX_BASE}
              value={numBaseProfiles}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10);
                if (Number.isNaN(next)) return;
                setNumBaseProfiles(
                  Math.max(MIN_BASE, Math.min(MAX_BASE, next)),
                );
              }}
              className="w-32 border-white/10 bg-white/5 font-mono text-zinc-100 focus-visible:border-[#6366F1] focus-visible:ring-0"
            />
            <p className="text-xs text-zinc-500">
              {MIN_BASE} – {MAX_BASE}. Default {DEFAULT_BASE}.
            </p>
          </div>
          <div className="flex-1" />
          <Button
            size="lg"
            onClick={onStart}
            className="bg-[#6366F1] font-semibold text-white shadow-lg shadow-[#6366F1]/20 hover:bg-[#6366F1]/90"
          >
            <Play className="mr-2 h-4 w-4" />
            Run fairness probes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RunningState({
  phase,
  progress,
  summary,
  pulse,
}: {
  phase: Phase;
  progress: ProbeProgressEvent | null;
  summary: ProbeProgressEvent | null;
  pulse: boolean;
}) {
  const total = summary?.total_probes ?? progress?.total_probes ?? 0;
  const completed = summary?.probes_completed ?? progress?.probes_completed ?? 0;
  const anomalies = summary?.anomalies_found ?? progress?.anomalies_found ?? 0;
  const failure = summary?.failure_rate ?? progress?.failure_rate ?? 0;
  const knowsTotal = total > 0;
  const pct = knowsTotal ? Math.round((completed / total) * 100) : 0;
  const isProbing = phase === "probing";

  return (
    <Card
      className={cn(
        "border-white/5 bg-card transition-shadow",
        isProbing && "shadow-[0_0_60px_-30px_rgba(99,102,241,0.6)]",
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold text-zinc-100">
            {phase === "complete"
              ? "Probe sweep complete"
              : knowsTotal
                ? "Probing in progress"
                : "Generating counterfactual variants…"}
          </CardTitle>
          {phase === "probing" ? (
            <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#6366F1]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              live
            </span>
          ) : phase === "complete" ? (
            <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              done
            </span>
          ) : null}
        </div>
        <CardDescription className="text-zinc-400">
          {knowsTotal
            ? `${completed.toLocaleString()} of ${total.toLocaleString()} probe pairs evaluated.`
            : "Asking Gemini for counterfactuals — first probes will land in ~20-40s."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {knowsTotal ? (
          <Progress
            value={pct}
            className="h-2 bg-white/5 [&>div]:bg-[#6366F1] [&>div]:transition-all"
          />
        ) : (
          <div className="h-2 overflow-hidden rounded-full bg-white/5">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-[#6366F1]/60" />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <CounterCard
            icon={<Sparkles className="h-4 w-4" />}
            label="Probes completed"
            value={knowsTotal ? `${completed} / ${total}` : "—"}
            tone="indigo"
          />
          <CounterCard
            icon={<Zap className="h-4 w-4" />}
            label="Anomalies found"
            value={String(anomalies)}
            tone="rose"
            highlight={pulse}
          />
          <CounterCard
            icon={<Shield className="h-4 w-4" />}
            label="Failure rate"
            value={knowsTotal ? `${(failure * 100).toFixed(1)}%` : "—"}
            tone={failureTone(failure)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function CompleteState({
  summary,
  cves,
  grading,
  gradingError,
  advancing,
  onAdvance,
  onRegrade,
}: {
  summary: ProbeProgressEvent;
  cves: CVEEntry[] | null;
  grading: boolean;
  gradingError: string | null;
  advancing: boolean;
  onAdvance: () => void;
  onRegrade: () => void;
}) {
  const tone = failureTone(summary.failure_rate);
  const headline =
    summary.anomalies_found === 0
      ? "Model held up — no decision flips on this run."
      : `${summary.anomalies_found} of ${summary.total_probes} probe pairs flipped the model's decision.`;

  return (
    <Card className="border-white/5 bg-card">
      <CardContent className="space-y-5 pt-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Summary
          </p>
          <p className="text-2xl font-semibold tracking-tight text-zinc-100">
            {headline}
          </p>
          <p className="font-mono text-sm text-zinc-400">
            failure rate{" "}
            <span className={cn("font-semibold", toneTextClass(tone))}>
              {(summary.failure_rate * 100).toFixed(1)}%
            </span>{" "}
            · {summary.anomalies_found} anomalies / {summary.total_probes}{" "}
            probes
          </p>
        </div>

        <Separator className="bg-white/5" />

        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-zinc-400">
            {grading ? (
              <span className="flex items-center gap-2 font-mono text-zinc-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#6366F1]" />
                Grading vulnerabilities with Gemini…
              </span>
            ) : gradingError ? (
              <span className="flex items-center gap-2 text-rose-300">
                <AlertCircle className="h-3.5 w-3.5" />
                {gradingError}
                <button
                  type="button"
                  onClick={onRegrade}
                  className="ml-2 underline underline-offset-2 hover:text-rose-200"
                >
                  retry
                </button>
              </span>
            ) : cves ? (
              <span className="flex items-center gap-2 font-mono text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {cves.length} CVE entries ready.
              </span>
            ) : null}
          </div>
          <Button
            size="lg"
            onClick={onAdvance}
            disabled={advancing}
            className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
          >
            {advancing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading report…
              </>
            ) : (
              <>
                View vulnerability report
                <ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-rose-500/30 bg-rose-500/5">
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-sm font-medium text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Probe run failed.</p>
            <p className="text-rose-200/80">{message}</p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={onRetry}
          className="border-rose-400/30 bg-transparent text-rose-200 hover:bg-rose-500/10 hover:text-rose-100"
        >
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------- Atoms -----------------------------------------------------------

type Tone = "indigo" | "rose" | "emerald" | "amber";

function CounterCard({
  icon,
  label,
  value,
  tone,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: Tone;
  highlight?: boolean;
}) {
  const ring =
    tone === "indigo"
      ? "border-indigo-400/20"
      : tone === "rose"
        ? "border-rose-400/20"
        : tone === "amber"
          ? "border-amber-400/20"
          : "border-emerald-400/20";
  const accent =
    tone === "indigo"
      ? "text-indigo-300"
      : tone === "rose"
        ? "text-rose-300"
        : tone === "amber"
          ? "text-amber-300"
          : "text-emerald-300";

  return (
    <div
      className={cn(
        "rounded-md border bg-white/[0.02] p-5 transition-all duration-300",
        ring,
        highlight &&
          "scale-[1.02] border-rose-400/60 shadow-[0_0_40px_-15px_rgba(244,63,94,0.7)]",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-xs font-semibold uppercase tracking-wider",
          accent,
        )}
      >
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "mt-2 font-mono text-4xl font-bold tabular-nums tracking-tight text-zinc-100",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ---------- Helpers ---------------------------------------------------------

function failureTone(rate: number): Tone {
  if (rate < 0.05) return "emerald";
  if (rate < 0.15) return "amber";
  return "rose";
}

function toneTextClass(tone: Tone): string {
  switch (tone) {
    case "emerald":
      return "text-emerald-300";
    case "amber":
      return "text-amber-300";
    case "rose":
      return "text-rose-300";
    case "indigo":
    default:
      return "text-indigo-300";
  }
}

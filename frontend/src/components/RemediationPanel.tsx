"use client";

/**
 * RemediationPanel — modal that closes the FairLens loop on a single CVE.
 *
 * State machine:
 *   loading  -> fetching strategies from /api/remediate.
 *   ready    -> 2-3 strategy cards rendered; one is selected (Gemini's
 *               recommendation by default). User clicks Apply & rescan.
 *   applying -> /api/rescan in flight; spinner + narrative.
 *   complete -> before / after stat cards + Recharts bar comparison.
 *               User can pick another strategy and rerun, or close.
 *   error    -> recoverable error with retry button.
 *
 * The proof moment lives in the `complete` panel: failure-rate plummets
 * from N% to ~0%, the bars collapse, and a green headline calls it out.
 * Accuracy tradeoff is shown honestly so the user sees what the fix cost.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Sparkles,
  TrendingDown,
  Wrench,
} from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, getRemediation, runRescan } from "@/lib/api";
import type {
  CVEEntry,
  Effort,
  RemediationResponse,
  RemediationStrategy,
  RescanComparison,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Phase = "loading" | "ready" | "applying" | "complete" | "error";

interface RemediationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  cve: CVEEntry | null;
}

export function RemediationPanel({
  open,
  onOpenChange,
  sessionId,
  cve,
}: RemediationPanelProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [remediation, setRemediation] = useState<RemediationResponse | null>(
    null,
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [comparison, setComparison] = useState<RescanComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset and fetch strategies whenever the dialog opens with a (new) CVE.
  useEffect(() => {
    if (!open || !cve) return;
    let cancelled = false;
    setPhase("loading");
    setError(null);
    setComparison(null);
    setRemediation(null);
    setSelectedIdx(0);

    getRemediation(sessionId, cve.id)
      .then((res) => {
        if (cancelled) return;
        setRemediation(res);
        const recIdx = res.strategies.findIndex(
          (s) => s.name === res.recommended_strategy,
        );
        setSelectedIdx(recIdx >= 0 ? recIdx : 0);
        setPhase("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          e instanceof ApiError
            ? e.message
            : "Failed to fetch remediation strategies.",
        );
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [open, cve, sessionId]);

  async function applyFix() {
    if (!cve || !remediation) return;
    setPhase("applying");
    setError(null);
    try {
      const result = await runRescan(sessionId, cve.id, selectedIdx);
      setComparison(result);
      setPhase("complete");
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Rescan failed unexpectedly.",
      );
      setPhase("error");
    }
  }

  function tryAnother() {
    setComparison(null);
    setPhase("ready");
  }

  const selectedStrategy = remediation?.strategies[selectedIdx];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-full flex-col overflow-hidden border-white/10 bg-card p-0 text-zinc-100 sm:max-w-6xl"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b border-white/5 px-6 pt-6 pb-4">
          <DialogTitle className="text-2xl font-bold tracking-tight text-zinc-100">
            {phase === "complete" ? "Fix verified" : "Remediate vulnerability"}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            {cve ? (
              <>
                <span className="font-mono text-xs text-zinc-500">
                  {cve.id}
                </span>{" "}
                &middot; {cve.title}
              </>
            ) : (
              "Pick a CVE from the report to remediate."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
          {phase === "loading" ? (
            <LoadingState label="Asking Gemini for fix strategies…" />
          ) : null}

          {phase === "error" ? (
            <ErrorBlock
              message={error ?? "Unknown error."}
              onRetry={tryAnother}
            />
          ) : null}

          {phase === "ready" && remediation ? (
            <StrategyPicker
              remediation={remediation}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
            />
          ) : null}

          {phase === "applying" ? <ApplyingState /> : null}

          {phase === "complete" && comparison && remediation ? (
            <RescanResult
              comparison={comparison}
              strategy={remediation.strategies[selectedIdx]}
            />
          ) : null}
        </div>

        {/* Sticky footer — always-visible action row, varies by phase. */}
        {phase === "ready" && selectedStrategy ? (
          <div className="shrink-0 border-t border-white/5 bg-card/95 px-6 py-4 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-zinc-400">
                Selected:{" "}
                <span className="font-semibold text-zinc-100">
                  {selectedStrategy.name}
                </span>
              </p>
              <Button
                size="lg"
                onClick={applyFix}
                className="bg-[#6366F1] font-semibold text-white shadow-lg shadow-[#6366F1]/20 hover:bg-[#6366F1]/90"
              >
                <Wrench className="mr-2 h-4 w-4" />
                Apply fix &amp; re-scan
              </Button>
            </div>
          </div>
        ) : null}

        {phase === "complete" && comparison ? (
          <div className="shrink-0 border-t border-white/5 bg-card/95 px-6 py-4 backdrop-blur">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={tryAnother}
                className="border-white/10 bg-transparent text-zinc-200 hover:bg-white/5 hover:text-white"
              >
                Try another strategy
              </Button>
              <Button
                onClick={() => onOpenChange(false)}
                className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
              >
                Done
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------- Strategy picker -------------------------------------------------

function StrategyPicker({
  remediation,
  selectedIdx,
  onSelect,
}: {
  remediation: RemediationResponse;
  selectedIdx: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="space-y-3">
      {remediation.strategies.map((strategy, idx) => (
        <StrategyCard
          key={strategy.name + idx}
          strategy={strategy}
          isRecommended={strategy.name === remediation.recommended_strategy}
          isSelected={idx === selectedIdx}
          onClick={() => onSelect(idx)}
        />
      ))}
    </div>
  );
}

function StrategyCard({
  strategy,
  isRecommended,
  isSelected,
  onClick,
}: {
  strategy: RemediationStrategy;
  isRecommended: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-lg border bg-white/[0.02] p-4 text-left transition-colors",
        isSelected
          ? "border-[#6366F1]/60 bg-[#6366F1]/5 shadow-[0_0_30px_-15px_rgba(99,102,241,0.6)]"
          : "border-white/10 hover:border-white/20 hover:bg-white/[0.04]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-zinc-100">
            {strategy.name}
          </h3>
          {isRecommended ? (
            <Badge className="border-[#6366F1]/40 bg-[#6366F1]/15 font-mono text-[10px] font-bold uppercase tracking-wider text-[#A5B4FC]">
              <Sparkles className="mr-1 h-3 w-3" />
              recommended
            </Badge>
          ) : null}
        </div>
        <EffortBadge effort={strategy.effort} />
      </div>

      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        {strategy.action}
      </p>

      <div className="mt-3 flex flex-wrap gap-3 font-mono text-xs">
        <Stat
          label="Bias reduction"
          value={`${(strategy.estimated_bias_reduction * 100).toFixed(0)}%`}
          tone="emerald"
        />
        <Stat
          label="Accuracy tradeoff"
          value={`${strategy.accuracy_tradeoff >= 0 ? "+" : ""}${(
            strategy.accuracy_tradeoff * 100
          ).toFixed(1)}pp`}
          tone={strategy.accuracy_tradeoff < 0 ? "amber" : "emerald"}
        />
      </div>

      <pre className="mt-3 max-h-56 max-w-full overflow-x-auto overflow-y-auto whitespace-pre rounded-md border border-white/10 bg-[#0A0A0B] p-3 font-mono text-[12px] leading-relaxed text-zinc-300">
        <code>{strategy.code}</code>
      </pre>
    </button>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber";
}) {
  const cls =
    tone === "emerald"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
      : "border-amber-400/30 bg-amber-500/10 text-amber-200";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
        cls,
      )}
    >
      {label}: <span className="font-mono">{value}</span>
    </span>
  );
}

function EffortBadge({ effort }: { effort: Effort }) {
  const cfg =
    effort === "LOW"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
      : effort === "MEDIUM"
        ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
        : "border-rose-400/30 bg-rose-500/10 text-rose-200";
  return (
    <Badge
      className={cn(
        "border font-mono text-[10px] font-bold uppercase tracking-wider",
        cfg,
      )}
    >
      {effort} effort
    </Badge>
  );
}

// ---------- Applying & rescan result ----------------------------------------

function ApplyingState() {
  return (
    <div className="space-y-5 py-6">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-[#6366F1]" />
        <p className="text-base font-semibold text-zinc-100">
          Applying fix, retraining model, replaying every probe pair…
        </p>
      </div>
      <ol className="space-y-2 pl-8 font-mono text-sm text-zinc-500">
        <li className="flex items-center gap-2">
          <span className="h-1 w-1 rounded-full bg-zinc-500" />
          executing apply_fix(df)
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1 w-1 rounded-full bg-zinc-500" />
          retraining the RandomForest on the corrected dataset
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1 w-1 rounded-full bg-zinc-500" />
          firing the original probe pairs through the new model
        </li>
      </ol>
      <div className="h-2 overflow-hidden rounded-full bg-white/5">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-[#6366F1]/60" />
      </div>
    </div>
  );
}

function RescanResult({
  comparison,
  strategy,
}: {
  comparison: RescanComparison;
  strategy: RemediationStrategy | undefined;
}) {
  const reduction =
    comparison.before_failure_rate > 0
      ? 1 -
        comparison.after_failure_rate / comparison.before_failure_rate
      : 0;
  const accuracyDelta = comparison.accuracy_after - comparison.accuracy_before;
  const accuracyImproved = accuracyDelta >= -0.01;
  const headlineGood = comparison.after_failure_rate <= comparison.before_failure_rate;

  return (
    <div className="space-y-6">
      {/* Headline */}
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border p-4",
          headlineGood
            ? "border-emerald-400/30 bg-emerald-500/5"
            : "border-rose-400/30 bg-rose-500/5",
        )}
      >
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
            headlineGood
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-rose-500/15 text-rose-300",
          )}
        >
          {headlineGood ? (
            <CheckCircle2 className="h-6 w-6" />
          ) : (
            <AlertCircle className="h-6 w-6" />
          )}
        </span>
        <div className="space-y-1">
          <p
            className={cn(
              "text-2xl font-bold tracking-tight",
              headlineGood ? "text-emerald-100" : "text-rose-100",
            )}
          >
            {comparison.after_failure_rate === 0
              ? "Bias eliminated."
              : reduction > 0
                ? `Bias reduced by ${(reduction * 100).toFixed(0)}%.`
                : "Fix did not move the needle."}
          </p>
          <p className="text-sm text-zinc-400">
            Failure rate dropped from{" "}
            <span className="font-mono font-semibold text-zinc-100">
              {(comparison.before_failure_rate * 100).toFixed(1)}%
            </span>{" "}
            to{" "}
            <span className="font-mono font-semibold text-zinc-100">
              {(comparison.after_failure_rate * 100).toFixed(1)}%
            </span>
            . Verified against{" "}
            <span className="font-mono text-zinc-100">
              {comparison.total_probes}
            </span>{" "}
            probe pairs.
          </p>
        </div>
      </div>

      {/* Three before/after stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <BeforeAfterCard
          label="Failure rate"
          before={`${(comparison.before_failure_rate * 100).toFixed(1)}%`}
          after={`${(comparison.after_failure_rate * 100).toFixed(1)}%`}
          improved={
            comparison.after_failure_rate <= comparison.before_failure_rate
          }
        />
        <BeforeAfterCard
          label="Anomalies"
          before={String(comparison.before_anomalies)}
          after={String(comparison.after_anomalies)}
          improved={comparison.after_anomalies <= comparison.before_anomalies}
        />
        <BeforeAfterCard
          label="Model accuracy"
          before={`${(comparison.accuracy_before * 100).toFixed(1)}%`}
          after={`${(comparison.accuracy_after * 100).toFixed(1)}%`}
          improved={accuracyImproved}
          neutral
        />
      </div>

      {/* Bar chart */}
      <ComparisonChart comparison={comparison} />

      {strategy ? (
        <p className="font-mono text-xs text-zinc-500">
          Applied: <span className="text-zinc-300">{strategy.name}</span> &middot;{" "}
          {strategy.effort} effort
        </p>
      ) : null}
    </div>
  );
}

function BeforeAfterCard({
  label,
  before,
  after,
  improved,
  neutral,
}: {
  label: string;
  before: string;
  after: string;
  improved: boolean;
  neutral?: boolean;
}) {
  const afterTone = neutral
    ? "text-zinc-100"
    : improved
      ? "text-emerald-300"
      : "text-rose-300";
  const arrowTone = neutral
    ? "text-zinc-500"
    : improved
      ? "text-emerald-400"
      : "text-rose-400";
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2 font-mono">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            Before
          </p>
          <p className="text-2xl font-bold text-zinc-400 line-through decoration-zinc-600">
            {before}
          </p>
        </div>
        <ArrowRight className={cn("h-4 w-4 shrink-0", arrowTone)} />
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            After
          </p>
          <p className={cn("text-2xl font-bold tabular-nums", afterTone)}>
            {after}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------- Recharts bar comparison -----------------------------------------

function ComparisonChart({ comparison }: { comparison: RescanComparison }) {
  const data = [
    { metric: "Failure %", value: comparison.before_failure_rate * 100, kind: "Before" },
    { metric: "Failure %", value: comparison.after_failure_rate * 100, kind: "After" },
    { metric: "Anomalies", value: comparison.before_anomalies, kind: "Before" },
    { metric: "Anomalies", value: comparison.after_anomalies, kind: "After" },
    { metric: "Accuracy %", value: comparison.accuracy_before * 100, kind: "Before" },
    { metric: "Accuracy %", value: comparison.accuracy_after * 100, kind: "After" },
  ];

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Side-by-side
        </p>
        <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-wider">
          <span className="flex items-center gap-1.5 text-zinc-400">
            <span className="h-2 w-3 rounded-sm bg-zinc-500" /> Before
          </span>
          <span className="flex items-center gap-1.5 text-emerald-300">
            <span className="h-2 w-3 rounded-sm bg-emerald-400" /> After
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
          <XAxis
            dataKey="metric"
            stroke="#71717a"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
          />
          <YAxis
            stroke="#71717a"
            tick={{ fontSize: 11, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            width={40}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={{
              backgroundColor: "#141416",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              fontSize: 12,
              color: "#f4f4f5",
            }}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={28}>
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.kind === "Before" ? "#71717a" : "#34D399"}
              />
            ))}
            <LabelList
              dataKey="value"
              position="top"
              formatter={(v: unknown) =>
                typeof v === "number" ? v.toFixed(1) : ""
              }
              fill="#a1a1aa"
              fontSize={10}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- Helpers ---------------------------------------------------------

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-10">
      <Loader2 className="h-5 w-5 animate-spin text-[#6366F1]" />
      <p className="text-sm text-zinc-300">{label}</p>
    </div>
  );
}

function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-4">
      <p className="flex items-start gap-2 text-sm font-medium text-rose-200">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        {message}
      </p>
      <Button
        variant="outline"
        onClick={onRetry}
        className="border-rose-400/30 bg-transparent text-rose-200 hover:bg-rose-500/10 hover:text-rose-100"
      >
        Try again
      </Button>
    </div>
  );
}

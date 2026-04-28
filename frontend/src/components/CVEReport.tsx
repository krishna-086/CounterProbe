"use client";

/**
 * CVEReport — Step 4 of the audit flow.
 *
 * Renders the security-style vulnerability report from /api/grade-cves:
 *
 *   1. Summary bar     — totals + severity breakdown + overall failure rate.
 *   2. CVE cards       — one per finding, severity-colored, evidence grid,
 *                        legitimate factors held constant, root cause,
 *                        per-CVE "Fix & Verify" button.
 *   3. Comparison table — "Without FairLens vs With FairLens" two-column
 *                        side-by-side that we lean on in the demo pitch.
 *
 * The Fix & Verify button just emits onFix(cveId) — the parent owns the
 * remediation panel and decides when to render it.
 */

import { useMemo } from "react";
import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Check,
  Info,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type {
  CVEEntry,
  ProbeProgress as ProbeProgressEvent,
  RescanComparison,
  Severity,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface CVEReportProps {
  cves: CVEEntry[];
  summary: ProbeProgressEvent;
  /** Highlight the currently selected CVE (e.g. while remediation panel is open). */
  selectedCveId?: string | null;
  /** Per-CVE rescan results so the card can show fixed/unresolved state. */
  rescanByCveId?: Record<string, RescanComparison>;
  onFix?: (cveId: string) => void;
}

export function CVEReport({
  cves,
  summary,
  selectedCveId,
  rescanByCveId,
  onFix,
}: CVEReportProps) {
  const counts = useMemo(() => {
    const c: Record<Severity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    for (const cve of cves) c[cve.severity] += 1;
    return c;
  }, [cves]);

  return (
    <div className="space-y-8">
      <SummaryBar
        total={cves.length}
        counts={counts}
        failureRate={summary.failure_rate}
        flips={summary.anomalies_found}
        probes={summary.total_probes}
      />

      {cves.length === 0 ? (
        <Card className="border-emerald-400/20 bg-emerald-500/5">
          <CardContent className="flex items-center gap-3 pt-6 text-sm font-medium text-emerald-200">
            <ShieldCheck className="h-5 w-5" />
            No bias patterns surfaced on this run. Try a larger probe sweep
            or revisit the baseline configuration to harden the test.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {cves.map((cve) => (
            <CVECard
              key={cve.id}
              cve={cve}
              selected={selectedCveId === cve.id}
              rescan={rescanByCveId?.[cve.id]}
              onFix={() => onFix?.(cve.id)}
            />
          ))}
        </div>
      )}

      <ComparisonTable />
    </div>
  );
}

// ---------- Summary bar -----------------------------------------------------

function SummaryBar({
  total,
  counts,
  failureRate,
  flips,
  probes,
}: {
  total: number;
  counts: Record<Severity, number>;
  failureRate: number;
  flips: number;
  probes: number;
}) {
  const failureTone =
    failureRate >= 0.15
      ? "text-rose-300"
      : failureRate >= 0.05
        ? "text-amber-300"
        : "text-emerald-300";

  return (
    <Card className="border-white/5 bg-card">
      <CardContent className="grid gap-6 pt-6 sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Total vulnerabilities
          </p>
          <p className="mt-2 font-mono text-4xl font-bold tabular-nums text-zinc-100">
            {total}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            across {probes.toLocaleString()} probe pairs
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Severity breakdown
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as Severity[]).map(
              (sev) => (
                <SeverityCount
                  key={sev}
                  severity={sev}
                  count={counts[sev]}
                />
              ),
            )}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Overall failure rate
          </p>
          <p
            className={cn(
              "mt-2 font-mono text-4xl font-bold tabular-nums",
              failureTone,
            )}
          >
            {(failureRate * 100).toFixed(1)}%
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            <span className="font-mono text-zinc-300">{flips}</span> probe
            flips
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function SeverityCount({
  severity,
  count,
}: {
  severity: Severity;
  count: number;
}) {
  const dim = count === 0;
  const cfg = SEVERITY_STYLE[severity];
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 transition-opacity",
        cfg.border,
        cfg.bg,
        dim && "opacity-40",
      )}
    >
      <span className={cn("font-mono text-base font-bold", cfg.text)}>
        {count}
      </span>
      <span
        className={cn(
          "font-mono text-[10px] font-semibold uppercase tracking-wider",
          cfg.text,
        )}
      >
        {severity.toLowerCase()}
      </span>
    </div>
  );
}

// ---------- CVE card --------------------------------------------------------

function CVECard({
  cve,
  selected,
  rescan,
  onFix,
}: {
  cve: CVEEntry;
  selected: boolean;
  rescan?: RescanComparison;
  onFix: () => void;
}) {
  const cfg = SEVERITY_STYLE[cve.severity];
  const ev = cve.evidence;
  const isFixed = !!rescan && rescan.after_failure_rate < rescan.before_failure_rate;
  const isUnresolved = !!rescan && !isFixed;

  return (
    <Card
      className={cn(
        "border bg-card transition-shadow",
        cfg.cardBorder,
        selected && "ring-2 ring-[#6366F1]/40",
        isFixed && "opacity-80",
      )}
    >
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={cve.severity} />
            {isFixed ? <FixedBadge /> : null}
            {isUnresolved ? <UnresolvedBadge /> : null}
            <span className="font-mono text-xs font-medium tracking-wider text-zinc-500">
              {cve.id}
            </span>
          </div>
          {isFixed ? (
            <Button
              disabled
              className="border border-emerald-500/40 bg-emerald-500/15 font-semibold text-emerald-200 disabled:opacity-100"
            >
              <Check className="mr-2 h-4 w-4" />
              Fixed
            </Button>
          ) : (
            <Button
              onClick={onFix}
              className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
            >
              <Wrench className="mr-2 h-4 w-4" />
              {isUnresolved ? "Try another fix" : "Fix & verify"}
            </Button>
          )}
        </div>
        <div>
          <CardTitle className="text-2xl font-bold tracking-tight text-zinc-100">
            {cve.title}
          </CardTitle>
          <CardDescription className="mt-1 text-sm text-zinc-400">
            <span className="font-medium text-zinc-300">Attack vector: </span>
            {cve.attack_vector}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <EvidenceGrid evidence={ev} />

        {rescan ? <RescanSummary rescan={rescan} fixed={isFixed} /> : null}

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Legitimate factors held constant
          </p>
          <div className="flex flex-wrap gap-1.5">
            {cve.legitimate_factors_controlled.length === 0 ? (
              <span className="text-sm text-zinc-500">(none)</span>
            ) : (
              cve.legitimate_factors_controlled.map((f) => (
                <span
                  key={f}
                  className="rounded border border-emerald-400/20 bg-emerald-500/5 px-2 py-0.5 font-mono text-xs font-medium text-emerald-200"
                >
                  {f}
                </span>
              ))
            )}
          </div>
        </div>

        <Separator className="bg-white/5" />

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Root cause
          </p>
          <p className="text-sm leading-relaxed text-zinc-300">
            {cve.root_cause}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function FixedBadge() {
  return (
    <Badge className="flex items-center gap-1 border border-emerald-500/40 bg-emerald-500/15 font-mono text-[11px] font-bold uppercase tracking-wider text-emerald-300">
      <Check className="h-3 w-3" />
      fixed
    </Badge>
  );
}

function UnresolvedBadge() {
  return (
    <Badge className="flex items-center gap-1 border border-amber-400/40 bg-amber-500/15 font-mono text-[11px] font-bold uppercase tracking-wider text-amber-300">
      <AlertTriangle className="h-3 w-3" />
      unresolved
    </Badge>
  );
}

function RescanSummary({
  rescan,
  fixed,
}: {
  rescan: RescanComparison;
  fixed: boolean;
}) {
  const beforePct = (rescan.before_failure_rate * 100).toFixed(1);
  const afterPct = (rescan.after_failure_rate * 100).toFixed(1);
  const accBefore = (rescan.accuracy_before * 100).toFixed(1);
  const accAfter = (rescan.accuracy_after * 100).toFixed(1);

  if (!fixed) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-500/5 px-3 py-2.5 font-mono text-xs text-amber-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Fix attempted: failure rate unchanged ({beforePct}% → {afterPct}%).
          Try another strategy.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-emerald-400/30 bg-emerald-500/5 px-3 py-2.5 font-mono text-xs text-emerald-100">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-emerald-300">Before:</span>
          <span className="line-through decoration-emerald-700/60">
            {beforePct}%
          </span>
          <span className="text-emerald-400">→</span>
          <span className="text-emerald-200">After: {afterPct}%</span>
        </span>
        <span className="text-emerald-300/60">|</span>
        <span>
          <span className="text-emerald-300">Accuracy:</span>{" "}
          <span className="text-emerald-200">
            {accBefore}% → {accAfter}%
          </span>
        </span>
      </div>
    </div>
  );
}

function EvidenceGrid({
  evidence,
}: {
  evidence: CVEEntry["evidence"];
}) {
  const failureTone =
    evidence.flip_rate >= 0.15
      ? "text-rose-300"
      : evidence.flip_rate >= 0.05
        ? "text-amber-300"
        : "text-emerald-300";
  const ratioTone = evidence.four_fifths_violation
    ? "text-rose-300"
    : "text-emerald-300";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <EvidenceCell
        label="Probe pairs"
        value={evidence.probe_pairs_tested.toLocaleString()}
      />
      <EvidenceCell
        label="Decision flips"
        value={evidence.prediction_flips.toLocaleString()}
      />
      <EvidenceCell
        label="Failure rate"
        value={`${(evidence.flip_rate * 100).toFixed(1)}%`}
        tone={failureTone}
      />
      <EvidenceCell
        label="4/5ths ratio"
        value={evidence.selection_rate_ratio.toFixed(2)}
        tone={ratioTone}
        suffix={
          evidence.four_fifths_violation ? (
            <Badge className="ml-2 border-rose-500/40 bg-rose-500/15 font-mono text-[10px] font-bold uppercase tracking-wider text-rose-300">
              violation
            </Badge>
          ) : null
        }
      />
    </div>
  );
}

function EvidenceCell({
  label,
  value,
  tone,
  suffix,
}: {
  label: string;
  value: string;
  tone?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p className="mt-1.5 flex items-center font-mono text-xl font-bold tabular-nums">
        <span className={tone ?? "text-zinc-100"}>{value}</span>
        {suffix}
      </p>
    </div>
  );
}

// ---------- Severity badge --------------------------------------------------

function SeverityBadge({ severity }: { severity: Severity }) {
  const cfg = SEVERITY_STYLE[severity];
  const Icon = cfg.icon;
  return (
    <Badge
      className={cn(
        "flex items-center gap-1 border font-mono text-[11px] font-bold uppercase tracking-wider",
        cfg.border,
        cfg.bg,
        cfg.text,
      )}
    >
      <Icon className="h-3 w-3" />
      {severity}
    </Badge>
  );
}

// ---------- Comparison table ------------------------------------------------

const COMPARISON_ROWS: { label: string; without: string; with: string }[] = [
  {
    label: "What you test",
    without: "Aggregate group statistics",
    with: "Individual decisions, side by side",
  },
  {
    label: "What you find",
    without: "Correlations",
    with: "Causal flips you can replay",
  },
  {
    label: "Evidence quality",
    without: "Statistical inference",
    with: "Forensic, per-probe records",
  },
  {
    label: "Fix verification",
    without: "Hope it generalizes",
    with: "Empirical before / after rescan",
  },
  {
    label: "Time to audit",
    without: "Weeks of analyst review",
    with: "Minutes, end-to-end",
  },
];

function ComparisonTable() {
  return (
    <Card className="border-t-2 border-t-[#6366F1]/40 border-x border-b border-x-white/5 border-b-white/5 bg-card">
      <CardHeader className="pb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#A5B4FC]">
          Pitch slide
        </p>
        <CardTitle className="mt-2 text-2xl font-bold tracking-tight text-zinc-100">
          Why this report is different
        </CardTitle>
        <CardDescription className="text-base text-zinc-400">
          Counterfactual probing turns fairness from a statistical guess into
          a reproducible test.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-y border-white/5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                <th className="px-6 py-3 w-1/4"></th>
                <th className="px-6 py-3">
                  <span className="flex items-center gap-2 text-zinc-400">
                    <X className="h-3.5 w-3.5" />
                    Without CounterProbe
                  </span>
                </th>
                <th className="px-6 py-3">
                  <span className="flex items-center gap-2 text-[#6366F1]">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    With CounterProbe
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row, idx) => (
                <tr
                  key={row.label}
                  className={cn(
                    "border-b border-white/5",
                    idx % 2 === 1 && "bg-white/[0.02]",
                  )}
                >
                  <td className="px-6 py-4 font-semibold text-zinc-300">
                    {row.label}
                  </td>
                  <td className="px-6 py-4 text-zinc-500">{row.without}</td>
                  <td className="px-6 py-4 font-medium text-zinc-100">
                    {row.with}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Severity styling lookup -----------------------------------------

const SEVERITY_STYLE: Record<
  Severity,
  {
    icon: typeof AlertOctagon;
    text: string;
    bg: string;
    border: string;
    cardBorder: string;
  }
> = {
  CRITICAL: {
    icon: AlertOctagon,
    text: "text-rose-300",
    bg: "bg-rose-500/15",
    border: "border-rose-500/40",
    cardBorder: "border-rose-500/30",
  },
  HIGH: {
    icon: AlertTriangle,
    text: "text-orange-300",
    bg: "bg-orange-500/15",
    border: "border-orange-500/40",
    cardBorder: "border-orange-500/25",
  },
  MEDIUM: {
    icon: AlertCircle,
    text: "text-amber-300",
    bg: "bg-amber-400/15",
    border: "border-amber-400/40",
    cardBorder: "border-amber-400/20",
  },
  LOW: {
    icon: Info,
    text: "text-emerald-300",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/40",
    cardBorder: "border-white/5",
  },
};

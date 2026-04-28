"use client";

/**
 * /audit — orchestrates the four-step audit flow.
 *
 * Owns all session-level state (no localStorage per CLAUDE.md):
 *   - step: which of the four panels is visible
 *   - sessionId: backend session created by the upload step
 *   - upload, baseline, probeResults/Summary, cves: data flowing between steps
 *   - selectedCveId: which CVE the remediation modal is open for
 *
 * Stepper visualizes progress and lets the user click back to any reachable
 * (already-completed) step. Each step also gets an explicit "Back" button via
 * the StepFrame wrapper, plus a "Start over" affordance in the header that
 * nukes everything and returns to step 1.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  BaselineConfig,
  type BaselineConfirmedPayload,
} from "@/components/BaselineConfig";
import { CVEReport } from "@/components/CVEReport";
import { DataPreview } from "@/components/DataPreview";
import { FileUpload } from "@/components/FileUpload";
import {
  ProbeProgress,
  type ProbeStepCompletePayload,
} from "@/components/ProbeProgress";
import { RemediationPanel } from "@/components/RemediationPanel";
import type {
  CVEEntry,
  ProbeProgress as ProbeProgressEvent,
  ProbeResult,
  RescanComparison,
  UploadResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Step = "upload" | "baseline" | "probe" | "report";

const STEPS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload data" },
  { id: "baseline", label: "Configure baseline" },
  { id: "probe", label: "Run probes" },
  { id: "report", label: "Results & fix" },
];

const STEP_INDEX: Record<Step, number> = {
  upload: 0,
  baseline: 1,
  probe: 2,
  report: 3,
};

export default function AuditPage() {
  const [step, setStep] = useState<Step>("upload");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [baseline, setBaseline] = useState<BaselineConfirmedPayload | null>(
    null,
  );
  const [probeResults, setProbeResults] = useState<ProbeResult[] | null>(null);
  const [probeSummary, setProbeSummary] =
    useState<ProbeProgressEvent | null>(null);
  const [cves, setCves] = useState<CVEEntry[] | null>(null);
  const [selectedCveId, setSelectedCveId] = useState<string | null>(null);
  const [rescanByCveId, setRescanByCveId] = useState<
    Record<string, RescanComparison>
  >({});

  function handleUploaded(response: UploadResponse) {
    setSessionId(response.session_id);
    setUpload(response);
    // A new upload invalidates anything we'd configured on top.
    setBaseline(null);
    setProbeResults(null);
    setProbeSummary(null);
    setCves(null);
    setSelectedCveId(null);
    setRescanByCveId({});
  }

  function handleBaselineConfirmed(payload: BaselineConfirmedPayload) {
    setBaseline(payload);
    setProbeResults(null);
    setProbeSummary(null);
    setCves(null);
    setSelectedCveId(null);
    setRescanByCveId({});
    setStep("probe");
  }

  function handleProbeComplete(payload: ProbeStepCompletePayload) {
    setProbeResults(payload.results);
    setProbeSummary(payload.summary);
    setCves(payload.cves);
    setSelectedCveId(null);
    setRescanByCveId({});
    setStep("report");
  }

  function handleSelectCveForFix(cveId: string) {
    setSelectedCveId(cveId);
  }

  function handleRescanComplete(cveId: string, comparison: RescanComparison) {
    setRescanByCveId((prev) => ({ ...prev, [cveId]: comparison }));
  }

  const selectedCve =
    selectedCveId && cves
      ? cves.find((c) => c.id === selectedCveId) ?? null
      : null;

  function reachable(target: Step): boolean {
    if (target === "upload") return true;
    if (target === "baseline") return upload !== null;
    if (target === "probe") return baseline !== null;
    if (target === "report") return cves !== null;
    return false;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-12">
      <header className="mb-8 sm:mb-10">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          <ShieldCheck className="h-3.5 w-3.5 text-[#6366F1]" />
          CounterProbe · adversarial fairness testing
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-zinc-100 sm:text-4xl">
          Find the bias your statistical audit missed.
        </h1>
        <p className="mt-3 max-w-3xl text-base text-zinc-400 sm:text-lg">
          Upload a training dataset and CounterProbe probes your model with
          counterfactual variants — Gemini-generated stand-ins where only the
          protected attributes change — to surface every demographic-correlated
          decision pattern hiding in the weights.
        </p>
      </header>

      <Stepper
        current={step}
        onSelect={(target) => {
          if (reachable(target)) setStep(target);
        }}
        reachable={reachable}
      />

      <div className="mt-8 sm:mt-10">
        {step === "upload" ? (
          <StepFrame>
            <UploadStep
              upload={upload}
              onUploaded={handleUploaded}
              onContinue={() => setStep("baseline")}
            />
          </StepFrame>
        ) : null}

        {step === "baseline" && upload ? (
          <StepFrame
            backLabel="Back to upload"
            onBack={() => setStep("upload")}
          >
            <BaselineConfig
              upload={upload}
              onConfirmed={handleBaselineConfirmed}
            />
          </StepFrame>
        ) : null}

        {step === "probe" && sessionId && baseline ? (
          <StepFrame
            backLabel="Back to baseline"
            onBack={() => setStep("baseline")}
          >
            <ProbeProgress
              sessionId={sessionId}
              baseline={baseline}
              onComplete={handleProbeComplete}
            />
          </StepFrame>
        ) : null}

        {step === "report" && cves && probeSummary ? (
          <StepFrame
            backLabel="Back to probe"
            onBack={() => setStep("probe")}
          >
            <CVEReport
              cves={cves}
              summary={probeSummary}
              selectedCveId={selectedCveId}
              rescanByCveId={rescanByCveId}
              onFix={handleSelectCveForFix}
            />
          </StepFrame>
        ) : null}
      </div>

      {sessionId && selectedCve ? (
        <RemediationPanel
          open={selectedCveId !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedCveId(null);
          }}
          sessionId={sessionId}
          cve={selectedCve}
          onRescanComplete={handleRescanComplete}
        />
      ) : null}

      {sessionId ? (
        <p className="mt-10 font-mono text-[11px] uppercase tracking-wider text-zinc-600">
          session {sessionId.slice(0, 8)}
        </p>
      ) : null}
    </div>
  );
}

// ---------- StepFrame -------------------------------------------------------

function StepFrame({
  onBack,
  backLabel,
  children,
}: {
  onBack?: () => void;
  backLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {backLabel ?? "Back"}
        </button>
      ) : null}
      {children}
    </div>
  );
}

// ---------- Stepper ---------------------------------------------------------

interface StepperProps {
  current: Step;
  reachable: (target: Step) => boolean;
  onSelect: (target: Step) => void;
}

function Stepper({ current, reachable, onSelect }: StepperProps) {
  const currentIdx = STEP_INDEX[current];
  return (
    <ol className="flex flex-wrap items-center gap-y-3">
      {STEPS.map((s, idx) => {
        const isCurrent = s.id === current;
        const isCompleted = idx < currentIdx;
        const isReachable = reachable(s.id);
        return (
          <li key={s.id} className="flex items-center">
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              disabled={!isReachable}
              className={cn(
                "group flex items-center gap-3 rounded-md px-1 py-1 text-left transition-colors",
                isReachable ? "cursor-pointer" : "cursor-not-allowed",
              )}
            >
              <span
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md text-sm font-bold transition-colors",
                  isCurrent && "bg-[#6366F1] text-white",
                  isCompleted &&
                    "border border-[#6366F1]/40 bg-[#6366F1]/10 text-[#6366F1]",
                  !isCurrent &&
                    !isCompleted &&
                    "border border-white/10 bg-white/5 text-zinc-500",
                )}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : idx + 1}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  isCurrent || isCompleted ? "text-zinc-100" : "text-zinc-500",
                )}
              >
                {s.label}
              </span>
            </button>
            {idx < STEPS.length - 1 ? (
              <span
                className={cn(
                  "mx-3 h-px w-6 shrink-0 sm:w-10",
                  idx < currentIdx ? "bg-[#6366F1]/40" : "bg-white/10",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Step 1 (upload) -------------------------------------------------

interface UploadStepProps {
  upload: UploadResponse | null;
  onUploaded: (r: UploadResponse) => void;
  onContinue: () => void;
}

function UploadStep({ upload, onUploaded, onContinue }: UploadStepProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const previousSession = useRef<string | null>(null);

  // Smoothly scroll the preview into view whenever a *new* session is created
  // — both manual upload and "Try with sample data" land here. Prevents the
  // demo case where the dataset loads silently below the fold.
  useEffect(() => {
    if (!upload) return;
    if (previousSession.current === upload.session_id) return;
    previousSession.current = upload.session_id;
    const id = window.setTimeout(() => {
      previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(id);
  }, [upload]);

  return (
    <div className="space-y-8">
      <Card className="border-white/5 bg-card">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-zinc-100">
            {upload ? "Re-upload dataset" : "Upload dataset"}
          </CardTitle>
          <CardDescription className="text-zinc-400">
            Drop a CSV with one row per observation and a binary target
            column. We&rsquo;ll profile every column and show you a preview.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FileUpload onUploaded={onUploaded} />
        </CardContent>
      </Card>

      {upload ? (
        <div ref={previewRef} className="space-y-6">
          <div
            role="status"
            className="flex items-center gap-3 rounded-md border border-emerald-400/30 bg-emerald-500/5 px-4 py-3 text-sm font-medium text-emerald-200"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              Loaded{" "}
              <span className="font-mono text-emerald-100">
                {upload.row_count.toLocaleString()}
              </span>{" "}
              rows across{" "}
              <span className="font-mono text-emerald-100">
                {upload.columns.length}
              </span>{" "}
              columns. Scroll down to inspect, then continue when ready.
            </span>
          </div>

          <DataPreview data={upload} />

          <Separator className="bg-white/5" />

          <div className="flex justify-end">
            <Button
              onClick={onContinue}
              className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
            >
              Continue to baseline
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

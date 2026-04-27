"use client";

/**
 * BaselineConfig — Step 2 of the audit flow.
 *
 * The user splits the dataset's columns into THREE buckets:
 *   - Legitimate factors  (SHOULD influence the model's decision)
 *   - Protected attrs     (must NOT influence the decision)
 *   - Unassigned          (everything starts here)
 *
 * Plus a single Target column (the prediction target — has to stay outside
 * both buckets).
 *
 * "Ask Gemini for advice" hits /api/baseline-advisory and badges every
 * column with its recommendation:
 *   - green check    -> legitimate
 *   - red shield     -> protected
 *   - amber warning  -> requires_judgment OR proxy_risk == "high"
 *
 * Reasoning is shown via native `title` tooltip on the icon (we don't have
 * shadcn Tooltip installed yet — the alt-text path is the lightweight win).
 *
 * On Confirm, validates client-side, calls /api/configure-baseline, and
 * advances the parent's step machine via onConfirmed.
 */

import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Shield,
  ShieldAlert,
  Sparkles,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, configureBaseline, getBaselineAdvisory } from "@/lib/api";
import type {
  BaselineAdvisory,
  ColumnInfo,
  UploadResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Bucket = "unassigned" | "legitimate" | "protected";

export interface BaselineConfirmedPayload {
  legitimate_factors: string[];
  protected_attributes: string[];
  target_column: string;
  scenario_hint: string;
}

interface BaselineConfigProps {
  upload: UploadResponse;
  onConfirmed: (payload: BaselineConfirmedPayload) => void;
}

export function BaselineConfig({ upload, onConfirmed }: BaselineConfigProps) {
  const [scenario, setScenario] = useState(
    "hiring decisions for software engineering candidates",
  );
  const [buckets, setBuckets] = useState<Record<string, Bucket>>(() =>
    Object.fromEntries(
      upload.columns.map((c) => [c.name, "unassigned" as Bucket]),
    ),
  );
  const [target, setTarget] = useState<string>("");
  const [advisories, setAdvisories] = useState<
    Record<string, BaselineAdvisory>
  >({});
  const [advisoryError, setAdvisoryError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [askingGemini, setAskingGemini] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const { unassigned, legitimate, protectedCols } = useMemo(() => {
    const unassigned: ColumnInfo[] = [];
    const legitimate: ColumnInfo[] = [];
    const protectedCols: ColumnInfo[] = [];
    for (const col of upload.columns) {
      const b = buckets[col.name] ?? "unassigned";
      if (col.name === target) continue;
      if (b === "legitimate") legitimate.push(col);
      else if (b === "protected") protectedCols.push(col);
      else unassigned.push(col);
    }
    return { unassigned, legitimate, protectedCols };
  }, [buckets, target, upload.columns]);

  function moveTo(colName: string, bucket: Bucket) {
    setConfirmError(null);
    if (colName === target && bucket !== "unassigned") {
      setTarget("");
    }
    setBuckets((prev) => ({ ...prev, [colName]: bucket }));
  }

  function setTargetColumn(colName: string | null) {
    setConfirmError(null);
    if (!colName) {
      setTarget("");
      return;
    }
    setBuckets((prev) =>
      prev[colName] === "unassigned" ? prev : { ...prev, [colName]: "unassigned" },
    );
    setTarget(colName);
  }

  async function askGemini() {
    setAskingGemini(true);
    setAdvisoryError(null);
    try {
      const list = await getBaselineAdvisory(upload.session_id, scenario);
      setAdvisories(Object.fromEntries(list.map((a) => [a.column, a])));
    } catch (e) {
      setAdvisoryError(
        e instanceof ApiError ? e.message : "Could not fetch Gemini advisory.",
      );
    } finally {
      setAskingGemini(false);
    }
  }

  function acceptAllRecommendations() {
    setBuckets((prev) => {
      const next = { ...prev };
      for (const adv of Object.values(advisories)) {
        // Skip the target column so we don't accidentally bucket it.
        if (adv.column === target) continue;
        if (adv.recommendation === "legitimate") next[adv.column] = "legitimate";
        else if (adv.recommendation === "protected") next[adv.column] = "protected";
        // requires_judgment: leave the user to decide.
      }
      return next;
    });
  }

  async function handleConfirm() {
    setConfirmError(null);
    if (legitimate.length === 0)
      return setConfirmError("Add at least one legitimate factor.");
    if (protectedCols.length === 0)
      return setConfirmError("Add at least one protected attribute.");
    if (!target) return setConfirmError("Pick a target column.");

    setConfirming(true);
    try {
      await configureBaseline({
        session_id: upload.session_id,
        legitimate_factors: legitimate.map((c) => c.name),
        protected_attributes: protectedCols.map((c) => c.name),
        target_column: target,
      });
      onConfirmed({
        legitimate_factors: legitimate.map((c) => c.name),
        protected_attributes: protectedCols.map((c) => c.name),
        target_column: target,
        scenario_hint: scenario,
      });
    } catch (e) {
      setConfirmError(
        e instanceof ApiError ? e.message : "Failed to save baseline.",
      );
    } finally {
      setConfirming(false);
    }
  }

  const adviceCount = Object.keys(advisories).length;

  return (
    <div className="space-y-6">
      {/* ---------- Gemini ask card ---------- */}
      <Card className="border-white/5 bg-card">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-zinc-100">
            Configure business-necessity baseline
          </CardTitle>
          <CardDescription className="text-zinc-400">
            Decide which columns SHOULD influence the model&rsquo;s decision
            (legitimate) and which must NOT (protected). Gemini can suggest
            an initial split — accept it, override it, or build from scratch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label
                htmlFor="scenario"
                className="text-xs font-semibold uppercase tracking-wider text-zinc-500"
              >
                Decision scenario
              </Label>
              <Input
                id="scenario"
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                placeholder="e.g. hiring decisions, loan approvals"
                className="border-white/10 bg-white/5 text-zinc-100 placeholder:text-zinc-500 focus-visible:border-[#6366F1] focus-visible:ring-0"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={askGemini}
                disabled={askingGemini}
                className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
              >
                {askingGemini ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Thinking…
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    {adviceCount > 0 ? "Re-ask Gemini" : "Ask Gemini for advice"}
                  </>
                )}
              </Button>
              {adviceCount > 0 ? (
                <Button
                  variant="outline"
                  onClick={acceptAllRecommendations}
                  className="border-white/10 bg-transparent text-zinc-200 hover:bg-white/5 hover:text-white"
                >
                  Accept all
                </Button>
              ) : null}
            </div>
          </div>

          {advisoryError ? (
            <ErrorAlert>{advisoryError}</ErrorAlert>
          ) : adviceCount > 0 ? (
            <p className="mt-3 text-xs text-zinc-500">
              Got {adviceCount} advisories. Hover any column&rsquo;s icon to
              read Gemini&rsquo;s reasoning.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------- Unassigned bucket ---------- */}
      {unassigned.length > 0 ? (
        <Card className="border-white/5 bg-card">
          <CardHeader className="flex flex-row items-baseline justify-between">
            <div>
              <CardTitle className="text-base font-semibold text-zinc-100">
                Unassigned
              </CardTitle>
              <CardDescription className="text-zinc-400">
                Send each column left (legitimate) or right (protected).
              </CardDescription>
            </div>
            <span className="font-mono text-xs font-medium text-zinc-500">
              {unassigned.length} of {upload.columns.length}
            </span>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {unassigned.map((col) => (
                <ColumnChip
                  key={col.name}
                  col={col}
                  advisory={advisories[col.name]}
                  variant="unassigned"
                  onMoveLeft={() => moveTo(col.name, "legitimate")}
                  onMoveRight={() => moveTo(col.name, "protected")}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------- Two-column legit / protected ---------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <BucketCard
          title="Legitimate factors"
          subtitle="Columns the model is allowed to use."
          accent="emerald"
          count={legitimate.length}
          empty="Click columns above to add them here."
        >
          <div className="flex flex-wrap gap-2">
            {legitimate.map((col) => (
              <ColumnChip
                key={col.name}
                col={col}
                advisory={advisories[col.name]}
                variant="legitimate"
                onMoveRight={() => moveTo(col.name, "protected")}
                onRemove={() => moveTo(col.name, "unassigned")}
              />
            ))}
          </div>
        </BucketCard>

        <BucketCard
          title="Protected attributes"
          subtitle="Columns the model must NOT rely on."
          accent="rose"
          count={protectedCols.length}
          empty="Click columns above to add them here."
        >
          <div className="flex flex-wrap gap-2">
            {protectedCols.map((col) => (
              <ColumnChip
                key={col.name}
                col={col}
                advisory={advisories[col.name]}
                variant="protected"
                onMoveLeft={() => moveTo(col.name, "legitimate")}
                onRemove={() => moveTo(col.name, "unassigned")}
              />
            ))}
          </div>
        </BucketCard>
      </div>

      {/* ---------- Target column ---------- */}
      <Card className="border-white/5 bg-card">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-zinc-100">
            Target column
          </CardTitle>
          <CardDescription className="text-zinc-400">
            What the model is trained to predict. Cannot also be in either
            bucket.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={target} onValueChange={setTargetColumn}>
            <SelectTrigger className="w-full max-w-md border-white/10 bg-white/5 text-zinc-100 focus:ring-0 focus:ring-offset-0">
              <SelectValue placeholder="Select target column…" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-[#141416] text-zinc-100">
              {upload.columns.map((col) => (
                <SelectItem
                  key={col.name}
                  value={col.name}
                  className="font-mono text-sm focus:bg-white/5 focus:text-white"
                >
                  {col.name}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-500">
                    {col.dtype}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* ---------- Confirm row ---------- */}
      {confirmError ? <ErrorAlert>{confirmError}</ErrorAlert> : null}

      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          <span className="font-mono text-zinc-300">{legitimate.length}</span>{" "}
          legitimate &middot;{" "}
          <span className="font-mono text-zinc-300">
            {protectedCols.length}
          </span>{" "}
          protected &middot;{" "}
          <span className="font-mono text-zinc-300">{target || "—"}</span>{" "}
          target
        </p>
        <Button
          onClick={handleConfirm}
          disabled={confirming}
          className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
        >
          {confirming ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              Confirm baseline
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------- BucketCard ------------------------------------------------------

interface BucketCardProps {
  title: string;
  subtitle: string;
  accent: "emerald" | "rose";
  count: number;
  empty: string;
  children: React.ReactNode;
}

function BucketCard({
  title,
  subtitle,
  accent,
  count,
  empty,
  children,
}: BucketCardProps) {
  const accentClasses =
    accent === "emerald"
      ? "border-emerald-400/20 from-emerald-500/[0.04] to-transparent"
      : "border-rose-400/20 from-rose-500/[0.04] to-transparent";
  const dotClass =
    accent === "emerald" ? "bg-emerald-400" : "bg-rose-400";

  return (
    <Card
      className={cn(
        "border bg-gradient-to-b text-zinc-100",
        accentClasses,
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={cn("h-2 w-2 rounded-full", dotClass)} />
            <CardTitle className="text-base font-semibold text-zinc-100">
              {title}
            </CardTitle>
          </div>
          <span className="font-mono text-xs font-medium text-zinc-500">
            {count}
          </span>
        </div>
        <CardDescription className="text-zinc-400">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <p className="rounded-md border border-dashed border-white/10 bg-white/[0.02] px-3 py-6 text-center text-sm text-zinc-500">
            {empty}
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

// ---------- ColumnChip ------------------------------------------------------

interface ColumnChipProps {
  col: ColumnInfo;
  advisory?: BaselineAdvisory;
  variant: Bucket;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onRemove?: () => void;
}

function ColumnChip({
  col,
  advisory,
  variant,
  onMoveLeft,
  onMoveRight,
  onRemove,
}: ColumnChipProps) {
  const variantClasses =
    variant === "legitimate"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
      : variant === "protected"
        ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
        : "border-white/10 bg-white/[0.04] text-zinc-100";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors",
        variantClasses,
      )}
    >
      <AdvisoryIcon advisory={advisory} />
      <span className="font-mono text-sm font-medium">{col.name}</span>
      <span className="hidden font-mono text-[10px] uppercase tracking-wider text-zinc-500 sm:inline">
        {col.dtype}
      </span>

      {variant === "unassigned" ? (
        <span className="ml-1 flex items-center gap-1 border-l border-white/10 pl-2">
          <ChipAction
            label="Move to legitimate"
            onClick={onMoveLeft}
            tone="emerald"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Legit
          </ChipAction>
          <ChipAction
            label="Move to protected"
            onClick={onMoveRight}
            tone="rose"
          >
            Protected
            <ArrowRight className="h-3.5 w-3.5" />
          </ChipAction>
        </span>
      ) : null}

      {variant === "legitimate" && onMoveRight ? (
        <ChipAction
          label="Move to protected"
          onClick={onMoveRight}
          tone="rose"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </ChipAction>
      ) : null}
      {variant === "protected" && onMoveLeft ? (
        <ChipAction
          label="Move to legitimate"
          onClick={onMoveLeft}
          tone="emerald"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </ChipAction>
      ) : null}
      {variant !== "unassigned" && onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Unassign"
          className="ml-0.5 rounded p-0.5 text-zinc-400 hover:bg-white/5 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

interface ChipActionProps {
  label: string;
  onClick?: () => void;
  tone: "emerald" | "rose";
  children: React.ReactNode;
}

function ChipAction({ label, onClick, tone, children }: ChipActionProps) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
        tone === "emerald"
          ? "text-emerald-300 hover:bg-emerald-400/10"
          : "text-rose-300 hover:bg-rose-400/10",
      )}
    >
      {children}
    </button>
  );
}

// ---------- AdvisoryIcon ----------------------------------------------------

function AdvisoryIcon({ advisory }: { advisory?: BaselineAdvisory }) {
  if (!advisory) return null;
  const { recommendation, proxy_risk, reasoning } = advisory;

  if (recommendation === "requires_judgment" || proxy_risk === "high") {
    return (
      <span title={`Requires judgment — ${reasoning}`}>
        <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden />
      </span>
    );
  }
  if (recommendation === "protected") {
    return (
      <span title={`Suggested protected — ${reasoning}`}>
        <Shield className="h-4 w-4 text-rose-400" aria-hidden />
      </span>
    );
  }
  return (
    <span title={`Suggested legitimate — ${reasoning}`}>
      <Check className="h-4 w-4 text-emerald-400" aria-hidden />
    </span>
  );
}

// ---------- ErrorAlert ------------------------------------------------------

function ErrorAlert({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm font-medium text-red-300"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

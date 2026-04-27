"use client";

/**
 * ConnectionBanner — pings GET /api/health on mount and every 8s while down.
 *
 * Shows a sticky red banner at the top of the page when the backend is
 * unreachable, hides itself the moment the next ping succeeds. The poll
 * keeps the user from staring at a phantom error after they restart the
 * dev server.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { pingHealth } from "@/lib/api";

const POLL_MS = 8000;

export function ConnectionBanner() {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  async function check(signal?: AbortSignal) {
    setChecking(true);
    const ok = await pingHealth(signal);
    if (signal?.aborted) return;
    setReachable(ok);
    setChecking(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const id = window.setInterval(() => {
      if (reachable === false) void check(controller.signal);
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(id);
    };
    // We poll only when down; the polling closure reads the latest `reachable`
    // through closure capture, so we re-run the effect when that flips.
  }, [reachable]);

  if (reachable !== false) return null;

  return (
    <div className="sticky top-0 z-50 border-b border-rose-500/30 bg-rose-500/10 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <div className="flex items-start gap-2 text-sm text-rose-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
          <div>
            <p className="font-semibold">CounterProbe API is unreachable.</p>
            <p className="text-rose-200/80">
              Start the backend with{" "}
              <code className="rounded bg-rose-500/20 px-1 py-0.5 font-mono text-[12px]">
                uvicorn app.main:app --reload --port 8000
              </code>{" "}
              and we&rsquo;ll reconnect automatically.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void check()}
          disabled={checking}
          className="shrink-0 border-rose-400/40 bg-transparent text-rose-100 hover:bg-rose-500/20"
        >
          <RefreshCcw
            className={`mr-1.5 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
          />
          Retry
        </Button>
      </div>
    </div>
  );
}

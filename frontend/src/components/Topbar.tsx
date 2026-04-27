"use client";

/**
 * Topbar — global header bar with brand + Start Over.
 *
 * Replaces the previous sidebar so the audit content can use the full page
 * width (CVE cards + comparison table breathe a lot more).
 *
 * "Start over" reloads the page rather than threading callbacks through
 * React context — every step's state is local component state, so a reload
 * is the simplest way to nuke it without leaking the reset action across
 * server/client component boundaries.
 */

import Image from "next/image";
import Link from "next/link";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

export function Topbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-[#0A0A0B]/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link
          href="/audit"
          className="flex items-center gap-3 rounded-md py-1 transition-opacity hover:opacity-90"
        >
          <Image
            src="/icon.png"
            alt="CounterProbe"
            width={36}
            height={36}
            priority
            className="h-9 w-9 rounded-md object-contain"
          />
          <span className="flex flex-col leading-tight">
            <span className="text-base font-bold tracking-tight text-zinc-100 sm:text-lg">
              CounterProbe
            </span>
            <span className="hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 sm:block">
              Adversarial fairness
            </span>
          </span>
        </Link>

        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
          className="shrink-0 border-white/10 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          <span className="hidden sm:inline">Start over</span>
          <span className="sm:hidden">Reset</span>
        </Button>
      </div>
    </header>
  );
}

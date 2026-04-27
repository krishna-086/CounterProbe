"use client";

/**
 * Root route — bounces visitors to /audit.
 *
 * `redirect()` from `next/navigation` and the `redirects` config option are
 * both unsupported with `output: "export"`, so this is a client-side hop.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/audit");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
      <p>Loading CounterProbe…</p>
    </div>
  );
}

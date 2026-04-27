"use client";

/**
 * DataPreview — column profile table + first-five-rows preview.
 *
 * Reads the UploadResponse the backend returned (no extra fetches). Cells use
 * the mono font for tabular density; dtype gets a colored badge so numeric vs
 * categorical vs text is scannable at a glance.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { UploadResponse } from "@/lib/types";

const DTYPE_BADGE: Record<string, string> = {
  numeric: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  categorical: "border-indigo-400/30 bg-indigo-400/10 text-indigo-300",
  text: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300",
};

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return String(value);
}

interface DataPreviewProps {
  data: UploadResponse;
}

export function DataPreview({ data }: DataPreviewProps) {
  const previewColumns = data.columns.map((c) => c.name);

  return (
    <div className="space-y-6">
      <Card className="border-white/5 bg-card">
        <CardHeader className="flex flex-row items-baseline justify-between">
          <div className="space-y-1">
            <CardTitle className="text-xl font-semibold text-zinc-100">
              Dataset profile
            </CardTitle>
            <p className="text-sm text-zinc-400">
              {data.row_count.toLocaleString()} rows &middot;{" "}
              {data.columns.length} columns
            </p>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-y border-white/5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  <th className="px-6 py-3">Column</th>
                  <th className="px-6 py-3">Type</th>
                  <th className="px-6 py-3 text-right">Unique</th>
                  <th className="px-6 py-3 text-right">Null %</th>
                  <th className="px-6 py-3">Sample values</th>
                </tr>
              </thead>
              <tbody>
                {data.columns.map((col, idx) => (
                  <tr
                    key={col.name}
                    className={cn(
                      "border-b border-white/5",
                      idx % 2 === 1 && "bg-white/[0.02]",
                    )}
                  >
                    <td className="px-6 py-3 font-mono text-sm font-medium text-zinc-100">
                      {col.name}
                    </td>
                    <td className="px-6 py-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-[11px] font-medium uppercase tracking-wider",
                          DTYPE_BADGE[col.dtype] ??
                            "border-white/10 bg-transparent text-zinc-400",
                        )}
                      >
                        {col.dtype}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-right font-mono text-zinc-200">
                      {col.unique_count.toLocaleString()}
                    </td>
                    <td className="px-6 py-3 text-right font-mono text-zinc-200">
                      {col.null_pct.toFixed(1)}%
                    </td>
                    <td className="px-6 py-3 font-mono text-xs text-zinc-400">
                      {col.sample_values
                        .slice(0, 4)
                        .map((v) => renderCell(v))
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="border-white/5 bg-card">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-zinc-100">
            Preview
          </CardTitle>
          <p className="text-sm text-zinc-400">First 5 rows</p>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-y border-white/5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {previewColumns.map((name) => (
                    <th key={name} className="px-6 py-3 whitespace-nowrap">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.preview.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className={cn(
                      "border-b border-white/5",
                      rowIdx % 2 === 1 && "bg-white/[0.02]",
                    )}
                  >
                    {previewColumns.map((name) => (
                      <td
                        key={name}
                        className="px-6 py-3 font-mono text-xs text-zinc-200 whitespace-nowrap"
                      >
                        {renderCell(row[name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

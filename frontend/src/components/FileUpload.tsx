"use client";

/**
 * FileUpload — drag-and-drop or click-to-browse CSV picker.
 *
 * Validates extension client-side (the backend does authoritative validation
 * for size/rows/columns and returns 400s with detail messages we surface).
 * Calls api.uploadCSV() and hands the parsed UploadResponse to the parent
 * via onUploaded — the parent owns post-upload state (session_id + preview).
 */

import { useRef, useState } from "react";
import { AlertCircle, Loader2, Sparkles, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError, downloadDemoCSV, uploadCSV } from "@/lib/api";
import type { UploadResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FileUploadProps {
  onUploaded: (response: UploadResponse) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileUpload({ onUploaded }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectFile(picked: File) {
    setError(null);
    if (!picked.name.toLowerCase().endsWith(".csv")) {
      setError("Only .csv files are supported.");
      return;
    }
    setFile(picked);
  }

  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const response = await uploadCSV(file);
      onUploaded(response);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Upload failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoData() {
    setDemoLoading(true);
    setError(null);
    try {
      const demoFile = await downloadDemoCSV();
      const response = await uploadCSV(demoFile);
      onUploaded(response);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Couldn't load the sample dataset.",
      );
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) selectFile(dropped);
        }}
        className={cn(
          "rounded-lg border-2 border-dashed p-10 text-center transition-colors",
          isDragging
            ? "border-[#6366F1] bg-[#6366F1]/5"
            : "border-white/10 bg-card hover:border-white/20",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) selectFile(picked);
            e.target.value = ""; // allow re-picking the same file
          }}
        />

        {file ? (
          <div className="space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-[#6366F1]/10 text-[#6366F1]">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <p className="font-mono text-sm text-zinc-100">{file.name}</p>
              <p className="text-xs font-medium text-zinc-500">
                {formatBytes(file.size)}
              </p>
            </div>
            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => inputRef.current?.click()}
                disabled={loading}
                className="border-white/10 bg-transparent text-zinc-200 hover:bg-white/5 hover:text-white"
              >
                Choose a different file
              </Button>
              <Button
                onClick={handleUpload}
                disabled={loading}
                className="bg-[#6366F1] font-semibold text-white hover:bg-[#6366F1]/90"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  "Upload & analyze"
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-white/5 text-zinc-400">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-medium text-zinc-100">
                Drop your CSV here
              </p>
              <p className="text-sm text-zinc-400">
                or click to browse from your computer
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => inputRef.current?.click()}
              className="border-white/10 bg-transparent text-zinc-200 hover:bg-white/5 hover:text-white"
            >
              Choose file
            </Button>
            <p className="text-xs font-medium text-zinc-600">
              CSV, max 10 MB &middot; 50,000 rows &middot; 50 columns
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-500">
        <span>No CSV handy?</span>
        <button
          type="button"
          onClick={handleDemoData}
          disabled={demoLoading || loading}
          className="inline-flex items-center gap-1.5 font-medium text-[#A5B4FC] transition-colors hover:text-[#C7D2FE] disabled:opacity-50"
        >
          {demoLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Try with sample hiring data
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm font-medium text-red-300"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

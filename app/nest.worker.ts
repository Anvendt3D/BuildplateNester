/// <reference lib="webworker" />
import { NestRequest, nestParts } from "./nest-engine";

let cancelled = false;
self.onmessage = async (event: MessageEvent<{ type: "start"; request: NestRequest; jobId?: string } | { type: "cancel"; jobId?: string }>) => {
  if (event.data.type === "cancel") { cancelled = true; return; }
  cancelled = false;
  const jobId = event.data.jobId;
  try {
    const result = await nestParts(event.data.request, {
      shouldCancel: () => cancelled,
      onProgress: (progress) => self.postMessage({ type: "progress", progress, jobId }),
    });
    self.postMessage({ type: "result", result, jobId });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Nesting failed.", jobId });
  }
};

export {};

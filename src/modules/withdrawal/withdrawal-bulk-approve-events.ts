import type { Response } from "express";
import type { WithdrawalBulkApproveJobStatus } from "./withdrawal-bulk-approve-job.model";

type WithdrawalBulkApproveEventPayload = {
  jobId: string;
  status: WithdrawalBulkApproveJobStatus;
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  message?: string;
};

const clientsByJobId = new Map<string, Set<Response>>();

function writeSse(res: Response, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function subscribeWithdrawalBulkApproveEvents(jobId: string, res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const group = clientsByJobId.get(jobId) ?? new Set<Response>();
  group.add(res);
  clientsByJobId.set(jobId, group);
  writeSse(res, "connected", { jobId });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  res.on("close", () => {
    clearInterval(heartbeat);
    const existing = clientsByJobId.get(jobId);
    if (!existing) return;
    existing.delete(res);
    if (existing.size === 0) {
      clientsByJobId.delete(jobId);
    }
  });
}

export function emitWithdrawalBulkApproveEvent(payload: WithdrawalBulkApproveEventPayload) {
  const group = clientsByJobId.get(payload.jobId);
  if (!group || group.size === 0) return;
  for (const client of group) {
    writeSse(client, "progress", payload);
  }
}

export function closeWithdrawalBulkApproveEventStream(jobId: string) {
  const group = clientsByJobId.get(jobId);
  if (!group) return;
  for (const client of group) {
    client.end();
  }
  clientsByJobId.delete(jobId);
}

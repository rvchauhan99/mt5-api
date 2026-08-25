import type { Response } from "express";

type ApprovalModule = "deposit" | "withdrawal";
type ApprovalView = "banker" | "exchange";

type ApprovalQueueEventPayload = {
  module: ApprovalModule;
  view: ApprovalView;
  changedAt: string;
};

const clientsByChannel = new Map<string, Set<Response>>();

function channelKey(module: ApprovalModule, view: ApprovalView): string {
  return `${module}:${view}`;
}

function writeSse(res: Response, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function subscribeApprovalQueueEvents(module: ApprovalModule, view: ApprovalView, res: Response) {
  const key = channelKey(module, view);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const group = clientsByChannel.get(key) ?? new Set<Response>();
  group.add(res);
  clientsByChannel.set(key, group);
  writeSse(res, "connected", { module, view });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  res.on("close", () => {
    clearInterval(heartbeat);
    const existing = clientsByChannel.get(key);
    if (!existing) return;
    existing.delete(res);
    if (existing.size === 0) {
      clientsByChannel.delete(key);
    }
  });
}

export function emitApprovalQueueEvent(module: ApprovalModule, view: ApprovalView) {
  const key = channelKey(module, view);
  const group = clientsByChannel.get(key);
  if (!group || group.size === 0) return;

  const payload: ApprovalQueueEventPayload = {
    module,
    view,
    changedAt: new Date().toISOString(),
  };
  for (const client of group) {
    writeSse(client, "pending_update", payload);
  }
}

import { Queue, Worker, type JobsOptions } from "bullmq";
import { env } from "../../config/env";
import { getRedisQueueClient } from "../cache/redis";
import { logger } from "../logger";
import { recomputeExchangeCurrentBalance } from "../../modules/exchange/exchange.service";

type ExchangeRecomputeJob = {
  exchangeId: string;
};

const QUEUE_NAME = "exchange-balance-recompute";
let queue: Queue<ExchangeRecomputeJob> | null = null;
let worker: Worker<ExchangeRecomputeJob> | null = null;

function getQueue(): Queue<ExchangeRecomputeJob> | null {
  if (!env.redisUrl) return null;
  if (!queue) {
    const connection = getRedisQueueClient();
    if (!connection) return null;
    queue = new Queue<ExchangeRecomputeJob>(QUEUE_NAME, { connection });
  }
  return queue;
}

export async function enqueueExchangeRecompute(exchangeId: string): Promise<void> {
  const q = getQueue();
  if (!q) {
    await recomputeExchangeCurrentBalance(exchangeId);
    return;
  }
  const opts: JobsOptions = {
    jobId: `exchange-recompute-${exchangeId}`,
    removeOnComplete: 1000,
    removeOnFail: 2000,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  };
  await q.add("recompute", { exchangeId }, opts);
}

export function startQueueWorkers() {
  if (!env.redisUrl || worker) return;
  const connection = getRedisQueueClient();
  if (!connection) return;
  worker = new Worker<ExchangeRecomputeJob>(
    QUEUE_NAME,
    async (job) => {
      await recomputeExchangeCurrentBalance(job.data.exchangeId);
    },
    { connection, concurrency: 8 },
  );
  worker.on("failed", (job, err) => {
    logger.error({ queue: QUEUE_NAME, jobId: job?.id, err }, "Queue job failed");
  });
}

export async function stopQueueWorkers() {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}

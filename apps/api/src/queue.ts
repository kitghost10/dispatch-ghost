/**
 * Background jobs. With REDIS_URL, jobs go through BullMQ (retries, backoff,
 * survives restarts; run `worker.ts`). Without it (mock/dev), an in-process
 * queue runs them on a timer so the whole system works from one process.
 */
import { Queue, Worker, type ConnectionOptions } from "bullmq";

export type JobName = "sms.send" | "missed-call.textback" | "booking.sync" | "callbacks.sweep";

export interface JobQueue {
  enqueue(name: JobName, data: Record<string, unknown>, opts?: { delayMs?: number; jobId?: string }): Promise<void>;
  /** Wait for in-flight inline jobs (tests). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export type Processor = (name: JobName, data: Record<string, unknown>) => Promise<void>;

export class InlineQueue implements JobQueue {
  private pending = new Set<Promise<void>>();
  private seen = new Set<string>();
  constructor(private readonly processor: () => Processor, private readonly onError: (err: unknown, name: JobName) => void) {}

  async enqueue(name: JobName, data: Record<string, unknown>, opts: { delayMs?: number; jobId?: string } = {}) {
    if (opts.jobId) {
      if (this.seen.has(opts.jobId)) return;
      this.seen.add(opts.jobId);
    }
    const run = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.processor()(name, data)
          .catch((err) => this.onError(err, name))
          .finally(resolve);
      }, opts.delayMs ?? 0);
    });
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async close() {
    await this.drain();
  }
}

export const QUEUE_NAME = "sonicbold-jobs";

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export class BullQueue implements JobQueue {
  private readonly queue: Queue;
  constructor(redisUrl: string) {
    this.queue = new Queue(QUEUE_NAME, { connection: redisConnection(redisUrl) });
  }
  async enqueue(name: JobName, data: Record<string, unknown>, opts: { delayMs?: number; jobId?: string } = {}) {
    await this.queue.add(name, data, {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
    });
  }
  async drain() {}
  /** Repeatable sweep (one schedule cluster-wide, deduped by BullMQ). */
  async scheduleSweep(everyMs = 60_000) {
    await this.queue.upsertJobScheduler("callbacks-sweep", { every: everyMs }, { name: "callbacks.sweep", data: { tenantId: "*" } });
  }
  async close() {
    await this.queue.close();
  }
}

export function startBullWorker(redisUrl: string, processor: Processor, concurrency = 10): Worker {
  return new Worker(QUEUE_NAME, async (job) => processor(job.name as JobName, job.data as Record<string, unknown>), {
    connection: redisConnection(redisUrl),
    concurrency,
  });
}

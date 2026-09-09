import 'dotenv/config';
import { validateEnvironment } from './services/env.server.js';
import { claimNextJob, executeJob, failJob, recoverStaleJobs } from './services/job-queue.server.js';

validateEnvironment();

let isRunning = true;

/**
 * Runs a single cycle of job processing.
 * Returns true if a job was found and processed, false if queue was empty.
 */
export async function runWorkerOnce(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) {
    return false;
  }

  try {
    await executeJob(job);
    return true;
  } catch (err: any) {
    console.error(`[Worker] Job ${job.id} (${job.type}) failed:`, err.message);
    await failJob(job, err);
    return true;
  }
}

/**
 * Main worker loop for standalone execution.
 */
export async function startWorkerLoop(pollIntervalMs: number = 1000): Promise<void> {
  console.log('[Worker] Background job processor started.');

  // Periodically recover stale jobs every 5 minutes
  const recoveryInterval = setInterval(() => {
    recoverStaleJobs().catch((err) => {
      console.error('[Worker] Stale job recovery error:', err.message);
    });
  }, 5 * 60 * 1000);
  recoveryInterval.unref?.();

  while (isRunning) {
    try {
      const processed = await runWorkerOnce();
      if (!processed) {
        // Queue is empty, sleep for poll interval
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } catch (loopErr: any) {
      console.error('[Worker] Error in worker loop:', loopErr.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  clearInterval(recoveryInterval);
  console.log('[Worker] Worker stopped gracefully.');
}

export function stopWorker(): void {
  isRunning = false;
}

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('[Worker] SIGTERM received. Stopping worker...');
  stopWorker();
});

process.on('SIGINT', () => {
  console.log('[Worker] SIGINT received. Stopping worker...');
  stopWorker();
});

// Auto-start loop if executed directly as entrypoint
if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  startWorkerLoop().catch((err) => {
    console.error('[Worker] Fatal error starting worker:', err);
    process.exit(1);
  });
}

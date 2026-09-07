import { prisma } from '../db.js';
import { BackgroundJob } from '@prisma/client';
import { sanitizeErrorMessage } from './security.server.js';
import {
  syncProductSnapshot,
  deleteProductSnapshot,
  syncCollectionSnapshot,
  deleteCollectionSnapshot,
  executeFullShopSync,
  syncSingleCollectionFromShopify,
  reconcileSourcedCollectionsForShop,
} from './sync.server.js';

export enum JobType {
  PRODUCT_SYNC = 'PRODUCT_SYNC',
  COLLECTION_SYNC = 'COLLECTION_SYNC',
  FULL_SYNC = 'FULL_SYNC',
  RECONCILE_SUBMISSION = 'RECONCILE_SUBMISSION',
}

export interface EnqueueJobInput {
  type: JobType | string;
  shopId?: string | null;
  payload?: any;
  availableAt?: Date;
  maxAttempts?: number;
}

/**
 * Enqueues a lightweight background job into PostgreSQL.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<BackgroundJob> {
  return prisma.backgroundJob.create({
    data: {
      type: input.type,
      shopId: input.shopId || null,
      payloadJson: input.payload ? JSON.stringify(input.payload) : null,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: input.maxAttempts || 5,
      availableAt: input.availableAt || new Date(),
    },
  });
}

/**
 * Atomically claims the next pending job using PostgreSQL FOR UPDATE SKIP LOCKED.
 * Concurrency-safe across multiple worker processes or threads.
 */
export async function claimNextJob(): Promise<BackgroundJob | null> {
  const claimed = await prisma.$queryRaw<BackgroundJob[]>`
    UPDATE "BackgroundJob"
    SET "status" = 'PROCESSING',
        "lockedAt" = NOW(),
        "attempts" = "attempts" + 1,
        "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "BackgroundJob"
      WHERE "status" = 'PENDING' AND "availableAt" <= NOW()
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  return claimed.length > 0 ? claimed[0] : null;
}

/**
 * Marks job as successfully completed.
 */
export async function completeJob(jobId: string): Promise<void> {
  await prisma.backgroundJob
    .update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .catch(() => {});
}

/**
 * Records job failure with bounded exponential backoff or marks permanently FAILED.
 */
export async function failJob(job: BackgroundJob, error: any): Promise<void> {
  const errMsg = sanitizeErrorMessage(error).slice(0, 500);
  const willRetry = job.attempts < job.maxAttempts;

  if (willRetry) {
    // Exponential backoff: 5s, 10s, 20s, 40s... capped at 1 hour
    const backoffSeconds = Math.min(3600, Math.pow(2, job.attempts) * 5);
    const nextRun = new Date(Date.now() + backoffSeconds * 1000);

    await prisma.backgroundJob
      .update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          availableAt: nextRun,
          lastError: errMsg,
          updatedAt: new Date(),
        },
      })
      .catch(() => {});
  } else {
    // Maximum attempts reached: mark permanently FAILED (poison job circuit breaker)
    await prisma.backgroundJob
      .update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          lastError: `Max attempts (${job.maxAttempts}) reached. Last error: ${errMsg}`,
          updatedAt: new Date(),
        },
      })
      .catch(() => {});
  }
}

/**
 * Recovers stale jobs left in PROCESSING if a worker crashed unexpectedly.
 */
export async function recoverStaleJobs(staleThresholdMs: number = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const result = await prisma.backgroundJob.updateMany({
    where: {
      status: 'PROCESSING',
      lockedAt: { lt: cutoff },
    },
    data: {
      status: 'PENDING',
      updatedAt: new Date(),
    },
  });
  return result.count;
}

/**
 * Executes a single claimed background job.
 */
export async function executeJob(job: BackgroundJob): Promise<void> {
  // If job is associated with a shop, verify shop is active
  if (job.shopId) {
    const shop = await prisma.shop.findUnique({
      where: { id: job.shopId },
    });

    if (!shop || shop.uninstalledAt !== null) {
      // Shop was uninstalled: drop job safely without executing mutations
      await completeJob(job.id);
      return;
    }
  }

  const payload = job.payloadJson ? JSON.parse(job.payloadJson) : {};

  switch (job.type) {
    case JobType.PRODUCT_SYNC: {
      if (!job.shopId) throw new Error('PRODUCT_SYNC requires shopId');
      if (payload.action === 'delete') {
        await deleteProductSnapshot(job.shopId, payload.productId);
      } else {
        await syncProductSnapshot(job.shopId, payload.product);
        if (payload.topic === 'products/update') {
          await reconcileSourcedCollectionsForShop(job.shopId).catch(() => {});
        }
      }
      break;
    }

    case JobType.COLLECTION_SYNC: {
      if (!job.shopId) throw new Error('COLLECTION_SYNC requires shopId');
      if (payload.action === 'delete') {
        await deleteCollectionSnapshot(job.shopId, payload.collectionId);
      } else {
        await syncSingleCollectionFromShopify(job.shopId, payload.collectionId);
      }
      break;
    }

    case JobType.FULL_SYNC: {
      if (!job.shopId) throw new Error('FULL_SYNC requires shopId');
      await executeFullShopSync(job.shopId);
      break;
    }

    default:
      console.warn(`[JobQueue] Unknown job type: ${job.type}`);
  }

  await completeJob(job.id);
}

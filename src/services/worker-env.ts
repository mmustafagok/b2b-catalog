/**
 * Worker Environment Helper
 *
 * For the worker production process:
 * If WORKER_DATABASE_URL exists, assigns its value to process.env.DATABASE_URL
 * before PrismaClient is initialized.
 * Otherwise preserves normal DATABASE_URL behavior.
 */

export function applyWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.WORKER_DATABASE_URL) {
    env.DATABASE_URL = env.WORKER_DATABASE_URL;
  }
  return env.DATABASE_URL;
}

// Execute immediately upon module import
applyWorkerDatabaseUrl();

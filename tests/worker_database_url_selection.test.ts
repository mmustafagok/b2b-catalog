import { describe, it, expect } from 'vitest';
import { applyWorkerDatabaseUrl } from '../src/services/worker-env.js';
// @ts-expect-error migrate-production.mjs is a plain JavaScript ES module
import { selectDatabaseUrlSource, normalizeDbUrl } from '../scripts/migrate-production.mjs';

describe('Worker Database URL Environment Selection Regression Suite', () => {
  describe('applyWorkerDatabaseUrl (src/services/worker-env.ts)', () => {
    it('assigns WORKER_DATABASE_URL to DATABASE_URL when present', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        DATABASE_URL: 'postgresql://original:pass@host1:5432/db1',
        WORKER_DATABASE_URL: 'postgresql://worker:pass@host2:5432/db2',
      };

      const result = applyWorkerDatabaseUrl(mockEnv);

      expect(mockEnv.DATABASE_URL).toBe('postgresql://worker:pass@host2:5432/db2');
      expect(result).toBe('postgresql://worker:pass@host2:5432/db2');
    });

    it('preserves existing DATABASE_URL when WORKER_DATABASE_URL is not set', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        DATABASE_URL: 'postgresql://original:pass@host1:5432/db1',
      };

      const result = applyWorkerDatabaseUrl(mockEnv);

      expect(mockEnv.DATABASE_URL).toBe('postgresql://original:pass@host1:5432/db1');
      expect(result).toBe('postgresql://original:pass@host1:5432/db1');
    });

    it('handles empty/undefined initial DATABASE_URL safely when WORKER_DATABASE_URL is set', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        WORKER_DATABASE_URL: 'postgresql://worker:pass@host2:5432/db2',
      };

      const result = applyWorkerDatabaseUrl(mockEnv);

      expect(mockEnv.DATABASE_URL).toBe('postgresql://worker:pass@host2:5432/db2');
      expect(result).toBe('postgresql://worker:pass@host2:5432/db2');
    });
  });

  describe('selectDatabaseUrlSource (scripts/migrate-production.mjs)', () => {
    it('selects WORKER_DATABASE_URL when present in environment', () => {
      const mockEnv: Record<string, string | undefined> = {
        DATABASE_URL: 'postgresql://original:pass@host1:5432/db1',
        WORKER_DATABASE_URL: 'postgresql://worker:pass@host2:5432/db2',
      };

      const source = selectDatabaseUrlSource(mockEnv);
      expect(source).toBe('WORKER_DATABASE_URL');
      expect(mockEnv[source]).toBe('postgresql://worker:pass@host2:5432/db2');
    });

    it('falls back to DATABASE_URL when WORKER_DATABASE_URL is absent', () => {
      const mockEnv: Record<string, string | undefined> = {
        DATABASE_URL: 'postgresql://original:pass@host1:5432/db1',
      };

      const source = selectDatabaseUrlSource(mockEnv);
      expect(source).toBe('DATABASE_URL');
      expect(mockEnv[source]).toBe('postgresql://original:pass@host1:5432/db1');
    });

    it('normalizes stripped protocol on selected WORKER_DATABASE_URL for Prisma child env', () => {
      const mockEnv: Record<string, string | undefined> = {
        WORKER_DATABASE_URL: '//worker-user:worker-pass@ep-hostless.internal:5432/prod_db?sslmode=require',
      };

      const source = selectDatabaseUrlSource(mockEnv);
      const raw = mockEnv[source];
      const normalized = normalizeDbUrl(raw);

      expect(source).toBe('WORKER_DATABASE_URL');
      expect(normalized).toBe('postgresql://worker-user:worker-pass@ep-hostless.internal:5432/prod_db?sslmode=require');

      const childEnv = { ...mockEnv, DATABASE_URL: normalized };
      expect(childEnv.DATABASE_URL).toBe(normalized);
    });
  });
});

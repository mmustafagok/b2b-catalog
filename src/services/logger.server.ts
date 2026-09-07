import { sanitizeForLogging } from './security.server.js';

export interface LogContext {
  requestId?: string;
  shopId?: string;
  shopDomain?: string;
  submissionId?: string;
  catalogId?: string;
  webhookId?: string;
  topic?: string;
  durationMs?: number;
  [key: string]: any;
}

export const logger = {
  info(message: string, context?: LogContext) {
    const sanitizedContext = context ? sanitizeForLogging(context) : undefined;
    if (process.env.NODE_ENV === 'production') {
      console.log(
        JSON.stringify({
          level: 'INFO',
          timestamp: new Date().toISOString(),
          message,
          ...sanitizedContext,
        })
      );
    } else {
      console.log(`[INFO] ${message}`, sanitizedContext || '');
    }
  },

  warn(message: string, context?: LogContext) {
    const sanitizedContext = context ? sanitizeForLogging(context) : undefined;
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        JSON.stringify({
          level: 'WARN',
          timestamp: new Date().toISOString(),
          message,
          ...sanitizedContext,
        })
      );
    } else {
      console.warn(`[WARN] ${message}`, sanitizedContext || '');
    }
  },

  error(message: string, error?: any, context?: LogContext) {
    const sanitizedContext = context ? sanitizeForLogging(context) : {};
    const errorDetails = error
      ? {
          errorMessage: error?.message || String(error),
          errorCode: error?.code,
          errorStatus: error?.statusCode || error?.status,
        }
      : {};

    if (process.env.NODE_ENV === 'production') {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          timestamp: new Date().toISOString(),
          message,
          ...errorDetails,
          ...sanitizedContext,
        })
      );
    } else {
      console.error(`[ERROR] ${message}`, errorDetails, sanitizedContext);
    }
  },
};

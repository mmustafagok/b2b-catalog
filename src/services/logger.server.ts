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
    const sanitizedMessage = typeof message === 'string' ? sanitizeForLogging(message) : message;
    const sanitizedContext = context ? sanitizeForLogging(context) : undefined;
    if (process.env.NODE_ENV === 'production') {
      console.log(
        JSON.stringify({
          level: 'INFO',
          timestamp: new Date().toISOString(),
          message: sanitizedMessage,
          ...sanitizedContext,
        })
      );
    } else {
      console.log(`[INFO] ${sanitizedMessage}`, sanitizedContext || '');
    }
  },

  warn(message: string, context?: LogContext) {
    const sanitizedMessage = typeof message === 'string' ? sanitizeForLogging(message) : message;
    const sanitizedContext = context ? sanitizeForLogging(context) : undefined;
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        JSON.stringify({
          level: 'WARN',
          timestamp: new Date().toISOString(),
          message: sanitizedMessage,
          ...sanitizedContext,
        })
      );
    } else {
      console.warn(`[WARN] ${sanitizedMessage}`, sanitizedContext || '');
    }
  },

  error(message: string, error?: any, context?: LogContext) {
    const sanitizedMessage = typeof message === 'string' ? sanitizeForLogging(message) : message;
    const sanitizedContext = context ? sanitizeForLogging(context) : {};

    let errorDetails: Record<string, any> = {};
    if (error) {
      if (typeof error === 'string') {
        errorDetails = { errorMessage: sanitizeForLogging(error) };
      } else if (error instanceof Error) {
        errorDetails = {
          errorMessage: sanitizeForLogging(error.message),
          errorCode: (error as any).code,
          errorStatus: (error as any).statusCode || (error as any).status,
          errorStack: error.stack ? sanitizeForLogging(error.stack) : undefined,
          errorCause: (error as any).cause ? sanitizeForLogging((error as any).cause) : undefined,
        };
      } else if (typeof error === 'object') {
        errorDetails = sanitizeForLogging(error);
      } else {
        errorDetails = { errorMessage: sanitizeForLogging(String(error)) };
      }
    }

    if (process.env.NODE_ENV === 'production') {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          timestamp: new Date().toISOString(),
          message: sanitizedMessage,
          ...errorDetails,
          ...sanitizedContext,
        })
      );
    } else {
      console.error(`[ERROR] ${sanitizedMessage}`, errorDetails, sanitizedContext);
    }
  },
};

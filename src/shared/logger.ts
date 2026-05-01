// packages/functions/src/shared/logger.ts

/**
 * @fileoverview Server-side logging utility with Sentry integration
 * @description Structured logging for server environments with Sentry integration
 *
 * Sentry Integration:
 * - Uses @sentry/node for backend error tracking
 * - Automatically detects if Sentry is installed
 * - Works with or without Sentry (graceful degradation)
 * - Consumer must install @sentry/node and set SENTRY_DSN env var
 *
 * Usage:
 * ```typescript
 * import { logger } from '../shared/logger.js';
 *
 * logger.info('Server started', { port: 3000 });
 * logger.error('Database connection failed', { error: err });
 * ```
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// ServerShim: Prevent client-side imports
if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
  throw new Error('Server logger cannot be imported on client side');
}

// ServerShim: Warn if not in Node.js (e.g., Deno) but don't throw — allow fallback logging
const _isNodeEnv = typeof process !== 'undefined' && !!process.versions?.node;

let sentryEnabled = false;
let sentryClient: any = null;

// Initialize Sentry lazily to avoid Firebase Functions issues
let sentryInitialized = false;

/**
 * Initialize Sentry if not already done
 * Called lazily to avoid Firebase Functions issues
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function initializeSentry(): Promise<void> {
  if (sentryInitialized) return;

  try {
    // Check if Sentry is available (consumer must install @sentry/node)
    const sentryDsn = process.env.SENTRY_DSN;
    if (sentryDsn) {
      // Dynamic import to avoid build errors if @sentry/node is not installed
      const { init, captureException, captureMessage } =
        await import('@sentry/node');

      init({
        dsn: sentryDsn,
        environment: process.env.NODE_ENV || 'development',
      });

      sentryClient = { captureException, captureMessage };
      sentryEnabled = true;
    }
  } catch (error) {
    // Sentry not available, continue without it
    sentryEnabled = false;
  } finally {
    sentryInitialized = true;
  }
}

/**
 * Log levels for structured logging
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

/**
 * Log entry interface for structured logging
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, any>;
  error?: Error;
  metadata?: Record<string, any>;
}

/**
 * Server-side logger with Sentry integration
 *
 * Features:
 * - Structured logging with context
 * - Automatic Sentry error reporting
 * - Performance monitoring
 * - Request correlation
 *
 * @example
 * ```typescript
 * import { logger } from '../shared/logger.js';
 *
 * // Basic logging
 * logger.info('Server started', { port: 3000 });
 *
 * // Error logging with Sentry
 * logger.error('Database error', { error: err, query: 'SELECT * FROM users' });
 *
 * // Performance logging
 * logger.info('Request completed', {
 *   duration: 150,
 *   status: 200,
 *   path: '/api/users'
 * });
 * ```
 */
export const logger = {
  /**
   * Log debug information
   * @param message - Log message
   * @param context - Additional context data
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  debug(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context);
  },

  /**
   * Log informational messages
   * @param message - Log message
   * @param context - Additional context data
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  info(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context);
  },

  /**
   * Log warning messages
   * @param message - Log message
   * @param context - Additional context data
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  warn(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, context);
  },

  /**
   * Log error messages with Sentry integration
   * @param message - Log message
   * @param context - Additional context data
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async error(message: string, context?: Record<string, any>): Promise<void> {
    this.log(LogLevel.ERROR, message, context);

    // Initialize Sentry lazily if needed
    if (!sentryInitialized) {
      await initializeSentry();
    }

    // Send to Sentry if available
    if (sentryEnabled && sentryClient) {
      try {
        if (context?.error instanceof Error) {
          sentryClient.captureException(context.error);
        } else {
          sentryClient.captureMessage(message, 'error');
        }
      } catch (sentryError) {
        // Don't let Sentry errors break logging
        console.error('Sentry error:', sentryError);
      }
    }
  },

  /**
   * Log fatal errors with Sentry integration
   * @param message - Log message
   * @param context - Additional context data
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async fatal(message: string, context?: Record<string, any>): Promise<void> {
    this.log(LogLevel.FATAL, message, context);

    // Initialize Sentry lazily if needed
    if (!sentryInitialized) {
      await initializeSentry();
    }

    // Send to Sentry if available
    if (sentryEnabled && sentryClient) {
      try {
        if (context?.error instanceof Error) {
          sentryClient.captureException(context.error);
        } else {
          sentryClient.captureMessage(message, 'fatal');
        }
      } catch (sentryError) {
        // Don't let Sentry errors break logging
        console.error('Sentry error:', sentryError);
      }
    }
  },

  /**
   * Core logging method
   * @param level - Log level
   * @param message - Log message
   * @param context - Additional context data
   *
   * @security Callers MUST NOT pass secrets (tokens, passwords, API keys) in context. Context is logged in plaintext.
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  log(level: LogLevel, message: string, context?: Record<string, any>): void {
    const timestamp = new Date().toISOString();
    const logEntry: LogEntry = {
      level,
      message,
      timestamp,
      context,
      error: context?.error,
      metadata: {
        ...(_isNodeEnv
          ? {
              pid: process.pid,
              nodeVersion: process.version,
              platform: process.platform,
            }
          : {}),
        ...context?.metadata,
      },
    };

    // Format log entry for console output
    const levelName = LogLevel[level];
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';

    // Use appropriate console method based on level
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(`[${timestamp}] [DEBUG] ${message}${contextStr}`);
        break;
      case LogLevel.INFO:
        console.info(`[${timestamp}] [INFO] ${message}${contextStr}`);
        break;
      case LogLevel.WARN:
        console.warn(`[${timestamp}] [WARN] ${message}${contextStr}`);
        break;
      case LogLevel.ERROR:
        console.error(`[${timestamp}] [ERROR] ${message}${contextStr}`);
        break;
      case LogLevel.FATAL:
        console.error(`[${timestamp}] [FATAL] ${message}${contextStr}`);
        break;
    }
  },

  /**
   * Check if Sentry is enabled
   * @returns True if Sentry is available and configured
   */
  isSentryEnabled(): boolean {
    return sentryEnabled;
  },

  /**
   * Get current log level (always DEBUG for server)
   * @returns Current log level
   */
  getLevel(): LogLevel {
    return LogLevel.DEBUG;
  },
};

/**
 * Create a child logger with additional context
 * @param context - Additional context to include in all logs
 * @returns Child logger instance
 */
export function createChildLogger(context: Record<string, any>) {
  return {
    debug: (message: string, additionalContext?: Record<string, any>) => {
      logger.debug(message, { ...context, ...additionalContext });
    },
    info: (message: string, additionalContext?: Record<string, any>) => {
      logger.info(message, { ...context, ...additionalContext });
    },
    warn: (message: string, additionalContext?: Record<string, any>) => {
      logger.warn(message, { ...context, ...additionalContext });
    },
    error: async (message: string, additionalContext?: Record<string, any>) => {
      await logger.error(message, { ...context, ...additionalContext });
    },
    fatal: async (message: string, additionalContext?: Record<string, any>) => {
      await logger.fatal(message, { ...context, ...additionalContext });
    },
  };
}

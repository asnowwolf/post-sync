/* eslint-disable no-console */
enum LogLevel {
    DEBUG,
    INFO,
    WARN,
    ERROR,
}

// For now, we'll just use console.log, but this can be expanded later
// with a more sophisticated logging library like 'winston' or 'pino'.
export const logger = {
    debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
    info: (...args: any[]) => console.info('[INFO]', ...args),
    warn: (...args: any[]) => console.warn('[WARN]', ...args),
    error: (...args: any[]) => console.error('[ERROR]', ...args),
};


import { logger } from '../logger.js';
import { ApiError } from '../errors.js';

export interface RetryOptions {
    maxAttempts?: number;
    delayMs?: number; // Initial delay
    backoffStrategy?: 'fixed' | 'exponential';
    maxDelayMs?: number; // Max delay cap
    retryCondition?: (error: any) => boolean;
    onRetry?: (attempt: number, error: any, delay: number) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 5000;

export async function retry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions
): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const initialDelay = options?.delayMs ?? DEFAULT_DELAY_MS;
    const backoffStrategy = options?.backoffStrategy ?? 'fixed';
    const maxDelayCap = options?.maxDelayMs;

    const retryCondition = options?.retryCondition ?? ((error) => {
        // Default retry condition: retry for "frequent request" or system errors
        return error instanceof ApiError && (
            error.message.includes('请勿频繁请求') ||
            error.message.includes('system error') ||
            (error.details && error.details.errcode === 45009)
        );
    });

    const onRetry = options?.onRetry ?? ((attempt, error, delay) => {
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed: ${error.message}. Retrying in ${delay / 1000} seconds...`);
    });

    let currentDelay = initialDelay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            // Check for Quota Limit specific error
            const isQuotaLimit = (
                (error instanceof ApiError && (
                    error.message.includes('reach max api daily quota limit') ||
                    (error.details && error.details.errcode === 45009)
                )) ||
                (error?.message && error.message.includes('reach max api daily quota limit'))
            );

            if (isQuotaLimit) {
                const now = new Date();
                const target = new Date(now);
                target.setDate(target.getDate() + 1);
                target.setHours(0, 1, 0, 0);
                const waitMs = target.getTime() - now.getTime();

                logger.warn(`WeChat API daily quota reached. Waiting until ${target.toLocaleString()} before retrying...`);

                await new Promise(resolve => setTimeout(resolve, waitMs));

                // Decrement attempt so we don't exhaust retries due to this forced wait
                attempt--;
                continue;
            }

            const shouldRetry = retryCondition(error) && attempt < maxAttempts;

            if (shouldRetry) {
                // If the current required delay exceeds the cap, stop retrying.
                // User requirement: "until 1 minute after determine as retry failure"
                if (maxDelayCap && currentDelay > maxDelayCap) {
                    logger.error(`Next retry delay ${currentDelay}ms exceeds limit ${maxDelayCap}ms. Stopping retry.`);
                    throw error;
                }

                onRetry(attempt, error, currentDelay);
                await new Promise(resolve => setTimeout(resolve, currentDelay));

                // Calculate next delay
                if (backoffStrategy === 'exponential') {
                    currentDelay = currentDelay * 2;
                }
            } else {
                throw error;
            }
        }
    }
    throw new Error('Retry logic failed to complete or re-throw error.');
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

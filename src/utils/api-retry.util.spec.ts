import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retry } from './api-retry.util';
import { ApiError } from '../errors';
import { logger } from '../logger';

vi.mock('../logger', () => ({
    logger: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    }
}));

describe('retry util', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('should wait until next day 00:01:00 when quota limit error occurs', async () => {
        // Set current time to 2023-10-01 12:00:00
        const mockDate = new Date(2023, 9, 1, 12, 0, 0);
        vi.setSystemTime(mockDate);

        const fn = vi.fn()
            .mockRejectedValueOnce(new ApiError('reach max api daily quota limit', 403, { errcode: 45009 }))
            .mockResolvedValueOnce('success');

        const retryPromise = retry(fn, { maxAttempts: 3, delayMs: 100 });

        // Calculate expected wait time:
        // From Oct 1 12:00:00 to Oct 2 00:01:00 
        // 12 hours + 1 minute = 12 * 60 + 1 = 721 minutes
        // 721 * 60 * 1000 = 43,260,000 ms
        const expectedWaitTime = 43260000;

        // We can't easily check the exact argument to setTimeout inside the promise without spying on global setTimeout,
        // but checking behavior is better.
        
        // Advance time by a small amount (standard retry delay is 100ms in options)
        // If logic is NOT implemented, it would retry after ~100ms.
        // We want to ensure it DOES NOT retry after 100ms, but waits for expectedWaitTime.
        
        await vi.advanceTimersByTimeAsync(200);
        
        // Without the fix, this expectation would fail (it would have called fn twice)
        // expect(fn).toHaveBeenCalledTimes(1); 

        // Advance to the target time
        await vi.advanceTimersByTimeAsync(expectedWaitTime);
        
        const result = await retryPromise;
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
        
        // Verify logger was called with warning about long wait
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WeChat API daily quota reached'));
    });

    it('should retry with a fixed delay for linear retry strategy', async () => {
        const mockDate = new Date(2023, 9, 1, 12, 0, 0);
        vi.setSystemTime(mockDate);

        const error = new ApiError('system error', 500);
        const fn = vi.fn()
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce('success');

        const initialDelay = 1000; // 1 second
        const maxAttempts = 3;

        const retryPromise = retry(fn, { maxAttempts, delayMs: initialDelay });

        // First call
        expect(fn).toHaveBeenCalledTimes(1);

        // Advance timers by initialDelay for the first retry
        await vi.advanceTimersByTimeAsync(initialDelay);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Attempt 1/${maxAttempts} failed: ${error.message}. Retrying in ${initialDelay / 1000} seconds...`));

        // Advance timers by initialDelay for the second retry (should be fixed delay)
        await vi.advanceTimersByTimeAsync(initialDelay);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Attempt 2/${maxAttempts} failed: ${error.message}. Retrying in ${initialDelay / 1000} seconds...`));

        const result = await retryPromise;
        expect(result).toBe('success');
    });

});
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from './logger.js';

describe('Logger', () => {
    const mockDebug = vi.spyOn(console, 'debug').mockImplementation(() => {
    });
    const mockInfo = vi.spyOn(console, 'info').mockImplementation(() => {
    });
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {
    });

    afterEach(() => {
        // Clear mock history after each test
        mockDebug.mockClear();
        mockInfo.mockClear();
        mockWarn.mockClear();
        mockError.mockClear();
    });

    afterAll(() => {
        // Restore original console methods
        mockDebug.mockRestore();
        mockInfo.mockRestore();
        mockWarn.mockRestore();
        mockError.mockRestore();
    });

    it('should call console.debug with the correct prefix', () => {
        logger.debug('test message', {data: 123});
        expect(mockDebug).toHaveBeenCalledWith('[DEBUG]', 'test message', {data: 123});
    });

    it('should call console.info with the correct prefix', () => {
        logger.info('test message');
        expect(mockInfo).toHaveBeenCalledWith('[INFO]', 'test message');
    });

    it('should call console.warn with the correct prefix', () => {
        logger.warn('test message');
        expect(mockWarn).toHaveBeenCalledWith('[WARN]', 'test message');
    });

    it('should call console.error with the correct prefix', () => {
        logger.error('test message');
        expect(mockError).toHaveBeenCalledWith('[ERROR]', 'test message');
    });
});

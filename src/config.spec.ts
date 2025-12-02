import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';

// Mock dotenv before any imports
// We need to return an object that mimics the module namespace
vi.mock('dotenv', () => {
    const config = vi.fn();
    return {
        config, // Named export
        default: {config} // Default export
    };
});

describe('AppConfig', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = {...OLD_ENV};
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    it('should load configuration from environment variables', async () => {
        process.env.WECHAT_APP_ID = 'test_app_id';
        process.env.WECHAT_APP_SECRET = 'test_app_secret';
        process.env.PROXY_URL = 'http://localhost:8080';

        const configModule = await import('./config.js');

        expect(configModule.config.appId).toBe('test_app_id');
        expect(configModule.config.appSecret).toBe('test_app_secret');
        expect(configModule.config.proxy).toBe('http://localhost:8080');
    });

    it('should exit if required environment variables are missing', async () => {
        const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        }) as any);
        const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {
        });

        delete process.env.WECHAT_APP_ID;
        delete process.env.WECHAT_APP_SECRET;

        await import('./config.js');

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("WeChat AppID and AppSecret must be provided"));

        mockExit.mockRestore();
        mockConsoleError.mockRestore();
    });

    it('should have undefined proxy if not set', async () => {
        process.env.WECHAT_APP_ID = 'test_app_id';
        process.env.WECHAT_APP_SECRET = 'test_app_secret';
        delete process.env.PROXY_URL;

        const configModule = await import('./config.js');

        expect(configModule.config.proxy).toBeUndefined();
    });
});

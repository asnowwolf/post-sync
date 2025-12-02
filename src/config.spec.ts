import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

// Explicitly mock the module with a factory
vi.mock('./utils/file.util.js', () => ({
    getPostSyncWorkDir: vi.fn(),
    readJsonFile: vi.fn(),
}));

describe('Config Service', () => {
    const mockWorkDir = '/tmp/test_home/.post-sync';
    const mockConfigPath = path.join(mockWorkDir, 'config.json');

    const ORIGINAL_PROCESS_ENV = process.env;

    let mockExit: vi.SpyInstance;
    let mockConsoleError: vi.SpyInstance;
    let fileUtil: typeof import('./utils/file.util.js');

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env = { ...ORIGINAL_PROCESS_ENV };

        // Reset modules to ensure fresh import of config.ts after mocks are set
        vi.resetModules();
        
        // Re-import the mocked module to get the fresh mock functions associated with the new context
        fileUtil = await import('./utils/file.util.js');

        // Set default mock config content for most tests
        vi.mocked(fileUtil.readJsonFile).mockResolvedValue({
            wechatApiBaseUrl: 'https://proxy-wechat.zhizuo.biz',
            profiles: [
                {
                    id: 'default',
                    appId: 'default_app_id',
                    appSecret: 'default_app_secret',
                },
                {
                    id: 'tech_blog',
                    appId: 'tech_blog_app_id',
                    appSecret: 'tech_blog_app_secret',
                },
            ],
        });
        vi.mocked(fileUtil.getPostSyncWorkDir).mockReturnValue(mockWorkDir);

        // Mock process.exit and console.error globally for tests that expect it
        mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit called with code ${code}`);
        }) as never);
        mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {
        });
    });

    afterAll(() => {
        vi.restoreAllMocks();
        process.env = ORIGINAL_PROCESS_ENV;
    });

    it('should load configuration from ~/.post-sync/config.json and return the default profile', async () => {
        const { getConfig } = await import('./config.ts');
        const config = getConfig();

        expect(config.appId).toBe('default_app_id');
        expect(config.appSecret).toBe('default_app_secret');
        expect(config.wechatApiBaseUrl).toBe('https://proxy-wechat.zhizuo.biz');

        expect(fileUtil.getPostSyncWorkDir).toHaveBeenCalled();
        expect(fileUtil.readJsonFile).toHaveBeenCalledWith(mockConfigPath);
        expect(mockExit).not.toHaveBeenCalled();
    });

    it('should return the specified profile if a valid profileId is provided', async () => {
        const { getConfig } = await import('./config.ts');
        const config = getConfig('tech_blog');

        expect(config.appId).toBe('tech_blog_app_id');
        expect(config.appSecret).toBe('tech_blog_app_secret');
        expect(config.wechatApiBaseUrl).toBe('https://proxy-wechat.zhizuo.biz');
        expect(mockExit).not.toHaveBeenCalled();
    });

    it('should throw an error and exit if an invalid profileId is provided', async () => {
        const { getConfig } = await import('./config.ts');
        expect(() => getConfig('non_existent_profile')).toThrow();

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Profile 'non_existent_profile' not found"));
    });

    it('should throw an error and exit if no profiles are found in config.json', async () => {
        vi.mocked(fileUtil.readJsonFile).mockResolvedValueOnce({
            wechatApiBaseUrl: 'https://proxy-wechat.zhizuo.biz',
            profiles: [],
        });
        
        await expect(import('./config.ts')).rejects.toThrow('process.exit called');

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("No profiles found"));
    });

    it('should throw an error and exit if appId is missing from a profile', async () => {
        vi.mocked(fileUtil.readJsonFile).mockResolvedValueOnce({
            wechatApiBaseUrl: 'https://proxy-wechat.zhizuo.biz',
            profiles: [
                {
                    id: 'invalid',
                    appId: '',
                    appSecret: 'secret',
                },
            ],
        });
        const { getConfig } = await import('./config.ts');
        expect(() => getConfig('invalid')).toThrow();

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("AppID and AppSecret must be provided for profile 'invalid'"));
    });

    it('should throw an error and exit if appSecret is missing from a profile', async () => {
        vi.mocked(fileUtil.readJsonFile).mockResolvedValueOnce({
            wechatApiBaseUrl: 'https://proxy-wechat.zhizuo.biz',
            profiles: [
                {
                    id: 'invalid',
                    appId: 'id',
                    appSecret: '',
                },
            ],
        });
        const { getConfig } = await import('./config.ts');
        expect(() => getConfig('invalid')).toThrow();

        expect(mockExit).toHaveBeenCalledWith(1);
        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("AppID and AppSecret must be provided for profile 'invalid'"));
    });

    it('should use default wechatApiBaseUrl if not provided in config or env', async () => {
        delete process.env.WECHAT_API_BASE_URL;
        vi.mocked(fileUtil.readJsonFile).mockResolvedValueOnce({
            profiles: [
                {
                    id: 'default',
                    appId: 'default_app_id',
                    appSecret: 'default_app_secret',
                },
            ],
        });
        const { getConfig } = await import('./config.ts');
        const config = getConfig();
        expect(config.wechatApiBaseUrl).toBe('https://proxy-wechat.zhizuo.biz');
        expect(mockExit).not.toHaveBeenCalled();
    });

    it('should override wechatApiBaseUrl if provided in env', async () => {
        process.env.WECHAT_API_BASE_URL = 'http://custom-proxy.com';
        vi.mocked(fileUtil.readJsonFile).mockResolvedValueOnce({
            profiles: [
                {
                    id: 'default',
                    appId: 'default_app_id',
                    appSecret: 'default_app_secret',
                },
            ],
        });
        const { getConfig } = await import('./config.ts');
        const config = getConfig();
        expect(config.wechatApiBaseUrl).toBe('http://custom-proxy.com');
        expect(mockExit).not.toHaveBeenCalled();
    });

    it('should use wechatApiBaseUrl from config.json if provided (and env not set)', async () => {
        delete process.env.WECHAT_API_BASE_URL; // Ensure env is not set
        vi.mocked(fileUtil.readJsonFile).mockResolvedValueOnce({
            wechatApiBaseUrl: 'http://config-file-proxy.com',
            profiles: [
                {
                    id: 'default',
                    appId: 'default_app_id',
                    appSecret: 'default_app_secret',
                },
            ],
        });
        const { getConfig } = await import('./config.ts');
        const config = getConfig();
        expect(config.wechatApiBaseUrl).toBe('http://config-file-proxy.com');
        expect(mockExit).not.toHaveBeenCalled();
    });
});

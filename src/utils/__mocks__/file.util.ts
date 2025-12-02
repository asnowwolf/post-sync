import { vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs'; // Import fs to mock its functions
import * as os from 'os'; // Import os to mock its homedir

const mockHomedir = path.join(os.tmpdir(), `test_home_${Date.now()}`); // Unique temp home dir for each test run
const mockWorkDir = path.join(mockHomedir, '.post-sync');
const mockConfigPath = path.join(mockWorkDir, 'config.json');

let currentMockConfigContent: { wechatApiBaseUrl?: string; profiles?: { id: string; appId: string; appSecret: string; }[] } = {
    wechatApiBaseUrl: 'https://proxy-wechat.zhizuo.biz',
    profiles: [
        {
            id: 'default',
            appId: 'mock_app_id',
            appSecret: 'mock_app_secret',
        },
    ],
};

export const setMockConfigContent = (config: typeof currentMockConfigContent) => {
    currentMockConfigContent = config;
};

export const getPostSyncWorkDir = vi.fn(() => {
    if (!fs.existsSync(mockWorkDir)) {
        fs.mkdirSync(mockWorkDir, { recursive: true });
    }
    return mockWorkDir;
});

export const readJsonFile = vi.fn(async (filePath) => {
    if (filePath === mockConfigPath) {
        return currentMockConfigContent;
    }
    // Fallback for other JSON files if needed by other tests not covered by specific mocks
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error: any) {
        throw new Error(`Mock readJsonFile: Failed to read or parse JSON file: ${filePath}. ${error.message}`);
    }
});

// Re-export actual functions that are not mocked here
export const getFileHash = vi.fn(() => 'mock_hash'); // Explicitly mock getFileHash
export const getFileList = vi.fn(() => ['/mock/path/article.md']); // Explicitly mock getFileList

// Mock the fs module in general for creating directories during getPostSyncWorkDir
vi.mock('fs', async (importOriginal) => {
    const actualFs = await importOriginal<typeof fs>();
    return {
        ...actualFs,
        existsSync: vi.fn(actualFs.existsSync), // Mock existsSync but keep original behavior by default
        mkdirSync: vi.fn(actualFs.mkdirSync),   // Mock mkdirSync but keep original behavior by default
        promises: {
            ...actualFs.promises,
            readFile: vi.fn(actualFs.promises.readFile), // Mock readFile but keep original behavior by default
        },
    };
});

// Mock os.homedir once for consistency across tests
vi.mock('os', async (importOriginal) => {
    const actualOs = await importOriginal<typeof os>();
    return {
        ...actualOs,
        homedir: vi.fn(() => mockHomedir), // Always return the mock homedir
    };
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Hoist all mocks to ensure they are available in vi.mock factories
const mocks = vi.hoisted(() => {
    return {
        // file.util
        getPostSyncWorkDir: vi.fn(() => '/mock/home/.post-sync'),
        readJsonFile: vi.fn(), // Will be implemented in mock factory or beforeEach
        getFileHash: vi.fn(() => 'mock_hash'),
        getFileList: vi.fn(() => ['/mock/path/article.md']),

        // DbService
        mockFindArticleByPath: vi.fn(),
        mockHasArticleBeenPublished: vi.fn(),
        mockUpdateArticleHash: vi.fn(),
        mockInsertDraft: vi.fn(),
        mockInsertArticle: vi.fn(() => ({ lastInsertRowid: 1 })),
        mockPerformTransaction: vi.fn((cb) => cb()),
        mockFindLatestDraftByArticleId: vi.fn(),
        mockInsertPublication: vi.fn(),

        // WeChatService
        mockCreateDraft: vi.fn().mockResolvedValue('mock_media_id'),
        mockPublishDraft: vi.fn().mockResolvedValue('mock_publish_id'),

        // MarkdownService
        mockConvert: vi.fn().mockResolvedValue({ html: 'mock html', thumb_media_id: 'mock_thumb_id' }),

        // Commander
        mockName: vi.fn().mockReturnThis(),
        mockDescription: vi.fn().mockReturnThis(),
        mockVersion: vi.fn().mockReturnThis(),
        mockCommand: vi.fn().mockReturnThis(),
        mockOption: vi.fn().mockReturnThis(),
        mockAction: vi.fn().mockReturnThis(),
        mockParse: vi.fn().mockReturnThis(),

        // Readline
        mockQuestion: vi.fn(),
        mockClose: vi.fn(),
    };
});

// Capture command actions
const commandActions: Record<string, Function> = {};

// 1. Mock file.util
import * as fileUtil from './utils/file.util.js';
vi.mock('./utils/file.util.js', async (importOriginal) => {
    const actualFileUtil = await importOriginal<typeof fileUtil>();
    return {
        ...actualFileUtil,
        getPostSyncWorkDir: mocks.getPostSyncWorkDir,
        readJsonFile: vi.fn(async (filePath) => {
             if (filePath.endsWith('config.json')) {
                return {
                    wechatApiBaseUrl: 'https://proxy-wechat.zhizuo.biz',
                    profiles: [
                        { id: 'default', appId: 'mock_app_id', appSecret: 'mock_app_secret' },
                        { id: 'tech_blog', appId: 'tech_blog_app_id', appSecret: 'tech_blog_app_secret' },
                    ],
                };
            }
            return actualFileUtil.readJsonFile(filePath);
        }),
        getFileHash: mocks.getFileHash,
        getFileList: mocks.getFileList,
    };
});

// 2. Mock DbService
vi.mock('./services/db.service.js', () => {
    return {
        DbService: vi.fn().mockImplementation(function() {
            return {
                findArticleByPath: mocks.mockFindArticleByPath,
                hasArticleBeenPublished: mocks.mockHasArticleBeenPublished,
                updateArticleHash: mocks.mockUpdateArticleHash,
                insertDraft: mocks.mockInsertDraft,
                insertArticle: mocks.mockInsertArticle,
                performTransaction: mocks.mockPerformTransaction,
                findLatestDraftByArticleId: mocks.mockFindLatestDraftByArticleId,
                insertPublication: mocks.mockInsertPublication,
            };
        }),
    };
});

// 3. Mock WeChatService
vi.mock('./services/wechat.service.js', () => {
    return {
        WeChatService: vi.fn().mockImplementation(function() {
            return {
                createDraft: mocks.mockCreateDraft,
                publishDraft: mocks.mockPublishDraft,
            };
        }),
    };
});

// 4. Mock MarkdownService
vi.mock('./services/markdown.service.js', () => {
    return {
        MarkdownService: vi.fn().mockImplementation(function() {
            return {
                convert: mocks.mockConvert,
            };
        }),
    };
});

// 5. Mock Commander
vi.mock('commander', () => {
    return {
        Command: class {
            constructor() {
                this.name = mocks.mockName;
                this.description = mocks.mockDescription;
                this.version = mocks.mockVersion;
                this.parse = mocks.mockParse;
            }
            command = vi.fn().mockImplementation((commandName: string) => {
                const commandInstance = {
                    description: vi.fn().mockReturnThis(),
                    option: mocks.mockOption.mockReturnThis(),
                    action: vi.fn((fn: Function) => {
                        commandActions[commandName] = fn;
                        return commandInstance;
                    }),
                };
                mocks.mockCommand(commandName);
                return commandInstance;
            });
            name = mocks.mockName;
            description = mocks.mockDescription;
            version = mocks.mockVersion;
            parse = mocks.mockParse;
        },
    };
});

// 6. Mock Readline
vi.mock('readline', () => ({
    createInterface: vi.fn(() => ({
        question: mocks.mockQuestion,
        close: mocks.mockClose,
    })),
}));

// 7. Mock fs
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        promises: {
            ...actual.promises,
            readFile: vi.fn().mockResolvedValue('# Mock Title\nMock content'),
        },
    };
});

describe('CLI', () => {
    let mockExit: vi.SpyInstance;
    let mockConsoleError: vi.SpyInstance;
    let commandAction: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
        mockConsoleError = vi.spyOn(console, 'error'); // Allow error logging

        // Reset default return values for hoisted mocks
        mocks.mockFindArticleByPath.mockReturnValue(undefined);
        mocks.mockHasArticleBeenPublished.mockReturnValue(false);
        mocks.mockUpdateArticleHash.mockReturnThis();
        mocks.mockInsertDraft.mockReturnThis();
        mocks.mockInsertArticle.mockReturnValue({ lastInsertRowid: 1 });
        mocks.mockPerformTransaction.mockImplementation((cb: any) => cb());
        mocks.mockCreateDraft.mockResolvedValue('mock_media_id');
        mocks.mockConvert.mockResolvedValue({ html: 'mock html', thumb_media_id: 'mock_thumb_id' });
        mocks.getFileList.mockReturnValue(['/mock/path/article.md']);

        vi.resetModules();
        await import('./index.js');
        commandAction = commandActions['create <path>'];
        if (!commandAction) {
            throw new Error("Could not find 'create' command action.");
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should define commands', async () => {
        expect(mocks.mockName).toHaveBeenCalledWith('post-sync');
        expect(mocks.mockCommand).toHaveBeenCalledWith('create <path>');
        expect(mocks.mockCommand).toHaveBeenCalledWith('publish <path>');
        expect(mocks.mockCommand).toHaveBeenCalledWith('post <path>');
        expect(mocks.mockOption).toHaveBeenCalledWith('--profile <id>', '指定要使用的配置 profile ID');
    });

    describe('create command', () => {
        const mockFilePath = '/mock/path/article.md';
        const mockOptions = { profile: 'default' };

        it('should create a new draft if article is new', async () => {
            await commandAction(mockFilePath, mockOptions);

            expect(mocks.mockFindArticleByPath).toHaveBeenCalledWith(mockFilePath);
            expect(mocks.mockInsertArticle).toHaveBeenCalledWith(mockFilePath, 'mock_hash');
            expect(mocks.mockInsertDraft).toHaveBeenCalledWith(1, 'mock_media_id');
            expect(mocks.mockCreateDraft).toHaveBeenCalled();
            expect(mockExit).not.toHaveBeenCalled();
        });

        it('should update article hash and create new draft if content changed', async () => {
            mocks.mockFindArticleByPath.mockReturnValueOnce({ id: 1, source_hash: 'old_hash' });

            await commandAction(mockFilePath, mockOptions);

            expect(mocks.mockFindArticleByPath).toHaveBeenCalledWith(mockFilePath);
            expect(mocks.mockUpdateArticleHash).toHaveBeenCalledWith(1, 'mock_hash');
            expect(mocks.mockInsertDraft).toHaveBeenCalledWith(1, 'mock_media_id');
            expect(mocks.mockCreateDraft).toHaveBeenCalled();
            expect(mockExit).not.toHaveBeenCalled();
        });

        it('should skip draft creation if article is unchanged and not published', async () => {
            mocks.mockFindArticleByPath.mockReturnValueOnce({ id: 1, source_hash: 'mock_hash' });

            await commandAction(mockFilePath, mockOptions);

            expect(mocks.mockFindArticleByPath).toHaveBeenCalledWith(mockFilePath);
            expect(mocks.mockCreateDraft).not.toHaveBeenCalled();
            expect(mockExit).not.toHaveBeenCalled();
        });

        it('should prompt for confirmation if article is unchanged and already published (user confirms)', async () => {
            mocks.mockFindArticleByPath.mockReturnValueOnce({ id: 1, source_hash: 'mock_hash' });
            mocks.mockHasArticleBeenPublished.mockReturnValueOnce(true);
            mocks.mockQuestion.mockImplementationOnce((query: any, callback: any) => callback('y'));

            await commandAction(mockFilePath, mockOptions);

            expect(mocks.mockFindArticleByPath).toHaveBeenCalledWith(mockFilePath);
            expect(mocks.mockHasArticleBeenPublished).toHaveBeenCalledWith(1);
            expect(mocks.mockQuestion).toHaveBeenCalled();
            expect(mocks.mockCreateDraft).toHaveBeenCalled();
            expect(mockExit).not.toHaveBeenCalled();
        });

        it('should prompt for confirmation if article is unchanged and already published (user cancels)', async () => {
            mocks.mockFindArticleByPath.mockReturnValueOnce({ id: 1, source_hash: 'mock_hash' });
            mocks.mockHasArticleBeenPublished.mockReturnValueOnce(true);
            mocks.mockQuestion.mockImplementationOnce((query: any, callback: any) => callback('N'));

            await commandAction(mockFilePath, mockOptions);

            expect(mocks.mockFindArticleByPath).toHaveBeenCalledWith(mockFilePath);
            expect(mocks.mockHasArticleBeenPublished).toHaveBeenCalledWith(1);
            expect(mocks.mockQuestion).toHaveBeenCalled();
            expect(mocks.mockCreateDraft).not.toHaveBeenCalled();
            expect(mockExit).not.toHaveBeenCalled();
        });

        it('should skip confirmation if --yes option is provided', async () => {
            mocks.mockFindArticleByPath.mockReturnValueOnce({ id: 1, source_hash: 'mock_hash' });
            mocks.mockHasArticleBeenPublished.mockReturnValueOnce(true);
            const optionsWithYes = { ...mockOptions, yes: true };

            await commandAction(mockFilePath, optionsWithYes);

            expect(mocks.mockFindArticleByPath).toHaveBeenCalledWith(mockFilePath);
            expect(mocks.mockHasArticleBeenPublished).toHaveBeenCalledWith(1);
            expect(mocks.mockQuestion).not.toHaveBeenCalled();
            expect(mocks.mockCreateDraft).toHaveBeenCalled();
            expect(mockExit).not.toHaveBeenCalled();
        });
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService } from './db.service.js';
import * as path from 'path';

// Mock values for better-sqlite3
const mockRun = vi.fn();
const mockGet = vi.fn();
const mockExec = vi.fn();
const mockPrepare = vi.fn(() => ({
    run: mockRun,
    get: mockGet,
}));
const mockTransaction = vi.fn((cb) => cb);

// Mock better-sqlite3 using a factory that returns a class
vi.mock('better-sqlite3', () => {
    return {
        default: class MockDatabase {
            constructor(dbPath: string) {
                // Ensure constructor receives the correct path
                if (!dbPath.includes('.post-sync') || !dbPath.endsWith('db.sqlite')) {
                    throw new Error('MockDatabase constructor received unexpected path: ' + dbPath);
                }
            }
            prepare = mockPrepare;
            exec = mockExec;
            transaction = mockTransaction;
        },
    };
});


describe('DbService', () => {
    let dbService: DbService;

    beforeEach(() => {
        vi.clearAllMocks();
        dbService = new DbService();
    });

    it('should initialize the schema on construction', () => {
        // mkdirSync is called by getPostSyncWorkDir, which is mocked, so we don't check it here directly.
        expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS articles'));
        expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS drafts'));
        expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS publications'));
    });

    it('should find an article by path', () => {
        const expectedArticle = { id: 1, source_hash: 'hash123' };
        mockGet.mockReturnValue(expectedArticle);

        const article = dbService.findArticleByPath('/absolute/path/to/article.md');

        expect(mockPrepare).toHaveBeenCalledWith('SELECT id, source_hash FROM articles WHERE source_path = ?');
        expect(mockGet).toHaveBeenCalledWith('/absolute/path/to/article.md');
        expect(article).toEqual(expectedArticle);
    });

    it('should insert a new article', () => {
        const filePath = '/absolute/path/to/new-article.md';
        const hash = 'newhash456';

        dbService.insertArticle(filePath, hash);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO articles'));
        expect(mockRun).toHaveBeenCalledWith(filePath, hash, expect.any(String), expect.any(String));
    });

    it('should update an article hash', () => {
        const id = 1;
        const hash = 'updatedhash789';

        dbService.updateArticleHash(id, hash);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE articles SET source_hash'));
        expect(mockRun).toHaveBeenCalledWith(hash, expect.any(String), id);
    });

    it('should insert a new draft', () => {
        const articleId = 1;
        const mediaId = 'media_id_abc';

        dbService.insertDraft(articleId, mediaId);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO drafts'));
        expect(mockRun).toHaveBeenCalledWith(articleId, mediaId, expect.any(String));
    });

    it('should find the latest draft by article ID', () => {
        const expectedDraft = { id: 2, media_id: 'latest_media_id' };
        mockGet.mockReturnValue(expectedDraft);

        const draft = dbService.findLatestDraftByArticleId(1);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT id, media_id FROM drafts WHERE article_id = ? ORDER BY created_at DESC LIMIT 1'));
        expect(mockGet).toHaveBeenCalledWith(1);
        expect(draft).toEqual(expectedDraft);
    });

    it('should insert a new publication', () => {
        const draftId = 2;
        const publishId = 'publish_id_xyz';

        dbService.insertPublication(draftId, publishId);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO publications'));
        expect(mockRun).toHaveBeenCalledWith(draftId, publishId, expect.any(String));
    });

    it('should perform a transaction', () => {
        const callback = vi.fn();
        dbService.performTransaction(callback);
        expect(mockTransaction).toHaveBeenCalledWith(callback);
        expect(callback).toHaveBeenCalled();
    });

    it('should return true if an article has been published', () => {
        mockGet.mockReturnValue({1: 1}); // Simulate a row being found
        const isPublished = dbService.hasArticleBeenPublished(1);
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT 1 FROM drafts d JOIN publications p ON d.id = p.draft_id WHERE d.article_id = ? LIMIT 1'));
        expect(mockGet).toHaveBeenCalledWith(1);
        expect(isPublished).toBe(true);
    });

    it('should return false if an article has not been published', () => {
        mockGet.mockReturnValue(undefined); // Simulate no row being found
        const isPublished = dbService.hasArticleBeenPublished(1);
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT 1 FROM drafts d JOIN publications p ON d.id = p.draft_id WHERE d.article_id = ? LIMIT 1'));
        expect(mockGet).toHaveBeenCalledWith(1);
        expect(isPublished).toBe(false);
    });
});
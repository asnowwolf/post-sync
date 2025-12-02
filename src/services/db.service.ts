import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger.js';
import { DbError } from '../errors.js';
import { getPostSyncWorkDir } from '../utils/file.util.js';

const DB_DIR = getPostSyncWorkDir();
const DB_PATH = path.join(DB_DIR, 'db.sqlite');

export class DbService {
    private db: Database.Database;

    constructor() {
        try {
            this.db = new Database(DB_PATH);
            logger.info(`Database connected at ${DB_PATH}`);
            this.init();
        } catch (error: any) {
            throw new DbError(`Failed to connect to database: ${error.message}`);
        }
    }

    private init() {
        logger.debug('Initializing database schema...');
        try {
            const createTablesStm = `
                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_path TEXT UNIQUE NOT NULL,
                    source_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS drafts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    article_id INTEGER NOT NULL,
                    media_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (article_id) REFERENCES articles (id)
                );

                CREATE TABLE IF NOT EXISTS publications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    draft_id INTEGER NOT NULL,
                    publish_id TEXT,
                    status TEXT DEFAULT 'pending',
                    article_url TEXT,
                    submitted_at TEXT NOT NULL,
                    finished_at TEXT,
                    FOREIGN KEY (draft_id) REFERENCES drafts (id)
                );

                CREATE TABLE IF NOT EXISTS materials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    local_path TEXT UNIQUE NOT NULL,
                    hash TEXT NOT NULL,
                    media_id TEXT NOT NULL,
                    url TEXT,
                    updated_at TEXT NOT NULL
                );
            `;
            this.db.exec(createTablesStm);
            logger.info('Database schema initialized successfully.');
        } catch (error: any) {
            throw new DbError(`Failed to initialize schema: ${error.message}`);
        }
    }

    public performTransaction(callback: () => void) {
        const transaction = this.db.transaction(callback);
        transaction();
    }

    public findArticleByPath(sourcePath: string): { id: number; source_hash: string } | undefined {
        const stm = this.db.prepare('SELECT id, source_hash FROM articles WHERE source_path = ?');
        return stm.get(sourcePath) as { id: number; source_hash: string } | undefined;
    }

    public insertArticle(sourcePath: string, hash: string): Database.RunResult {
        const stm = this.db.prepare(
            'INSERT INTO articles (source_path, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'
        );
        const now = new Date().toISOString();
        return stm.run(sourcePath, hash, now, now);
    }

    public updateArticleHash(id: number, hash: string): Database.RunResult {
        const stm = this.db.prepare(
            'UPDATE articles SET source_hash = ?, updated_at = ? WHERE id = ?'
        );
        const now = new Date().toISOString();
        return stm.run(hash, now, id);
    }

    public insertDraft(articleId: number, mediaId: string): Database.RunResult {
        const stm = this.db.prepare(
            'INSERT INTO drafts (article_id, media_id, created_at) VALUES (?, ?, ?)'
        );
        const now = new Date().toISOString();
        return stm.run(articleId, mediaId, now);
    }

    public findLatestDraftByArticleId(articleId: number): { id: number; media_id: string } | undefined {
        const stm = this.db.prepare(
            'SELECT id, media_id FROM drafts WHERE article_id = ? ORDER BY created_at DESC LIMIT 1'
        );
        return stm.get(articleId) as { id: number; media_id: string } | undefined;
    }

    public insertPublication(draftId: number, publishId: string): Database.RunResult {
        const stm = this.db.prepare(
            'INSERT INTO publications (draft_id, publish_id, submitted_at) VALUES (?, ?, ?)'
        );
        const now = new Date().toISOString();
        return stm.run(draftId, publishId, now);
    }

    public hasArticleBeenPublished(articleId: number): boolean {
        const stm = this.db.prepare(
            'SELECT 1 FROM drafts d JOIN publications p ON d.id = p.draft_id WHERE d.article_id = ? LIMIT 1'
        );
        return !!stm.get(articleId);
    }

    public getMaterial(localPath: string): { id: number; hash: string; media_id: string; url: string } | undefined {
        const stm = this.db.prepare('SELECT id, hash, media_id, url FROM materials WHERE local_path = ?');
        return stm.get(localPath) as { id: number; hash: string; media_id: string; url: string } | undefined;
    }

    public saveMaterial(localPath: string, hash: string, mediaId: string, url: string): Database.RunResult {
        const stm = this.db.prepare(`
            INSERT INTO materials (local_path, hash, media_id, url, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(local_path) DO UPDATE SET
            hash = excluded.hash,
            media_id = excluded.media_id,
            url = excluded.url,
            updated_at = excluded.updated_at
        `);
        const now = new Date().toISOString();
        return stm.run(localPath, hash, mediaId, url, now);
    }
}

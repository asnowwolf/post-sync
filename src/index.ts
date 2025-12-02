#!/usr/bin/env node
import {Command} from 'commander';
import {config} from './config.js';
import {logger} from './logger.js';
import {DbService} from './services/db.service.js';
import {getFileHash, getFileList} from './utils/file.util.js';
import {MarkdownService} from './services/markdown.service.js';
import {WeChatService} from './services/wechat.service.js';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

program
    .name('post-sync')
    .description('一个将 Markdown 文件发布到微信公众号的 CLI 工具')
    .version('1.0.0');

program
    .command('create <path>')
    .description('读取文件或目录，并创建一篇或多篇公众号草稿')
    .option('--appId <id>', '微信公众号的 AppID', config.appId)
    .option('--appSecret <secret>', '微信公众号的 AppSecret', config.appSecret)
    .action(async (rawPath, options) => {
        logger.info(`'create' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        try {
            const dbService = new DbService();
            const wechatService = new WeChatService({
                appId: options.appId,
                appSecret: options.appSecret,
                wechatApiBaseUrl: config.wechatApiBaseUrl,
            });
            const markdownService = new MarkdownService(wechatService);

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            const files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            for (const file of files) {
                const hash = await getFileHash(file);
                const articleEntry = dbService.findArticleByPath(file);

                if (articleEntry && articleEntry.source_hash === hash) {
                    logger.info(`Skipping '${file}' (content unchanged).`);
                    continue;
                }

                logger.info(`Processing '${file}'...`);

                const markdownContent = await fs.promises.readFile(file, 'utf-8');
                const {html, thumb_media_id} = await markdownService.convert(markdownContent, file);

                if (!thumb_media_id) {
                    logger.error(`Could not generate a thumbnail for '${file}'. Skipping draft creation.`);
                    continue;
                }

                // Extract title from the first H1 tag
                const titleMatch = markdownContent.match(/^#\s+(.*)/m);
                const title = titleMatch ? titleMatch[1] : 'Untitled';

                const media_id = await wechatService.createDraft({
                    title,
                    content: html,
                    thumb_media_id,
                });

                dbService.performTransaction(() => {
                    if (articleEntry) {
                        dbService.updateArticleHash(articleEntry.id, hash);
                        dbService.insertDraft(articleEntry.id, media_id);
                        logger.info(`Updated hash for '${file}' and created new draft with media_id: ${media_id}`);
                    } else {
                        const result = dbService.insertArticle(file, hash);
                        const articleId = result.lastInsertRowid as number;
                        dbService.insertDraft(articleId, media_id);
                        logger.info(`Inserted new article '${file}' and created draft with media_id: ${media_id}`);
                    }
                });
            }
        } catch (error: any) {
            logger.error('An error occurred during the create process:', error.message);
            if (error.details) {
                logger.error('API Error Details:', error.details);
            }
        }
    });

program
    .command('publish <path>')
    .description('发布一篇或多篇已创建的草稿')
    .option('--appId <id>', '微信公众号的 AppID', config.appId)
    .option('--appSecret <secret>', '微信公众号的 AppSecret', config.appSecret)
    .action(async (rawPath, options) => {
        logger.info(`'publish' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        try {
            const dbService = new DbService();
            const wechatService = new WeChatService({
                appId: options.appId,
                appSecret: options.appSecret,
                wechatApiBaseUrl: config.wechatApiBaseUrl,
            });

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            const files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            for (const file of files) {
                const articleEntry = dbService.findArticleByPath(file);
                if (!articleEntry) {
                    logger.warn(`Article for '${file}' not found in database. Please run 'create' first.`);
                    continue;
                }

                const draft = dbService.findLatestDraftByArticleId(articleEntry.id);
                if (!draft) {
                    logger.warn(`No draft found for '${file}'. Please run 'create' first.`);
                    continue;
                }

                const publishId = await wechatService.publishDraft(draft.media_id);
                dbService.insertPublication(draft.id, publishId);
                logger.info(`Successfully submitted '${file}' for publication with publish_id: ${publishId}.`);
            }
        } catch (error: any) {
            logger.error('An error occurred during the publish process:', error.message);
            if (error.details) {
                logger.error('API Error Details:', error.details);
            }
        }
    });

program
    .command('clean')
    .description('清理 .ps 目录下的临时文件')
    .action(() => {
        logger.info(`'clean' command called`);
        // ... clean 命令的实现
    });

program.parse(process.argv);

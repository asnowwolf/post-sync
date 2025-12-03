#!/usr/bin/env node
import {Command} from 'commander';
import {getConfig} from './config.js';
import {logger} from './logger.js';
import {DbService} from './services/db.service.js';
import {getFileHash, getFileList} from './utils/file.util.js';
import {MarkdownService} from './services/markdown.service.js';
import {WeChatService} from './services/wechat.service.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';

// Function to prompt user for confirmation
async function confirmAction(query: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(query + ' (y/N): ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
}

async function promptUser(query: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(query + ' ', (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

const program = new Command();

program
    .name('post-sync')
    .description('一个将 Markdown 文件发布到微信公众号的 CLI 工具')
    .version('1.0.0');

program
    .command('create <path>')
    .description('读取文件或目录，并创建一篇或多篇公众号草稿')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .option('-y, --yes', '跳过所有确认提示，直接执行操作')
    .action(async (rawPath, options) => {
        logger.debug("Executing create command action...");
        logger.info(`'create' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        let currentConfig;
        let dbService: DbService | undefined;
        let wechatService;
        let markdownService;
        let files;

        try {
            currentConfig = getConfig(options.profile);
            logger.debug("Config loaded.");
            dbService = new DbService();
            logger.debug("DbService initialized.");
            wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });
            logger.debug("WeChatService initialized.");
            markdownService = new MarkdownService(wechatService, dbService);
            logger.debug("MarkdownService initialized.");

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            for (const file of files) {
                try {
                    logger.info(`Processing '${file}'...`);

                    const markdownContent = await fs.promises.readFile(file, 'utf-8');
                    const {html, thumb_media_id, digest, author, title: extractedTitle} = await markdownService.convert(markdownContent, file, currentConfig.author);

                    if (!thumb_media_id) {
                        logger.error(`Could not generate a thumbnail for '${file}'. Skipping draft creation/update.`);
                        continue;
                    }

                    const title = extractedTitle || path.basename(file, '.md');
                    const contentToHash = JSON.stringify({ title, html, digest, author, thumb_media_id });
                    const hash = crypto.createHash('sha1').update(contentToHash).digest('hex');

                    const articleEntry = dbService.findArticleByPath(file);
                    const draftEntry = articleEntry ? dbService.findLatestDraftByArticleId(articleEntry.id) : undefined;
                    
                    let action: 'SKIP' | 'CREATE' | 'UPDATE' = 'CREATE';
                    let draftOnServer: any = null;

                    if (draftEntry) {
                        try {
                            draftOnServer = await wechatService.getDraft(draftEntry.media_id);
                        } catch (e) {
                            logger.warn(`Failed to check draft existence for '${file}': ${(e as any).message}`);
                        }

                        if (!draftOnServer) {
                            action = 'CREATE';
                            if (articleEntry && articleEntry.source_hash === hash) {
                                logger.info(`Draft for '${file}' is missing on server. Will re-create.`);
                            }
                        } else {
                            if (articleEntry && articleEntry.source_hash === hash) {
                                action = 'SKIP';
                            } else {
                                action = 'UPDATE';
                            }
                        }
                    }

                    if (action === 'SKIP') {
                        logger.info(`Skipping '${file}' (content unchanged and draft exists).`);
                        continue;
                    }
                    
                    if (action === 'UPDATE' && draftEntry) {
                        await wechatService.updateDraft(draftEntry.media_id, {
                            title,
                            content: html,
                            thumb_media_id,
                            digest: digest || '',
                            author: author || '',
                        });
                        
                        // Capture dbService in closure for transaction, ensuring it's not undefined
                        const db = dbService;
                        db.performTransaction(() => {
                            if (articleEntry) {
                                db.updateArticleHash(articleEntry.id, hash);
                            }
                        });
                        logger.info(`Successfully updated draft for '${file}' (media_id: ${draftEntry.media_id}).`);

                    } else {
                        const media_id = await wechatService.createDraft({
                            title,
                            content: html,
                            thumb_media_id,
                            digest: digest || '',
                            author: author || '',
                        });
                        
                        const db = dbService;
                        db.performTransaction(() => {
                            if (articleEntry) {
                                db.updateArticleHash(articleEntry.id, hash);
                                db.insertDraft(articleEntry.id, media_id);
                                logger.info(`Updated hash for '${file}' and created new draft with media_id: ${media_id}`);
                            } else {
                                const result = db.insertArticle(file, hash);
                                const articleId = result.lastInsertRowid as number;
                                db.insertDraft(articleId, media_id);
                                logger.info(`Inserted new article '${file}' and created draft with media_id: ${media_id}`);
                            }
                        });
                    }
                } catch (error: any) {
                    logger.error(`Failed to process '${file}':`, error.message);
                    if (error.details) {
                        logger.error('API Error Details:', JSON.stringify(error.details, null, 2));
                    }
                }
            }
        } catch (error: any) {
            logger.error('Initialization failed:', error.message);
        } finally {
            if (dbService) {
                dbService.close();
            }
        }
    });

program
    .command('publish <path>')
    .description('发布一篇或多篇已创建的草稿')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .option('-y, --yes', '跳过确认提示')
    .action(async (rawPath, options) => {
        logger.info(`'publish' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        let currentConfig;
        let dbService: DbService | undefined;
        let wechatService;
        let files;

        try {
            currentConfig = getConfig(options.profile);
            dbService = new DbService();
            wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            if (!options.yes) {
                const warningMsg = '声明：此发布功能无法支持原创声明、赞赏等功能，如果需要这些功能，请手动发布。\n确认要继续发布吗？';
                const confirmed = await confirmAction(warningMsg);
                if (!confirmed) {
                    logger.info('Publish operation cancelled.');
                    return;
                }
            }

            for (const file of files) {
                try {
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
                } catch (error: any) {
                    logger.error(`Failed to publish '${file}':`, error.message);
                    if (error.details) {
                        logger.error('API Error Details:', JSON.stringify(error.details, null, 2));
                    }
                }
            }
        } catch (error: any) {
            logger.error('Initialization failed:', error.message);
        } finally {
            if (dbService) {
                dbService.close();
            }
        }
    });

program
    .command('post <path>')
    .description('一键处理并发布文章')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .option('-y, --yes', '跳过确认提示')
    .action(async (rawPath, options) => {
        logger.info(`'post' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        let currentConfig;
        let dbService: DbService | undefined;
        let wechatService;
        let markdownService;
        let files;

        try {
            currentConfig = getConfig(options.profile);
            dbService = new DbService();
            wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });
            markdownService = new MarkdownService(wechatService, dbService);

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            if (!options.yes) {
                const warningMsg = '声明：此发布功能无法支持原创声明、赞赏等功能，如果需要这些功能，请手动发布。\n确认要继续发布吗？';
                const confirmed = await confirmAction(warningMsg);
                if (!confirmed) {
                    logger.info('Post operation cancelled.');
                    return;
                }
            }

            for (const file of files) {
                try {
                    logger.info(`Processing '${file}'...`);

                    const markdownContent = await fs.promises.readFile(file, 'utf-8');
                    const { html, thumb_media_id, digest, author, title: extractedTitle } = await markdownService.convert(markdownContent, file, currentConfig.author);

                    if (!thumb_media_id) {
                        logger.error(`Could not generate a thumbnail for '${file}'. Skipping draft creation/update.`);
                        continue;
                    }

                    const title = extractedTitle || path.basename(file, '.md');
                    const contentToHash = JSON.stringify({ title, html, digest, author, thumb_media_id });
                    const hash = crypto.createHash('sha1').update(contentToHash).digest('hex');

                    let articleEntry = dbService.findArticleByPath(file);
                    let draftEntry = articleEntry ? dbService.findLatestDraftByArticleId(articleEntry.id) : undefined;
                    
                    let action: 'SKIP' | 'CREATE' | 'UPDATE' = 'CREATE';
                    let draftOnServer: any = null;

                    if (draftEntry) {
                        try {
                            draftOnServer = await wechatService.getDraft(draftEntry.media_id);
                        } catch (e) {
                            logger.warn(`Failed to check draft existence for '${file}': ${(e as any).message}`);
                        }

                        if (!draftOnServer) {
                            action = 'CREATE';
                        } else {
                            if (articleEntry && articleEntry.source_hash === hash) {
                                action = 'SKIP'; 
                            } else {
                                action = 'UPDATE';
                            }
                        }
                    }

                    if (action === 'CREATE' || action === 'UPDATE') {
                        if (action === 'UPDATE' && draftEntry) {
                            await wechatService.updateDraft(draftEntry.media_id, {
                                title,
                                content: html,
                                thumb_media_id,
                                digest: digest || '',
                                author: author || '',
                            });
                            const db = dbService;
                            db.performTransaction(() => {
                                if (articleEntry) db.updateArticleHash(articleEntry!.id, hash);
                            });
                            logger.info(`Updated draft '${file}' (media_id: ${draftEntry.media_id}).`);
                        } else {
                            const media_id = await wechatService.createDraft({
                                title,
                                content: html,
                                thumb_media_id,
                                digest: digest || '',
                                author: author || '',
                            });
                            const db = dbService;
                            db.performTransaction(() => {
                                if (articleEntry) {
                                    db.updateArticleHash(articleEntry.id, hash);
                                    const result = db.insertDraft(articleEntry.id, media_id);
                                    draftEntry = { id: result.lastInsertRowid as number, media_id };
                                } else {
                                    const result = db.insertArticle(file, hash);
                                    const articleId = result.lastInsertRowid as number;
                                    const draftResult = db.insertDraft(articleId, media_id);
                                    draftEntry = { id: draftResult.lastInsertRowid as number, media_id };
                                    articleEntry = db.findArticleByPath(file);
                                }
                            });
                            logger.info(`Created new draft '${file}' (media_id: ${draftEntry?.media_id}).`);
                        }
                    } else {
                        logger.info(`Draft for '${file}' is up-to-date on server.`);
                    }
                    
                    if (draftEntry) {
                        logger.info(`Attempting to publish draft for '${file}'...`);
                        try {
                            const publishId = await wechatService.publishDraft(draftEntry.media_id);
                            dbService.insertPublication(draftEntry.id, publishId);
                            logger.info(`Successfully submitted '${file}' for publication with publish_id: ${publishId}.`);
                        } catch (e: any) {
                            logger.warn(`Publishing failed (maybe already published?): ${e.message}`);
                        }
                    } else {
                        logger.warn(`No draft available for '${file}' to publish.`);
                    }
                } catch (error: any) {
                    logger.error(`Failed to post '${file}':`, error.message);
                    if (error.details) {
                        logger.error('API Error Details:', JSON.stringify(error.details, null, 2));
                    }
                }
            }
        } catch (error: any) {
            logger.error('Initialization failed:', error.message);
        } finally {
            if (dbService) {
                dbService.close();
            }
        }
    });

program
    .command('delete <path>')
    .description('根据本地文件路径删除已发布的文章')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .action(async (rawPath, options) => {
        logger.info(`'delete' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        let currentConfig;
        let dbService: DbService | undefined;
        let wechatService;

        try {
            currentConfig = getConfig(options.profile);
            dbService = new DbService();
            wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            const files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            for (const file of files) {
                try {
                    const articleEntry = dbService.findArticleByPath(file);
                    if (!articleEntry) {
                        logger.warn(`Article for '${file}' not found in database.`);
                        continue;
                    }

                    const draft = dbService.findLatestDraftByArticleId(articleEntry.id);
                    if (!draft) {
                        logger.warn(`No draft found for '${file}'.`);
                        continue;
                    }

                    const publication = dbService.findPublicationByDraftId(draft.id);
                    if (!publication) {
                        logger.warn(`No publication record found for '${file}'.`);
                        continue;
                    }

                    logger.info(`Found publication record for '${file}' (publish_id: ${publication.publish_id}).`);
                    
                    const status = await wechatService.getPublishStatus(publication.publish_id);
                    
                    if (status.publish_status !== 0) {
                         logger.warn(`Publication status for '${file}' is not success (status: ${status.publish_status}). Cannot delete.`);
                         continue;
                    }
                    
                    const articleId = status.article_id;
                    
                    if (!articleId) {
                        logger.error(`Could not retrieve article_id for '${file}' from publish status. Maybe it was not published successfully?`);
                        continue;
                    }

                    const confirm = await confirmAction(`Are you sure you want to delete the published article for '${file}' (article_id: ${articleId})? This cannot be undone.`);
                    if (!confirm) {
                        logger.info(`Deletion cancelled for '${file}'.`);
                        continue;
                    }

                    await wechatService.deletePublishedArticle(articleId);
                    dbService.deletePublication(publication.id);
                    logger.info(`Successfully deleted published article for '${file}'.`);

                } catch (error: any) {
                    logger.error(`Failed to delete '${file}':`, error.message);
                    if (error.details) {
                        logger.error('API Error Details:', JSON.stringify(error.details, null, 2));
                    }
                }
            }

        } catch (error: any) {
            logger.error('An error occurred during the delete process:', error.message);
        } finally {
            if (dbService) {
                dbService.close();
            }
        }
    });

const deleteAll = program.command('delete-all')
    .description('批量删除内容');

deleteAll
    .command('articles')
    .description('删除所有已发布的文章 (交互式)')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .action(async (options) => {
        logger.info(`'delete-all articles' command called.`);
        logger.debug('Options:', options);

        let currentConfig;
        let wechatService;

        try {
            currentConfig = getConfig(options.profile);
            wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });
        } catch (error: any) {
            logger.error('Initialization failed:', error.message);
            return;
        }

        try {
            let skippedCount = 0;
            let deleteAll = false;

            const initialData = await wechatService.batchGetPublishedArticles(0, 1);
            const total = initialData.total_count;
            logger.info(`Total published articles found: ${total}`);

            if (total === 0) {
                logger.info('No published articles to delete.');
                return;
            }

            while (true) {
                const batchData = await wechatService.batchGetPublishedArticles(skippedCount, 20);
                const items = batchData.item;

                if (!items || items.length === 0) {
                    break;
                }

                for (const item of items) {
                    const articleId = item.article_id;
                    const title = item.content?.news_item?.[0]?.title || 'Unknown Title';
                    const updateTime = new Date(item.update_time * 1000).toLocaleString();

                    if (deleteAll) {
                        logger.info(`Deleting '${title}' (${articleId})...`);
                        try {
                            await wechatService.deletePublishedArticle(articleId);
                        } catch (e: any) {
                            logger.error(`Failed to delete '${title}': ${e.message}`);
                            skippedCount++;
                        }
                        continue;
                    }

                    const answer = await promptUser(`Delete "${title}" (Published: ${updateTime})? (y=yes, n=no, a=all, q=quit)`);

                    if (answer === 'q' || answer === 'quit') {
                        logger.info('Operation quit by user.');
                        return;
                    }

                    if (answer === 'a' || answer === 'all') {
                        deleteAll = true;
                        logger.info(`Deleting '${title}' (${articleId})...`);
                         try {
                            await wechatService.deletePublishedArticle(articleId);
                        } catch (e: any) {
                            logger.error(`Failed to delete '${title}': ${e.message}`);
                            skippedCount++;
                        }
                        continue;
                    }

                    if (answer === 'y' || answer === 'yes') {
                        logger.info(`Deleting '${title}' (${articleId})...`);
                         try {
                            await wechatService.deletePublishedArticle(articleId);
                        } catch (e: any) {
                             logger.error(`Failed to delete '${title}': ${e.message}`);
                             skippedCount++;
                        }
                    } else {
                        logger.info(`Skipped '${title}'.`);
                        skippedCount++;
                    }
                }
            }
            logger.info('Finished processing all published articles.');

        } catch (error: any) {
            logger.error('An error occurred during delete-all articles:', error.message);
            if (error.details) {
                logger.error('API Error Details:', JSON.stringify(error.details, null, 2));
            }
        }
    });

deleteAll
    .command('drafts')
    .description('删除所有草稿 (交互式)')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .action(async (options) => {
        logger.info(`'delete-all drafts' command called.`);
        logger.debug('Options:', options);

        let currentConfig;
        let wechatService;

        try {
            currentConfig = getConfig(options.profile);
            wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });
        } catch (error: any) {
            logger.error('Initialization failed:', error.message);
            return;
        }

        try {
            let skippedCount = 0;
            let deleteAll = false;

            const initialData = await wechatService.batchGetDrafts(0, 1);
            const total = initialData.total_count;
            logger.info(`Total drafts found: ${total}`);

            if (total === 0) {
                logger.info('No drafts to delete.');
                return;
            }

            while (true) {
                const batchData = await wechatService.batchGetDrafts(skippedCount, 20);
                const items = batchData.item;

                if (!items || items.length === 0) {
                    break;
                }

                for (const item of items) {
                    const mediaId = item.media_id;
                    const title = item.content?.news_item?.[0]?.title || 'Unknown Title';
                    const updateTime = new Date(item.update_time * 1000).toLocaleString();

                    if (deleteAll) {
                        logger.info(`Deleting draft '${title}' (${mediaId})...`);
                        try {
                            await wechatService.deleteDraft(mediaId);
                        } catch (e: any) {
                            logger.error(`Failed to delete '${title}': ${e.message}`);
                            skippedCount++;
                        }
                        continue;
                    }

                    const answer = await promptUser(`Delete draft "${title}" (Updated: ${updateTime})? (y=yes, n=no, a=all, q=quit)`);

                    if (answer === 'q' || answer === 'quit') {
                        logger.info('Operation quit by user.');
                        return;
                    }

                    if (answer === 'a' || answer === 'all') {
                        deleteAll = true;
                        logger.info(`Deleting draft '${title}' (${mediaId})...`);
                         try {
                            await wechatService.deleteDraft(mediaId);
                        } catch (e: any) {
                            logger.error(`Failed to delete '${title}': ${e.message}`);
                            skippedCount++;
                        }
                        continue;
                    }

                    if (answer === 'y' || answer === 'yes') {
                        logger.info(`Deleting draft '${title}' (${mediaId})...`);
                         try {
                            await wechatService.deleteDraft(mediaId);
                        } catch (e: any) {
                             logger.error(`Failed to delete '${title}': ${e.message}`);
                             skippedCount++;
                        }
                    } else {
                        logger.info(`Skipped '${title}'.`);
                        skippedCount++;
                    }
                }
            }
            logger.info('Finished processing all drafts.');

        } catch (error: any) {
            logger.error('An error occurred during delete-all drafts:', error.message);
            if (error.details) {
                logger.error('API Error Details:', JSON.stringify(error.details, null, 2));
            }
        }
    });

await program.parseAsync(process.argv);
process.exit(0);
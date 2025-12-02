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

const program = new Command();

program
    .name('post-sync')
    .description('一个将 Markdown 文件发布到微信公众号的 CLI 工具')
    .version('1.0.0');

program
    .command('create <path>')
    .description('读取文件或目录，并创建一篇或多篇公众号草稿')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .option('-y, --yes', '跳过所有确认提示，直接执行操作') // Add this option
    .action(async (rawPath, options) => {
        logger.debug("Executing create command action...");
        logger.info(`'create' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        try {
            const currentConfig = getConfig(options.profile);
            logger.debug("Config loaded.");
            const dbService = new DbService();
            logger.debug("DbService initialized.");
            const wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });
            logger.debug("WeChatService initialized.");
            const markdownService = new MarkdownService(wechatService, dbService);
            logger.debug("MarkdownService initialized.");

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            const files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            for (const file of files) {
                const hash = await getFileHash(file);
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
                        // Draft known in DB but missing on server (deleted)
                        action = 'CREATE';
                        if (articleEntry && articleEntry.source_hash === hash) {
                            logger.info(`Draft for '${file}' is missing on server. Will re-create.`);
                        }
                    } else {
                        // Draft exists on server
                        if (articleEntry && articleEntry.source_hash === hash) {
                             // Content matches and draft exists.
                             action = 'SKIP';
                        } else {
                            // Content changed, draft exists -> Update
                            action = 'UPDATE';
                        }
                    }
                }


                if (action === 'SKIP') {
                    logger.info(`Skipping '${file}' (content unchanged and draft exists).`);
                    continue;
                }
                
                logger.info(`Processing '${file}' (Action: ${action})...`);

                const markdownContent = await fs.promises.readFile(file, 'utf-8');
                const {html, thumb_media_id, digest, author} = await markdownService.convert(markdownContent, file, currentConfig.author);

                if (!thumb_media_id) {
                    logger.error(`Could not generate a thumbnail for '${file}'. Skipping draft creation/update.`);
                    continue;
                }

                const title = path.basename(file, '.md');
                if (action === 'UPDATE' && draftEntry) {
                     await wechatService.updateDraft(draftEntry.media_id, {
                        title,
                        content: html,
                        thumb_media_id,
                        digest: digest || '',
                        author: author || '',
                    });
                    
                    dbService.performTransaction(() => {
                        // We must ensure articleEntry exists if we are in UPDATE mode (it should, based on logic)
                        if (articleEntry) {
                            dbService.updateArticleHash(articleEntry.id, hash);
                        }
                    });
                    logger.info(`Successfully updated draft for '${file}' (media_id: ${draftEntry.media_id}).`);

                } else {
                    // CREATE
                    const media_id = await wechatService.createDraft({
                        title,
                        content: html,
                        thumb_media_id,
                        digest: digest || '',
                        author: author || '',
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
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .action(async (rawPath, options) => {
        logger.info(`'publish' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        try {
            const currentConfig = getConfig(options.profile);
            const dbService = new DbService();
            const wechatService = new WeChatService({
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
    .command('post <path>')
    .description('一键处理并发布文章')
    .option('--profile <id>', '指定要使用的配置 profile ID')
    .action(async (rawPath, options) => {
        logger.info(`'post' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        try {
            const currentConfig = getConfig(options.profile);
            const dbService = new DbService();
            const wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
            });
            const markdownService = new MarkdownService(wechatService, dbService);

            const resolvedPath = path.resolve(process.cwd(), rawPath);
            const files = await getFileList(resolvedPath);

            if (files.length === 0) {
                logger.warn('No Markdown files found at the specified path.');
                return;
            }

            for (const file of files) {
                logger.info(`Processing '${file}'...`);

                const hash = await getFileHash(file);
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
                             // For 'post', if content is unchanged and draft exists,
                             // we should proceed to PUBLISH.
                             // So we don't need to create/update draft, but we DO need to ensure we have the draft object.
                             action = 'SKIP'; 
                        } else {
                            action = 'UPDATE';
                        }
                    }
                }

                // If CREATE or UPDATE, we need to convert and send.
                if (action === 'CREATE' || action === 'UPDATE') {
                     const markdownContent = await fs.promises.readFile(file, 'utf-8');
                    const { html, thumb_media_id, digest, author } = await markdownService.convert(markdownContent, file, currentConfig.author);

                    if (!thumb_media_id) {
                        logger.error(`Could not generate a thumbnail for '${file}'. Skipping draft creation/update.`);
                        continue;
                    }

                    const title = path.basename(file, '.md');                    
                    if (action === 'UPDATE' && draftEntry) {
                         await wechatService.updateDraft(draftEntry.media_id, {
                            title,
                            content: html,
                            thumb_media_id,
                            digest: digest || '',
                            author: author || '',
                        });
                        dbService.performTransaction(() => {
                            if (articleEntry) dbService.updateArticleHash(articleEntry.id, hash);
                        });
                        logger.info(`Updated draft '${file}' (media_id: ${draftEntry.media_id}).`);
                    } else {
                         // CREATE
                        const media_id = await wechatService.createDraft({
                            title,
                            content: html,
                            thumb_media_id,
                            digest: digest || '',
                            author: author || '',
                        });
                        dbService.performTransaction(() => {
                            if (articleEntry) {
                                dbService.updateArticleHash(articleEntry.id, hash);
                                const result = dbService.insertDraft(articleEntry.id, media_id);
                                draftEntry = { id: result.lastInsertRowid as number, media_id };
                            } else {
                                const result = dbService.insertArticle(file, hash);
                                const articleId = result.lastInsertRowid as number;
                                const draftResult = dbService.insertDraft(articleId, media_id);
                                draftEntry = { id: draftResult.lastInsertRowid as number, media_id };
                                articleEntry = dbService.findArticleByPath(file);
                            }
                        });
                         logger.info(`Created new draft '${file}' (media_id: ${draftEntry?.media_id}).`);
                    }
                } else {
                    logger.info(`Draft for '${file}' is up-to-date on server.`);
                }
                
                // PUBLISH PHASE
                if (draftEntry) {
                     // Check if already published? (DB check)
                     // If we are in 'post' mode, maybe we want to force publish even if previously published?
                     // Usually 'post' implies "Make sure it's published".
                     // If we just updated it, we definitely want to publish.
                     // If we SKIPPED update, maybe it's already published?
                     // We should check DB for publication record for this draft.
                     
                     // Optimization: check if draftEntry has a publication record
                     // We don't have a direct method `isDraftPublished` but `hasArticleBeenPublished` checks by article ID.
                     // But we want to know if THIS draft is published.
                     // Let's assume for now we try to publish. If it fails (already published), we catch it?
                     // Or just publish. 'freepublish/submit' might return error if already published.
                     
                     logger.info(`Attempting to publish draft for '${file}'...`);
                     try {
                         const publishId = await wechatService.publishDraft(draftEntry.media_id);
                         dbService.insertPublication(draftEntry.id, publishId);
                         logger.info(`Successfully submitted '${file}' for publication with publish_id: ${publishId}.`);
                     } catch (e: any) {
                         // If error says "already published", we can ignore.
                         // Error code for "already published"?
                         // Usually it might say "article status error" etc.
                         logger.warn(`Publishing failed (maybe already published?): ${e.message}`);
                     }
                } else {
                    logger.warn(`No draft available for '${file}' to publish.`);
                }
            }
        } catch (error: any) {
            logger.error('An error occurred during the post process:', error.message);
            if (error.details) {
                logger.error('API Error Details:', error.details);
            }
        }
    });



program.parse(process.argv);



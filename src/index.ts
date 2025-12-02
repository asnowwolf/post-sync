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
        logger.info(`'create' command called for path: ${rawPath}`);
        logger.debug('Options:', options);

        try {
            const currentConfig = getConfig(options.profile);
            const dbService = new DbService();
            const wechatService = new WeChatService({
                appId: currentConfig.appId,
                appSecret: currentConfig.appSecret,
                wechatApiBaseUrl: currentConfig.wechatApiBaseUrl,
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

                // Check if article content is unchanged and a draft already exists
                if (articleEntry && articleEntry.source_hash === hash) {
                    logger.info(`Skipping '${file}' (content unchanged).`);

                    // Check if this article has ever been published
                    const hasBeenPublished = dbService.hasArticleBeenPublished(articleEntry.id);

                    if (hasBeenPublished && !options.yes) {
                        const confirmMessage = `Article '${file}' has already been published. Do you still want to create a new draft (and potentially re-publish)?`;
                        const userConfirmed = await confirmAction(confirmMessage);
                        if (!userConfirmed) {
                            logger.info(`Operation for '${file}' cancelled by user.`);
                            continue; // Skip to the next file
                        }
                    } else if (hasBeenPublished && options.yes) {
                         logger.info(`Article '${file}' has been published. Proceeding with new draft creation as --yes was specified.`);
                    } else {
                         logger.info(`Skipping '${file}' (content unchanged).`);
                         continue;
                    }
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
            const markdownService = new MarkdownService(wechatService);

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
                let draft: { id: number; media_id: string } | undefined;

                if (articleEntry && articleEntry.source_hash === hash) {
                    logger.info(`Skipping draft creation for '${file}' (content unchanged).`);
                    draft = dbService.findLatestDraftByArticleId(articleEntry.id);
                    if (!draft) {
                        logger.warn(`No existing draft found for unchanged article '${file}'. Re-creating draft.`);
                        // Fall through to create new draft
                    }
                }

                if (!draft) {
                    const markdownContent = await fs.promises.readFile(file, 'utf-8');
                    const { html, thumb_media_id } = await markdownService.convert(markdownContent, file);

                    if (!thumb_media_id) {
                        logger.error(`Could not generate a thumbnail for '${file}'. Skipping draft creation.`);
                        continue;
                    }

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
                            const result = dbService.insertDraft(articleEntry.id, media_id);
                            draft = { id: result.lastInsertRowid as number, media_id };
                            logger.info(`Updated hash for '${file}' and created new draft with media_id: ${media_id}`);
                        } else {
                            const result = dbService.insertArticle(file, hash);
                            const articleId = result.lastInsertRowid as number;
                            const draftResult = dbService.insertDraft(articleId, media_id);
                            draft = { id: draftResult.lastInsertRowid as number, media_id };
                            articleEntry = dbService.findArticleByPath(file); // Refresh articleEntry for subsequent checks
                            logger.info(`Inserted new article '${file}' and created draft with media_id: ${media_id}`);
                        }
                    });
                }

                if (draft) {
                    // Check if already published
                    // TODO: Add a method to check if a draft is already published in dbService
                    // For now, assume we always try to publish if a new draft is created or no existing publication record.
                    logger.info(`Attempting to publish draft for '${file}'...`);
                    const publishId = await wechatService.publishDraft(draft.media_id);
                    dbService.insertPublication(draft.id, publishId);
                    logger.info(`Successfully submitted '${file}' for publication with publish_id: ${publishId}.`);
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



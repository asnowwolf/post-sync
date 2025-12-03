import type {Tokens} from 'marked';
import {marked, Renderer} from 'marked';
import {WeChatService} from './wechat.service.js';
import {DbService} from './db.service.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import {FileError} from '../errors.js';
import {logger} from '../logger.js';
import * as yaml from 'js-yaml';
import * as crypto from 'crypto';

// Simplify by removing all highlighting logic for now
marked.use({
    gfm: true,
    pedantic: false,
});

export class MarkdownService {
    constructor(private wechatService: WeChatService, private dbService: DbService) {}

    private isUrl(s: string): boolean {
        try {
            new URL(s);
            return true;
        } catch (_) {
            return false;
        }
    }

    private async getImageBuffer(src: string, articlePath: string): Promise<{
        buffer: Buffer,
        contentType: string,
        filename: string
    }> {
        let buffer: Buffer;
        const filename = path.basename(src);

        try {
            if (this.isUrl(src)) {
                logger.debug(`Downloading image from URL: ${src}`);
                const response = await axios.get(src, {
                    responseType: 'arraybuffer',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': new URL(src).origin
                    },
                    proxy: false
                });
                buffer = Buffer.from(response.data);
            } else {
                const imagePath = path.resolve(path.dirname(articlePath), src);
                logger.debug(`Reading local image: ${imagePath}`);
                buffer = await fs.readFile(imagePath);
            }
        } catch (error: any) {
            logger.error(`Failed to get image buffer for ${src}. Error: ${error.message}`);
            throw error; // Re-throw to propagate the error
        }

        try {
            const metadata = await sharp(buffer).metadata();
            const contentType = `image/${metadata.format}`;

            if (!['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp'].includes(contentType)) {
                throw new FileError(`Unsupported image format for WeChat: ${metadata.format}`);
            }
            return {buffer, contentType, filename};
        } catch (error: any) {
            logger.error(`Failed to process image metadata for ${filename}. Error: ${error.message}`);
            throw error; // Re-throw to propagate the error
        }
    }

    private parseFrontMatter(content: string): { body: string; attributes: any } {
        try {
            const frontMatterRegex = /^---\n([\s\S]*?)\n---/;
            const match = content.match(frontMatterRegex);
            if (!match) {
                return { body: content, attributes: {} };
            }

            const frontMatterBlock = match[1];
            const body = content.replace(frontMatterRegex, '').trim();
            const attributes = yaml.load(frontMatterBlock) || {};

            return { body, attributes };
        } catch (error: any) {
            logger.error(`Failed to parse front matter. Error: ${error.message}`);
            throw error; // Re-throw to propagate the error
        }
    }

    public async convert(markdown: string, articlePath: string, defaultAuthor?: string, defaultDigest?: string): Promise<{
        html: string;
        thumb_media_id: string | null;
        digest?: string;
        author?: string;
    }> {
        let body: string;
        let attributes: any;
        try {
            ({ body, attributes } = this.parseFrontMatter(markdown));
        } catch (error: any) {
            logger.error(`Error during parseFrontMatter: ${error.message}`);
            throw error; // Re-throw to propagate
        }

        let tokens: any[];
        try {
            tokens = marked.lexer(body);
        } catch (error: any) {
            logger.error(`Error during marked.lexer: ${error.message}`);
            throw error; // Re-throw to propagate
        }
        
        let thumb_media_id: string | null = null;

        const dir = path.dirname(articlePath);
        const baseName = path.basename(articlePath, path.extname(articlePath));
        const coverImagePath = path.join(dir, `${baseName}.png`);

        try {
            await fs.access(coverImagePath); // Check if the file exists
            logger.info(`Found cover image for '${articlePath}' at '${coverImagePath}'`);
            const coverImageBuffer = await fs.readFile(coverImagePath);
            
            // Calculate SHA1 of the original cover image
            const hash = crypto.createHash('sha1').update(coverImageBuffer).digest('hex');
            const material = this.dbService.getMaterial(coverImagePath);
            
            let needsUpload = true;
            if (material && material.hash === hash) {
                const exists = await this.wechatService.checkMediaExists(material.media_id);
                if (exists) {
                    needsUpload = false;
                    thumb_media_id = material.media_id;
                    logger.info(`Cover image '${baseName}.png' exists on server and content unchanged. Using cached media_id.`);
                }
            }

            if (needsUpload) {
                // Resize to 1440x612 (2.35:1 aspect ratio) which is preferred by WeChat
                // Use 'cover' strategy to crop if necessary
                const thumbBuffer = await sharp(coverImageBuffer)
                    .resize({ 
                        width: 1440, 
                        height: 612,
                        fit: 'cover'
                    })
                    .jpeg({ quality: 90 })
                    .toBuffer();
                const result = await this.wechatService.addPermanentMaterial(thumbBuffer, 'image', `${baseName}.jpg`, 'image/jpeg');
                thumb_media_id = result.media_id;
                this.dbService.saveMaterial(coverImagePath, hash, thumb_media_id, result.url);
            }
        } catch (error: any) {
            logger.warn(`No cover image found for '${articlePath}' at '${coverImagePath}', or failed to process it. A thumbnail will not be set. Error: ${error.message}`);
            // Do not re-throw here, as missing cover image is not a critical error for article creation
        }

        const firstH1Index = tokens.findIndex(t => t.type === 'heading' && t.depth === 1);
        
        if (firstH1Index !== -1) {
            let potentialImageTokenIndex = firstH1Index + 1;
            
            // Skip space if present
            if (tokens[potentialImageTokenIndex]?.type === 'space') {
                potentialImageTokenIndex++;
            }

            const token = tokens[potentialImageTokenIndex];
            let isCoverImage = false;

            if (token?.type === 'image') {
                isCoverImage = true;
            } else if (token?.type === 'paragraph' && token.tokens && token.tokens.length === 1) {
                const child = token.tokens[0];
                if (child.type === 'image') {
                    isCoverImage = true;
                } else if (child.type === 'text') {
                    // Handle broken image syntax (e.g. spaces in filename) parsed as text
                    // Regex to match strictly ![]() pattern
                    if (/^!\[.*\]\(.*\)$/.test(child.text.trim())) {
                        isCoverImage = true;
                    }
                }
            }

            if (isCoverImage) {
                const href = (token.type === 'image') 
                    ? (token as Tokens.Image).href 
                    : ((token.tokens![0] as any).href || (token.tokens![0] as Tokens.Text).text);
                
                logger.info(`Removing cover image '${href}' from article body.`);
                
                tokens.splice(potentialImageTokenIndex, 1);
                
                // If we skipped a space, remove it too so we don't have extra spacing
                if (potentialImageTokenIndex > firstH1Index + 1) {
                     tokens.splice(firstH1Index + 1, 1);
                }
            }

            logger.info('Removing first H1 header from article body.');
            tokens.splice(firstH1Index, 1);
        }

        const imageTokens: Tokens.Image[] = [];
        try {
            marked.walkTokens(tokens, (token) => {
                if (token.type === 'image') {
                    imageTokens.push(token as Tokens.Image);
                }
            });
        } catch (error: any) {
            logger.error(`Error during marked.walkTokens: ${error.message}`);
            throw error; // Re-throw to propagate
        }

        for (const token of imageTokens) {
            try {
                const {buffer, contentType, filename} = await this.getImageBuffer(token.href, articlePath);
                
                const hash = crypto.createHash('sha1').update(buffer).digest('hex');
                let localPath = token.href;
                if (!this.isUrl(token.href)) {
                    localPath = path.resolve(path.dirname(articlePath), token.href);
                }

                const material = this.dbService.getMaterial(localPath);
                let url = material?.url;
                let needsUpload = true;

                if (material && material.hash === hash && material.media_id) {
                    const exists = await this.wechatService.checkMediaExists(material.media_id);
                    if (exists) {
                        needsUpload = false;
                        logger.info(`Image '${filename}' exists on server and content unchanged. Using cached URL.`);
                    }
                }

                if (needsUpload) {
                    const result = await this.wechatService.addPermanentMaterial(buffer, 'image', filename, contentType);
                    url = result.url;
                    this.dbService.saveMaterial(localPath, hash, result.media_id, url);
                }

                if (url) {
                    token.href = url;
                }
            } catch (error: any) {
                logger.error(`Failed to process image '${token.href}'. Error: ${error.message}`);
                throw error;
            }
        }

        let html: string;
        try {
            html = marked.parser(tokens);
        } catch (error: any) {
            logger.error(`Error during marked.parser: ${error.message}`);
            throw error; // Re-throw to propagate
        }
        
        const wrappedHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 10px;">${html}</div>`;

        // Logic: digest -> cover.prompt -> defaultDigest
        let resolvedDigest = attributes['digest'] || attributes?.cover?.prompt || defaultDigest;
        
        if (resolvedDigest && resolvedDigest.length > 120) {
            resolvedDigest = resolvedDigest.substring(0, 117) + '...';
        }

        const resolvedAuthor = attributes['author'] || defaultAuthor;

        return {
            html: wrappedHtml, 
            thumb_media_id,
            digest: resolvedDigest,
            author: resolvedAuthor,
        };
    }
}

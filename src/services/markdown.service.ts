import MarkdownIt from 'markdown-it';
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

export class MarkdownService {
    private md: MarkdownIt;

    constructor(private wechatService: WeChatService, private dbService: DbService) {
        this.md = new MarkdownIt({
            html: true,
            breaks: false,
            linkify: true,
            typographer: false,
        });
    }

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
            throw error;
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
            throw error;
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
            throw error;
        }
    }

    private injectInlineStyles(tokens: any[]) {
        for (const token of tokens) {
            if (token.type === 'paragraph_open') {
                token.attrSet('style', 'font-size: 17px; line-height: 1.8; margin-bottom: 20px; text-align: justify; letter-spacing: 0.05em; color: #333;');
            } else if (token.type === 'heading_open') {
                if (token.tag === 'h1') {
                    token.attrSet('style', 'font-size: 24px; font-weight: bold; margin: 30px 0 20px; text-align: center; color: #222;');
                } else if (token.tag === 'h2') {
                    token.attrSet('style', 'font-size: 20px; font-weight: bold; margin: 25px 0 15px; border-bottom: 2px solid #e0b656; padding-bottom: 8px; color: #222;');
                } else if (token.tag === 'h3') {
                    token.attrSet('style', 'font-size: 18px; font-weight: bold; margin: 20px 0 10px; color: #333;');
                }
            } else if (token.type === 'blockquote_open') {
                token.attrSet('style', 'border-left: 5px solid #d4af37; background-color: #fffaf0; padding: 20px; color: #555; margin: 25px 0; font-style: italic; border-radius: 4px;');
            } else if (token.type === 'fence') {
                 token.attrSet('style', 'background-color: #f8f8f8; padding: 18px; border-radius: 8px; overflow: auto; font-family: \'SFMono-Regular\', Consolas, \'Liberation Mono\', Menlo, Courier, monospace; font-size: 15px; margin-bottom: 20px; display: block;');
            }
        }
    }

    private transformListTokens(tokens: any[]) {
        const listStack: { type: 'ul' | 'ol', count: number, level: number }[] = [];
        
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            
            if (token.type === 'bullet_list_open') {
                listStack.push({ type: 'ul', count: 0, level: listStack.length });
                token.tag = 'div';
                token.attrSet('style', 'margin-bottom: 15px;'); 
            } else if (token.type === 'ordered_list_open') {
                const start = token.attrGet('start');
                listStack.push({ type: 'ol', count: start ? parseInt(start, 10) : 1, level: listStack.length });
                token.tag = 'div';
                token.attrSet('style', 'margin-bottom: 15px;');
            } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
                listStack.pop();
                token.tag = 'div';
            } else if (token.type === 'list_item_open') {
                token.tag = 'div';
                token.attrSet('style', 'margin-bottom: 5px;'); // Item container style
            } else if (token.type === 'list_item_close') {
                token.tag = 'div';
            } else if (token.type === 'paragraph_open') {
                if (listStack.length > 0) {
                    if (i > 0 && tokens[i-1].type === 'list_item_open') {
                         const ctx = listStack[listStack.length - 1];
                         let prefix = '';
                         if (ctx.type === 'ul') {
                             prefix = '•  '; 
                         } else {
                             prefix = `${ctx.count}. `;
                             ctx.count++;
                         }
                         
                         if (i + 1 < tokens.length && tokens[i+1].type === 'inline') {
                             const inlineToken = tokens[i+1];
                             if (!inlineToken.children) inlineToken.children = [];
                             
                             const prefixToken = {
                                 type: 'text',
                                 tag: '',
                                 attrs: null,
                                 map: null,
                                 nesting: 0,
                                 level: 0,
                                 children: null,
                                 content: prefix,
                                 markup: '',
                                 info: '',
                                 meta: null,
                                 block: false,
                                 hidden: false
                             };
                             inlineToken.children.unshift(prefixToken);
                         }
                         
                         const indent = (ctx.level + 1) * 20; 
                         token.attrSet('style', `font-size: 17px; line-height: 1.8; color: #333; margin: 0 0 0 ${indent}px; text-indent: -20px; padding-left: 0;`);
                         token.hidden = false; 
                    }
                }
            }
        }
    }

    public async convert(markdown: string, articlePath: string, defaultAuthor?: string, defaultDigest?: string): Promise<{
        html: string;
        thumb_media_id: string | null;
        digest?: string;
        author?: string;
        title?: string;
    }> {
        let body: string;
        let attributes: any;
        try {
            ({ body, attributes } = this.parseFrontMatter(markdown));
        } catch (error: any) {
            logger.error(`Error during parseFrontMatter: ${error.message}`);
            throw error;
        }

        const tokens = this.md.parse(body, {});
        
        let thumb_media_id: string | null = null;

        const dir = path.dirname(articlePath);
        const baseName = path.basename(articlePath, path.extname(articlePath));
        const coverImagePath = path.join(dir, `${baseName}.png`);

        // Cover Image Handling
        try {
            await fs.access(coverImagePath);
            logger.info(`Found cover image for '${articlePath}' at '${coverImagePath}'`);
            const coverImageBuffer = await fs.readFile(coverImagePath);
            
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
        }

        // Title Extraction Logic
        let title: string | undefined = attributes['title'];

        if (!title) {
            let h1Count = 0;
            let firstH1Content = '';
            
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].type === 'heading_open' && tokens[i].tag === 'h1') {
                    h1Count++;
                    if (i + 1 < tokens.length && tokens[i + 1].type === 'inline') {
                        firstH1Content = tokens[i + 1].content;
                    }
                }
            }

            if (h1Count === 1) {
                title = firstH1Content;
            }
        }

        // Inject Inline Styles (Generic)
        this.injectInlineStyles(tokens);

        // Transform Lists (Simulate with div/p) - Overwrites paragraph styles in lists
        this.transformListTokens(tokens);

        // Process Images in body
        for (const token of tokens) {
            if (token.type === 'inline' && token.children) {
                for (const child of token.children) {
                    if (child.type === 'image') {
                        // Inject Image Style (New Beautified Style)
                        child.attrSet('style', 'max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 25px auto; box-shadow: 0 5px 15px rgba(0,0,0,0.15);');
                        
                        const src = child.attrGet('src');
                        if (src) {
                            try {
                                const {buffer, contentType, filename} = await this.getImageBuffer(src, articlePath);
                                
                                const hash = crypto.createHash('sha1').update(buffer).digest('hex');
                                let localPath = src;
                                if (!this.isUrl(src)) {
                                    localPath = path.resolve(path.dirname(articlePath), src);
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
                                    child.attrSet('src', url);
                                }
                            } catch (error: any) {
                                logger.error(`Failed to process image '${src}'. Error: ${error.message}`);
                                throw error;
                            }
                        }
                    }
                }
            }
        }

        let html: string;
        try {
            html = this.md.renderer.render(tokens, this.md.options, {});
        } catch (error: any) {
            logger.error(`Error during markdown-it render: ${error.message}`);
            throw error; 
        }
        
        const wrappedHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Georgia, 'Times New Roman', serif; font-size: 17px; line-height: 1.8; color: #333; letter-spacing: 0.05em; padding: 25px;">${html}</div>`;

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
            title,
        };
    }
}
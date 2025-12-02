import type {Tokens} from 'marked';
import {marked, Renderer} from 'marked';
import {WeChatService} from './wechat.service.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import {FileError} from '../errors.js';
import {logger} from '../logger.js';
import * as yaml from 'js-yaml';

// Simplify by removing all highlighting logic for now
marked.use({
    gfm: true,
    pedantic: false,
});

export class MarkdownService {
    constructor(private wechatService: WeChatService) {}

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
                const response = await axios.get(src, {responseType: 'arraybuffer'});
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

    private getRenderer(): Renderer {
        const renderer = new Renderer();

        renderer.heading = ({ text, depth }: any) => {
             const styles: Record<number, string> = {
                 1: 'font-size: 24px; font-weight: bold; margin-top: 30px; margin-bottom: 15px; text-align: center; color: #333;',
                 2: 'font-size: 20px; font-weight: bold; margin-top: 25px; margin-bottom: 15px; border-left: 4px solid #42b983; padding-left: 10px; color: #333;',
                 3: 'font-size: 18px; font-weight: bold; margin-top: 20px; margin-bottom: 10px; color: #333;',
             };
             const style = styles[depth as number] || styles[3];
             return `<h${depth} style="${style}">${text}</h${depth}>`;
        };
        
        renderer.paragraph = ({ text }: any) => {
             return `<p style="font-size: 16px; line-height: 1.8; margin-bottom: 20px; color: #3f3f3f; text-align: justify;">${text}</p>`;
        };
        
        renderer.blockquote = ({ text }: any) => {
            return `<blockquote style="border-left: 4px solid #dfe2e5; padding: 10px 15px; color: #6a737d; background-color: #f8f9fa; margin-bottom: 20px; font-style: italic;">${text}</blockquote>`;
        };
        
        renderer.code = ({ text }: any) => {
             return `<pre style="background-color: #f6f8fa; padding: 16px; overflow: auto; border-radius: 6px; margin-bottom: 20px;"><code style="font-family: monospace; font-size: 14px; color: #333;">${text}</code></pre>`;
        };

        renderer.codespan = ({ text }: any) => {
             return `<code style="background-color: rgba(27,31,35,0.05); padding: 2px 4px; border-radius: 4px; font-family: monospace; color: #e96900; font-size: 90%;">${text}</code>`;
        };

        renderer.list = ({ body, ordered }: any) => {
             const type = ordered ? 'ol' : 'ul';
             return `<${type} style="margin-bottom: 20px; padding-left: 20px; color: #3f3f3f;">${body}</${type}>`;
        };
        
        renderer.listitem = ({ text }: any) => {
             return `<li style="line-height: 1.8; margin-bottom: 5px; font-size: 16px;">${text}</li>`;
        };
        
        renderer.image = ({ href, title, text }: any) => {
            return `<img src="${href}" alt="${text}" style="max-width: 100%; height: auto; border-radius: 4px; display: block; margin: 20px auto; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" title="${title || ''}">`;
        };
        
        renderer.strong = ({ text }: any) => {
            return `<strong style="font-weight: bold; color: #333;">${text}</strong>`;
        };

        return renderer;
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
            // Resize to 1440px width (standard high quality), preserve aspect ratio, high JPEG quality
            const thumbBuffer = await sharp(coverImageBuffer)
                .resize({ width: 1440, withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();
            const result = await this.wechatService.addPermanentMaterial(thumbBuffer, 'image', `${baseName}.jpg`, 'image/jpeg');
            thumb_media_id = result.media_id;
        } catch (error: any) {
            logger.warn(`No cover image found for '${articlePath}' at '${coverImagePath}', or failed to process it. A thumbnail will not be set. Error: ${error.message}`);
            // Do not re-throw here, as missing cover image is not a critical error for article creation
        }

        const firstH1Index = tokens.findIndex(t => t.type === 'heading' && t.depth === 1);
        
        if (firstH1Index !== -1) {
            let imageTokenIndex = -1;
            if (tokens[firstH1Index + 1]?.type === 'image') {
                imageTokenIndex = firstH1Index + 1;
            } else if (tokens[firstH1Index + 1]?.type === 'space' && tokens[firstH1Index + 2]?.type === 'image') {
                imageTokenIndex = firstH1Index + 2;
            }

            if (imageTokenIndex !== -1) {
                const imageToken = tokens[imageTokenIndex] as Tokens.Image;
                logger.info(`Removing cover image '${imageToken.href}' from article body.`);
                tokens.splice(imageTokenIndex, 1);
                if (tokens[imageTokenIndex - 1]?.type === 'space' && imageTokenIndex > 0) {
                    tokens.splice(imageTokenIndex - 1, 1);
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
                // Use addPermanentMaterial as requested, although typically article images use uploadImg.
                // Assuming user wants managed assets. 
                const result = await this.wechatService.addPermanentMaterial(buffer, 'image', filename, contentType);
                token.href = result.url;
            } catch (error: any) {
                logger.warn(`Could not upload image '${token.href}', leaving original source. Error: ${error.message}`);
            }
        }

        let html: string;
        try {
            html = marked.parser(tokens, { renderer: this.getRenderer() });
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

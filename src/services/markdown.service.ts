import type {Tokens} from 'marked';
import {marked} from 'marked';
import {WeChatService} from './wechat.service.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import {FileError} from '../errors.js';
import {logger} from '../logger.js';

// Simplify by removing all highlighting logic for now
marked.use({
    gfm: true,
    pedantic: false,
});


export class MarkdownService {
    constructor(private wechatService: WeChatService) {
        // Now the constructor is simpler, as the options are set globally.
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

        if (this.isUrl(src)) {
            logger.debug(`Downloading image from URL: ${src}`);
            const response = await axios.get(src, {responseType: 'arraybuffer'});
            buffer = Buffer.from(response.data);
        } else {
            const imagePath = path.resolve(path.dirname(articlePath), src);
            logger.debug(`Reading local image: ${imagePath}`);
            buffer = await fs.readFile(imagePath);
        }

        const metadata = await sharp(buffer).metadata();
        const contentType = `image/${metadata.format}`;

        if (!['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp'].includes(contentType)) {
            throw new FileError(`Unsupported image format for WeChat: ${metadata.format}`);
        }

        return {buffer, contentType, filename};
    }

    public async convert(markdown: string, articlePath: string): Promise<{
        html: string;
        thumb_media_id: string | null
    }> {
        const tokens = marked.lexer(markdown);
        let thumb_media_id: string | null = null;

        // New logic: Look for a cover image with the same name as the article
        const dir = path.dirname(articlePath);
        const baseName = path.basename(articlePath, path.extname(articlePath));
        const coverImagePath = path.join(dir, `${baseName}.png`);

        try {
            await fs.access(coverImagePath); // Check if the file exists
            logger.info(`Found cover image for '${articlePath}' at '${coverImagePath}'`);
            const coverImageBuffer = await fs.readFile(coverImagePath);
            const thumbBuffer = await sharp(coverImageBuffer).resize(360, 360, {fit: 'inside'}).jpeg().toBuffer();
            const result = await this.wechatService.addPermanentMaterial(thumbBuffer, 'image', `${baseName}.jpg`, 'image/jpeg');
            thumb_media_id = result.media_id;
        } catch (error: any) {
            logger.warn(`No cover image found for '${articlePath}' at '${coverImagePath}', or failed to process it. A thumbnail will not be set.`);
        }

        // New logic: Remove the cover image from the article body
        const firstH1Index = tokens.findIndex(t => t.type === 'heading' && t.depth === 1);
        if (firstH1Index !== -1) {
            // Check if the next token is a space and the one after is an image
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
                // Also remove the preceding space if it exists
                if (tokens[imageTokenIndex - 1]?.type === 'space' && imageTokenIndex > 0) {
                    tokens.splice(imageTokenIndex - 1, 1);
                }
            }
        }

        const imageTokens: Tokens.Image[] = [];
        marked.walkTokens(tokens, (token) => {
            if (token.type === 'image') {
                imageTokens.push(token as Tokens.Image);
            }
        });

        for (const token of imageTokens) {
            try {
                const {buffer, contentType, filename} = await this.getImageBuffer(token.href, articlePath);
                const newUrl = await this.wechatService.uploadArticleImage(buffer, filename, contentType);
                token.href = newUrl;
            } catch (error: any) {
                logger.warn(`Could not upload image '${token.href}', leaving original source. Error: ${error.message}`);
            }
        }

        const html = marked.parser(tokens);
        return {html, thumb_media_id};
    }
}

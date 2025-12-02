import {beforeEach, describe, expect, it, vi} from 'vitest';
import {MarkdownService} from './markdown.service.js';
import {WeChatService} from './wechat.service.js';
import axios from 'axios';
import sharp from 'sharp';
import {marked} from 'marked';
import * as fs from 'fs/promises';

// Mock dependencies
vi.mock('axios');
vi.mock('sharp');
// Mock fs/promises using a factory
vi.mock('fs/promises', async () => {
    return {
        access: vi.fn(),
        readFile: vi.fn(),
    };
});

// Mock marked library
vi.mock('marked', () => {
    return {
        marked: {
            use: vi.fn(),
            lexer: vi.fn(),
            walkTokens: vi.fn((tokens, callback) => {
                tokens.forEach(callback);
            }),
            parser: vi.fn(),
            parse: vi.fn(),
        },
    };
});

// Mock WeChatService
const mockUploadArticleImage = vi.fn();
const mockUploadTemporaryMedia = vi.fn();
const mockWeChatService = {
    uploadArticleImage: mockUploadArticleImage,
    uploadTemporaryMedia: mockUploadTemporaryMedia,
} as unknown as WeChatService;

describe('MarkdownService', () => {
    let markdownService: MarkdownService;
    const mockSharpInstance = {
        resize: vi.fn().mockReturnThis(),
        jpeg: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from('processed-image-buffer')),
        metadata: vi.fn().mockResolvedValue({format: 'jpeg'}),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        markdownService = new MarkdownService(mockWeChatService);
        (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockSharpInstance);

        // Default mocks
        (marked.lexer as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (marked.parser as unknown as ReturnType<typeof vi.fn>).mockReturnValue('<html></html>');
        (marked.parse as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('<html></html>');
    });

    it('should find and upload a cover image by convention', async () => {
        const articlePath = '/test/path/article-one.md';
        const markdown = '# Title\nSome content.';
        const coverImagePath = '/test/path/article-one.png';

        (fs.access as any).mockResolvedValue(undefined);
        (fs.readFile as any).mockResolvedValue(Buffer.from('cover-image-buffer'));
        mockUploadTemporaryMedia.mockResolvedValue('thumb_media_id_123');

        const {thumb_media_id} = await markdownService.convert(markdown, articlePath);

        expect(fs.access).toHaveBeenCalledWith(coverImagePath);
        expect(fs.readFile).toHaveBeenCalledWith(coverImagePath);
        expect(mockSharpInstance.resize).toHaveBeenCalledWith(360, 360, {fit: 'inside'});
        expect(mockUploadTemporaryMedia).toHaveBeenCalledWith(expect.any(Buffer), 'thumb', 'article-one.jpg', 'image/jpeg');
        expect(thumb_media_id).toBe('thumb_media_id_123');
    });

    it('should upload local images found in markdown and replace src', async () => {
        const articlePath = '/test/path/article-two.md';
        const markdown = '![local image](./images/local.png)';
        const localImagePath = '/test/path/images/local.png';

        (fs.access as any).mockRejectedValue(new Error('no cover'));
        (fs.readFile as any).mockResolvedValue(Buffer.from('local-image-buffer'));
        mockUploadArticleImage.mockResolvedValue('http://wechat.url/new-local-image');

        const tokens = [{type: 'image', href: './images/local.png'}];
        (marked.lexer as unknown as ReturnType<typeof vi.fn>).mockReturnValue(tokens);

        const {html} = await markdownService.convert(markdown, articlePath);

        expect(fs.readFile).toHaveBeenCalledWith(localImagePath);
        expect(mockUploadArticleImage).toHaveBeenCalledWith(Buffer.from('local-image-buffer'), 'local.png', 'image/jpeg');
        expect(tokens[0].href).toBe('http://wechat.url/new-local-image');
    });

    it('should download and upload remote images and replace src', async () => {
        const articlePath = '/test/path/article-three.md';
        const markdown = '![remote image](http://example.com/remote.gif)';
        const remoteImageUrl = 'http://example.com/remote.gif';

        (fs.access as any).mockRejectedValue(new Error('no cover'));
        (axios.get as any).mockResolvedValue({data: Buffer.from('remote-image-buffer')});
        mockUploadArticleImage.mockResolvedValue('http://wechat.url/new-remote-image');
        (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            ...mockSharpInstance,
            metadata: vi.fn().mockResolvedValue({format: 'gif'}),
        });

        const tokens = [{type: 'image', href: remoteImageUrl}];
        (marked.lexer as unknown as ReturnType<typeof vi.fn>).mockReturnValue(tokens);

        await markdownService.convert(markdown, articlePath);

        expect(axios.get).toHaveBeenCalledWith(remoteImageUrl, {responseType: 'arraybuffer'});
        expect(mockUploadArticleImage).toHaveBeenCalledWith(Buffer.from('remote-image-buffer'), 'remote.gif', 'image/gif');
        expect(tokens[0].href).toBe('http://wechat.url/new-remote-image');
    });

    it('should remove the cover image reference from the article body', async () => {
        const articlePath = '/test/path/article-four.md';
        const markdown = '# Title\n![cover](./article-four.png)\nSome other content.';

        (fs.access as any).mockResolvedValue(undefined);
        (fs.readFile as any).mockResolvedValue(Buffer.from('cover-image-buffer'));
        mockUploadTemporaryMedia.mockResolvedValue('thumb_media_id_456');

        // Mock tokens reflecting the markdown structure: H1, Space, Image, Text
        const tokens = [
            {type: 'heading', depth: 1},
            {type: 'space'},
            {type: 'image', href: './article-four.png'},
            {type: 'paragraph', text: 'Some other content.'}
        ];
        (marked.lexer as unknown as ReturnType<typeof vi.fn>).mockReturnValue(tokens);

        const {thumb_media_id} = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBe('thumb_media_id_456');
        expect(tokens.find((t: any) => t.type === 'image')).toBeUndefined();
    });
});

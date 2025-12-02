import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownService } from './markdown.service.js';
import { WeChatService } from './wechat.service.js';
import axios from 'axios';
import sharp from 'sharp';
import { marked } from 'marked';
import * as fs from 'fs/promises';
import * as fileUtil from '../utils/file.util';

// Mock dependencies
vi.mock('axios');
vi.mock('sharp');
vi.mock('fs/promises', () => ({
    access: vi.fn(),
    readFile: vi.fn(),
}));
vi.mock('../utils/file.util.js', async (importOriginal) => {
    const actualFileUtil = await importOriginal<typeof fileUtil>();
    const mockFileUtil = await import('../utils/__mocks__/file.util.ts'); // Import the new mock file
    return {
        ...actualFileUtil,
        ...mockFileUtil, // Spread the exports from the new mock file
    };
});

// Helper to create mock image buffers based on format
const createMockImageBuffer = (format: string) => {
    if (format === 'png') return Buffer.from('PNG_IMAGE_DATA');
    if (format === 'jpeg') return Buffer.from('JPEG_IMAGE_DATA');
    if (format === 'gif') return Buffer.from('GIF_IMAGE_DATA');
    return Buffer.from('UNKNOWN_IMAGE_DATA');
};

// Mock marked library - simpler mock without actual marked import
vi.mock('marked', () => ({
    marked: {
        use: vi.fn(),
        lexer: vi.fn((markdown) => {
            const tokens: any[] = [];
            if (markdown === '# Title\n![cover](./article-four.png)\nSome other content.') {
                tokens.push({ type: 'heading', depth: 1, text: 'Title' });
                tokens.push({ type: 'space', raw: '\n' });
                tokens.push({ type: 'image', href: './article-four.png', text: 'cover' });
                tokens.push({ type: 'space', raw: '\n' });
                tokens.push({ type: 'paragraph', text: 'Some other content.' });
                return tokens;
            }
            if (markdown.includes('# Title')) tokens.push({ type: 'heading', depth: 1, text: 'Title' });
            if (markdown.includes('![local image]')) tokens.push({ type: 'image', href: './images/local.png', text: 'local image' });
            if (markdown.includes('![remote image]')) tokens.push({ type: 'image', href: 'http://example.com/remote.gif', text: 'remote image' });
            if (markdown.includes('Some other content.')) tokens.push({ type: 'paragraph', text: 'Some other content.', raw: 'Some other content.' });
            
            // Default: add a paragraph if no other tokens were added
            if (tokens.length === 0 && markdown.trim() !== '') {
                tokens.push({ type: 'paragraph', text: markdown.trim(), raw: markdown.trim() });
            }
            return tokens;
        }),
        walkTokens: vi.fn((tokens, callback) => {
            // Simulate walking tokens and allow callback to modify them
            // We need to iterate over a copy or handle mutations carefully if we were modifying the structure,
            // but here we just modify properties of tokens.
            // Note: marked.walkTokens typically recurses, but here we just flat map for simplicity in this mock
            // unless we have nested tokens.
            for (const token of tokens) {
                 callback(token);
            }
        }),
        parser: vi.fn((tokens) => {
            // Simulate basic HTML generation from tokens
            let html = '';
            for (const token of tokens) {
                if (token.type === 'heading' && token.depth === 1) {
                    html += `<h1>${token.text}</h1>`;
                } else if (token.type === 'paragraph') {
                    html += `<p>${token.text}</p>`;
                } else if (token.type === 'image') {
                    // During testing, if image is still here, convert it to an img tag for verification
                    html += `<img src="${token.href}" alt="${token.text}">`;
                } else if (token.type === 'space') {
                    html += '\n'; // Simulate line breaks for accurate HTML representation
                }
            }
            return html;
        }),
        parse: vi.fn(), // Since parser is used, parse might not be directly called for token array.

    },
}));

// Mock WeChatService


const mockWeChatService: vi.Mocked<WeChatService> = {
    uploadArticleImage: vi.fn(),
    uploadTemporaryMedia: vi.fn(),
    addPermanentMaterial: vi.fn(),
};

let mockSharpInstance: any;

describe('MarkdownService', () => {
    let markdownService: MarkdownService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSharpInstance = {
            resize: vi.fn().mockReturnThis(),
            jpeg: vi.fn().mockReturnThis(),
            png: vi.fn().mockReturnThis(),
            toBuffer: vi.fn().mockResolvedValue(Buffer.from('processed-image-buffer')),
            metadata: vi.fn().mockResolvedValue({ format: 'jpeg' }), // Default to jpeg
        };
        markdownService = new MarkdownService(mockWeChatService);
        (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockSharpInstance);

        // Reset default mocks for marked to ensure actual behavior unless specifically overridden


        // Default mock for file system access
        vi.mocked(fs.access).mockRejectedValue(new Error('File not found')); // Default no cover image
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png')); // Default to PNG image data
        vi.mocked(fileUtil.getFileHash).mockResolvedValue('mock_hash');
    });

    it('should find and upload a cover image by convention', async () => {
        const articlePath = '/test/path/article-one.md';
        const markdown = '# Title\nSome content.';
        const coverImagePath = '/test/path/article-one.png';

        vi.mocked(fs.access).mockResolvedValue(undefined); // Simulate cover image exists
        vi.mocked(fs.readFile).mockResolvedValueOnce(createMockImageBuffer('png')); // PNG cover image
        mockWeChatService.addPermanentMaterial.mockResolvedValue({ media_id: 'thumb_media_id_123', url: 'mock_url', item: [] });
        vi.mocked(mockSharpInstance.metadata).mockResolvedValueOnce({ format: 'png' }); // Ensure sharp returns png metadata

        const { thumb_media_id } = await markdownService.convert(markdown, articlePath);

        expect(fs.access).toHaveBeenCalledWith(coverImagePath);
        expect(fs.readFile).toHaveBeenCalledWith(coverImagePath);
        expect(mockSharpInstance.resize).toHaveBeenCalledWith(360, 360, { fit: 'inside' });
        expect(mockSharpInstance.jpeg).toHaveBeenCalled(); // Should call jpeg() for JPEG output
        expect(mockWeChatService.addPermanentMaterial).toHaveBeenCalledWith(expect.any(Buffer), 'image', 'article-one.jpg', 'image/jpeg');
        expect(thumb_media_id).toBe('thumb_media_id_123');
    });

    it('should upload local images found in markdown and replace src', async () => {
        const articlePath = '/test/path/article-two.md';
        const markdown = '![local image](./images/local.png)';
        const localImagePath = '/test/path/images/local.png';

        vi.mocked(fs.readFile).mockResolvedValueOnce(createMockImageBuffer('png')); // PNG local image
        mockWeChatService.uploadArticleImage.mockResolvedValue('http://wechat.url/new-local-image');
        vi.mocked(mockSharpInstance.metadata).mockResolvedValueOnce({ format: 'png' });

        const { html } = await markdownService.convert(markdown, articlePath);

        expect(fs.readFile).toHaveBeenCalledWith(localImagePath);
        expect(mockWeChatService.uploadArticleImage).toHaveBeenCalledWith(expect.any(Buffer), 'local.png', 'image/png');
        expect(html).toContain('http://wechat.url/new-local-image');
    });

    it('should download and upload remote images and replace src', async () => {
        const articlePath = '/test/path/article-three.md';
        const markdown = '![remote image](http://example.com/remote.gif)';
        const remoteImageUrl = 'http://example.com/remote.gif';

        vi.mocked(axios.get).mockResolvedValue({ data: createMockImageBuffer('gif') });
        mockWeChatService.uploadArticleImage.mockResolvedValue('http://wechat.url/new-remote-image');
        vi.mocked(mockSharpInstance.metadata).mockResolvedValueOnce({ format: 'gif' });
        vi.mocked(mockSharpInstance.metadata).mockResolvedValueOnce({ format: 'gif' });

        const { html } = await markdownService.convert(markdown, articlePath);

        expect(axios.get).toHaveBeenCalledWith(remoteImageUrl, { responseType: 'arraybuffer' });
        expect(mockWeChatService.uploadArticleImage).toHaveBeenCalledWith(expect.any(Buffer), 'remote.gif', 'image/gif');
        expect(html).toContain('http://wechat.url/new-remote-image'); // Assert that URL is replaced in HTML
    });

    it('should remove the cover image reference from the article body', async () => {
        const articlePath = '/test/path/article-four.md';
        const markdown = '# Title\n![cover](./article-four.png)\nSome other content.';
        const coverImagePath = '/test/path/article-four.png';

        vi.mocked(fs.access).mockResolvedValue(undefined); // Simulate cover image exists
        vi.mocked(fs.readFile).mockResolvedValueOnce(createMockImageBuffer('png'));
        vi.mocked(mockWeChatService.addPermanentMaterial).mockResolvedValue({ media_id: 'thumb_media_id_456', url: 'mock_url', item: [] });
        vi.mocked(mockSharpInstance.metadata).mockResolvedValueOnce({ format: 'png' });

        const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBe('thumb_media_id_456');
        expect(html).not.toContain('./article-four.png'); // Ensure reference is removed from HTML
        expect(html).toContain('<h1>Title</h1>\n<p>Some other content.</p>');
    });
});
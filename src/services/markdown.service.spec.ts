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
    const mockFileUtil = await import('../utils/__mocks__/file.util.ts'); 
    return {
        ...actualFileUtil,
        ...mockFileUtil, 
    };
});

// Helper to create mock image buffers based on format
const createMockImageBuffer = (format: string) => {
    if (format === 'png') return Buffer.from('PNG_IMAGE_DATA');
    if (format === 'jpeg') return Buffer.from('JPEG_IMAGE_DATA');
    if (format === 'gif') return Buffer.from('GIF_IMAGE_DATA');
    return Buffer.from('UNKNOWN_IMAGE_DATA');
};

// Mock marked
vi.mock('marked', () => ({
    marked: {
        use: vi.fn(),
        lexer: vi.fn((markdown) => {
            const tokens: any[] = [];
            // Basic manual lexer for testing
            if (markdown.includes('# Title')) tokens.push({ type: 'heading', depth: 1, text: 'Title' });
            if (markdown.includes('![cover](./article-four.png)')) {
                 tokens.push({ type: 'space', raw: '\n' });
                 tokens.push({ type: 'image', href: './article-four.png', text: 'cover' });
            }
            if (markdown.includes('![local image]')) tokens.push({ type: 'image', href: './images/local.png', text: 'local image' });
            if (markdown.includes('![remote image]')) tokens.push({ type: 'image', href: 'http://example.com/remote.gif', text: 'remote image' });
            if (markdown.includes('![body-image](./body.png)')) tokens.push({ type: 'image', href: './body.png', text: 'body-image' });
            if (markdown.includes('Some other content.')) {
                 if (tokens.length > 0) tokens.push({ type: 'space', raw: '\n' });
                 tokens.push({ type: 'paragraph', text: 'Some other content.' });
            }
            if (tokens.length === 0 && markdown.trim() !== '') {
                tokens.push({ type: 'paragraph', text: markdown.trim(), raw: markdown.trim() });
            }
            return tokens;
        }),
        walkTokens: vi.fn((tokens, callback) => {
            tokens.forEach((t: any) => callback(t));
        }),
        parser: vi.fn((tokens) => {
            let html = '';
            for (const token of tokens) {
                if (token.type === 'heading') {
                    html += `<h1>${token.text}</h1>`;
                } else if (token.type === 'paragraph') {
                    html += `<p>${token.text}</p>`;
                } else if (token.type === 'image') {
                    html += `<img src="${token.href}">`;
                }
            }
            return html;
        }),
    },
    Renderer: class {
        heading() { return ''; }
        paragraph() { return ''; }
        image() { return ''; }
        blockquote() { return ''; }
        code() { return ''; }
        codespan() { return ''; }
        list() { return ''; }
        listitem() { return ''; }
        strong() { return ''; }
    },
}));

// Mock WeChatService
const mockWeChatService = {
    uploadArticleImage: vi.fn(),
    uploadTemporaryMedia: vi.fn(),
    addPermanentMaterial: vi.fn(),
} as unknown as WeChatService;

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
            metadata: vi.fn().mockResolvedValue({ format: 'jpeg' }), 
        };
        markdownService = new MarkdownService(mockWeChatService);
        (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockSharpInstance);

        vi.mocked(fs.access).mockRejectedValue(new Error('File not found')); 
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png')); 
        vi.mocked(fileUtil.getFileHash).mockResolvedValue('mock_hash');
    });

    it('should extract digest from frontmatter', async () => {
        const articlePath = '/test/path/article-fm.md';
        const markdown = '---\ndigest: This is a summary.\n---\n# Title\nSome other content.';
        
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        mockWeChatService.addPermanentMaterial = vi.fn().mockResolvedValue({ media_id: 'thumb_1', url: 'url' });
        
        const { digest, html } = await markdownService.convert(markdown, articlePath);
        
        expect(digest).toBe('This is a summary.');
        // H1 should be removed
        expect(html).not.toContain('<h1>Title</h1>');
        expect(html).toContain('Some other content');
    });

    it('should use default digest if no digest and no cover.prompt in frontmatter', async () => {
        const articlePath = '/test/path/article-no-digest.md';
        const markdown = '---\nkey: value\n---\n# Title\nSome other content.';
        
        const { digest } = await markdownService.convert(markdown, articlePath, undefined, 'default_cover_prompt');
        expect(digest).toBe('default_cover_prompt');
    });

    it('should use cover.prompt as digest if digest is missing in frontmatter', async () => {
        const articlePath = '/test/path/article-cover-prompt.md';
        const markdown = `---
cover:
  prompt: "This is the prompt digest"
---
# Title
Content`;
        
        const { digest } = await markdownService.convert(markdown, articlePath, undefined, 'default');
        expect(digest).toBe('This is the prompt digest');
    });

    it('should use author from frontmatter', async () => {
        const articlePath = '/test/path/article-author-fm.md';
        const markdown = '---\nauthor: Frontmatter Author\n---\n# Title\nSome content.';
        
        const { author } = await markdownService.convert(markdown, articlePath, 'Default Config Author');
        expect(author).toBe('Frontmatter Author');
    });

    it('should use default author from config if no author in frontmatter', async () => {
        const articlePath = '/test/path/article-no-author-fm.md';
        const markdown = '# Title\nSome content.';
        
        const { author } = await markdownService.convert(markdown, articlePath, 'Default Config Author');
        expect(author).toBe('Default Config Author');
    });

    it('should have undefined author if neither frontmatter nor default author is provided', async () => {
        const articlePath = '/test/path/article-no-author.md';
        const markdown = '# Title\nSome content.';
        
        const { author } = await markdownService.convert(markdown, articlePath);
        expect(author).toBeUndefined();
    });

    it('should remove the first H1 and cover image reference, and use addPermanentMaterial for body images', async () => {
        const articlePath = '/test/path/article-four.md';
        const markdown = '# Title\n![cover](./article-four.png)\nSome other content.\n![body-image](./body.png)';
        
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        // Mock readFile to return buffer
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png'));
        
        // Mock addPermanentMaterial to return different values based on call
        mockWeChatService.addPermanentMaterial = vi.fn()
            .mockResolvedValueOnce({ media_id: 'cover_media_id', url: 'cover_url' }) // 1st call: Cover image
            .mockResolvedValueOnce({ media_id: 'body_media_id', url: 'body_image_url' }); // 2nd call: Body image

        vi.mocked(mockSharpInstance.metadata).mockResolvedValue({ format: 'png' });

        const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBe('cover_media_id');
        expect(html).not.toContain('./article-four.png'); 
        expect(html).not.toContain('<h1>Title</h1>');
        
        // Verify body image replacement
        expect(html).toContain('<img src="body_image_url"');
        expect(mockWeChatService.addPermanentMaterial).toHaveBeenCalledTimes(2);
        // Ensure uploadArticleImage is NOT called
        expect(mockWeChatService.uploadArticleImage).not.toHaveBeenCalled();
    });

    it('should return null thumb_media_id if cover image upload fails', async () => {
        const articlePath = '/test/path/article-upload-fail.md';
        const markdown = '# Title\nContent';
        
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        vi.mocked(fs.readFile).mockResolvedValueOnce(createMockImageBuffer('png'));
        mockWeChatService.addPermanentMaterial = vi.fn().mockRejectedValue(new Error('Upload failed'));

        const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBeNull();
        expect(html).not.toContain('<h1>Title</h1>');
    });
});
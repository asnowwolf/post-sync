import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownService } from './markdown.service.js';
import { WeChatService } from './wechat.service.js';
import { DbService } from './db.service.js'; // Import DbService
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
            if (markdown.includes('![para-cover](./cover.png)')) {
                 tokens.push({ type: 'space', raw: '\n' });
                 tokens.push({ 
                     type: 'paragraph', 
                     tokens: [{ type: 'image', href: './cover.png', text: 'para-cover' }] 
                 });
            }
            if (markdown.includes('![](./broken cover.png)')) {
                 tokens.push({ type: 'space', raw: '\n' });
                 tokens.push({ 
                     type: 'paragraph', 
                     tokens: [{ type: 'text', text: '![](./broken cover.png)', raw: '![](./broken cover.png)' }] 
                 });
            }
            if (markdown.includes('![local image]')) tokens.push({ type: 'image', href: './images/local.png', text: 'local image' });
            if (markdown.includes('![remote image]')) tokens.push({ type: 'image', href: 'http://example.com/remote.gif', text: 'remote image' });
            if (markdown.includes('![body-image](./body.png)')) tokens.push({ type: 'image', href: './body.png', text: 'body-image' });
            if (markdown.includes('![](./fail.png)')) tokens.push({ type: 'image', href: './fail.png', text: '' });
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
    addPermanentMaterial: vi.fn(),
    checkMediaExists: vi.fn(), // Add mock for checkMediaExists
} as unknown as WeChatService;

// Mock DbService
const mockDbService = {
    getMaterial: vi.fn(),
    saveMaterial: vi.fn(),
} as unknown as DbService;

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
        // Pass mockDbService to MarkdownService
        markdownService = new MarkdownService(mockWeChatService, mockDbService);
        (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockSharpInstance);

        vi.mocked(fs.access).mockRejectedValue(new Error('File not found')); 
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png')); 
        vi.mocked(fileUtil.getFileHash).mockResolvedValue('mock_hash');
        mockWeChatService.checkMediaExists.mockResolvedValue(true); // Default to media existing on server
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
        vi.mocked(fs.readFile).mockImplementation((p: string) => {
            if (p.includes('article-four.png')) return Promise.resolve(createMockImageBuffer('png'));
            if (p.includes('body.png')) return Promise.resolve(createMockImageBuffer('png'));
            return Promise.reject(new Error('File not found'));
        });
        
        // Mock getMaterial to return undefined (no cached material)
        mockDbService.getMaterial.mockReturnValue(undefined);

        // Mock checkMediaExists to return false (even if there was a media_id, it doesn't exist on server)
        mockWeChatService.checkMediaExists.mockResolvedValue(false);

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
        expect(mockDbService.saveMaterial).toHaveBeenCalledTimes(2);
        expect(mockDbService.saveMaterial).toHaveBeenCalledWith(
            expect.stringContaining('article-four.png'),
            expect.any(String), // SHA1 hash
            'cover_media_id',
            'cover_url'
        );
        expect(mockDbService.saveMaterial).toHaveBeenCalledWith(
            expect.stringContaining('body.png'),
            expect.any(String), // SHA1 hash
            'body_media_id',
            'body_image_url'
        );
    });

    it('should return null thumb_media_id if cover image upload fails', async () => {
        const articlePath = '/test/path/article-upload-fail.md';
        const markdown = '# Title\nContent';
        
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        vi.mocked(fs.readFile).mockResolvedValueOnce(createMockImageBuffer('png'));
        
        // Mock getMaterial to return undefined (no cached material)
        mockDbService.getMaterial.mockReturnValue(undefined);
        // Mock checkMediaExists to return false
        mockWeChatService.checkMediaExists.mockResolvedValue(false);

        mockWeChatService.addPermanentMaterial = vi.fn().mockRejectedValue(new Error('Upload failed'));

        const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBeNull();
        expect(html).not.toContain('<h1>Title</h1>');
        expect(mockDbService.saveMaterial).not.toHaveBeenCalled();
    });

    it('should remove cover image wrapped in paragraph', async () => {
        const articlePath = '/test/path/article-para-cover.md';
        const markdown = '# Title\n![para-cover](./cover.png)\nContent';
        
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        vi.mocked(fs.readFile).mockImplementation((p) => {
             if (p.includes('cover.png')) return Promise.resolve(createMockImageBuffer('png'));
             return Promise.reject(new Error('File not found'));
        });
        
        mockDbService.getMaterial.mockReturnValue(undefined);
        mockWeChatService.checkMediaExists.mockResolvedValue(false);
        mockWeChatService.addPermanentMaterial = vi.fn().mockResolvedValue({ media_id: 'cover_id', url: 'url' });

        const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBe('cover_id');
        expect(html).not.toContain('<h1>Title</h1>');
        expect(html).not.toContain('cover.png');
    });

    it('should remove broken cover image syntax (text) wrapped in paragraph', async () => {
        const articlePath = '/test/path/article-broken-cover.md';
        const markdown = '# Title\n![](./broken cover.png)\nContent';
        
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        
        mockDbService.getMaterial.mockReturnValue(undefined);
        mockWeChatService.checkMediaExists.mockResolvedValue(false);
        mockWeChatService.addPermanentMaterial = vi.fn().mockResolvedValue({ media_id: 'cover_id', url: 'url' });

        const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

        expect(thumb_media_id).toBe('cover_id');
        expect(html).not.toContain('<h1>Title</h1>');
        expect(html).not.toContain('broken cover.png');
        expect(html).not.toContain('![]');
    });

    it('should throw error when image upload fails', async () => {
        const articlePath = '/test/path/article-upload-fail-body.md';
        const markdown = '![](./fail.png)';
        
        vi.mocked(fs.access).mockRejectedValue(new Error('No cover')); 
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png'));
        
        mockDbService.getMaterial.mockReturnValue(undefined);
        mockWeChatService.checkMediaExists.mockResolvedValue(false);
        mockWeChatService.addPermanentMaterial = vi.fn().mockRejectedValue(new Error('Upload failed'));

        await expect(markdownService.convert(markdown, articlePath)).rejects.toThrow('Upload failed');
    });
});
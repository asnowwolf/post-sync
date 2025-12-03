import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownService } from './markdown.service.js';
import { WeChatService } from './wechat.service.js';
import { DbService } from './db.service.js'; 
import axios from 'axios';
import sharp from 'sharp';
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

// Mock WeChatService
const mockWeChatService = {
    addPermanentMaterial: vi.fn(),
    checkMediaExists: vi.fn(), 
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
        markdownService = new MarkdownService(mockWeChatService, mockDbService);
        (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockSharpInstance);

        // Default mocks for fs functions to always succeed unless overridden in specific tests
        vi.mocked(fs.access).mockResolvedValue(undefined); 
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png')); 
        vi.mocked(fileUtil.getFileHash).mockResolvedValue('mock_hash');
        mockWeChatService.checkMediaExists.mockResolvedValue(true); 
    });

    describe('Core Logic (Frontmatter, Images, H1)', () => {
        it('should extract digest from frontmatter', async () => {
            const articlePath = '/test/path/article-fm.md';
            const markdown = '---\ndigest: This is a summary.\n---\n# Title\nSome other content.';
            
            mockWeChatService.addPermanentMaterial = vi.fn().mockResolvedValue({ media_id: 'thumb_1', url: 'url' });
            
            const { digest, html } = await markdownService.convert(markdown, articlePath);
            
            expect(digest).toBe('This is a summary.');
            expect(html).toContain('Title'); 
            expect(html).toContain('Some other content');
        });

        it('should extract title from frontmatter', async () => {
            const articlePath = '/test/path/article-title-fm.md';
            const markdown = '---\ntitle: My Custom Title\n---\n# H1 Title\nContent.';
            const { title, html } = await markdownService.convert(markdown, articlePath);
            expect(title).toBe('My Custom Title');
            expect(html).toContain('H1 Title');
        });

        it('should extract title from unique H1 if no frontmatter title', async () => {
            const articlePath = '/test/path/article-h1-title.md';
            const markdown = '# My Unique H1\nContent.';
            const { title, html } = await markdownService.convert(markdown, articlePath);
            expect(title).toBe('My Unique H1');
            expect(html).toContain('My Unique H1');
        });

        it('should NOT extract title if multiple H1s exist', async () => {
            const articlePath = '/test/path/article-multi-h1.md';
            const markdown = '# H1 One\n# H1 Two\nContent.';
            const { title } = await markdownService.convert(markdown, articlePath);
            expect(title).toBeUndefined();
        });

        it('should use default digest if no digest and no cover.prompt in frontmatter', async () => {
            const articlePath = '/test/path/article-no-digest.md';
            const markdown = '---\nkey: value\n---\n# Title\nSome other content.';
            
            const { digest } = await markdownService.convert(markdown, articlePath, undefined, 'default_cover_prompt');
            expect(digest).toBe('default_cover_prompt');
        });

        it('should use cover.prompt as digest if digest is missing in frontmatter', async () => {
            const articlePath = '/test/path/article-cover-prompt.md';
            const markdown = '---\ncover:\n  prompt: "This is the prompt digest"\n---\n# Title\nContent';
            
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

        it('should process images and retain H1/cover in body with styles', async () => {
            const articlePath = '/test/path/article-images.md';
            const markdown = '# Title\n![cover](./cover.png)\nSome other content.\n![body](./body.png)';
            
            mockDbService.getMaterial.mockReturnValue(undefined);
            mockWeChatService.checkMediaExists.mockResolvedValue(false);

            mockWeChatService.addPermanentMaterial = vi.fn()
                .mockResolvedValueOnce({ media_id: 'cover_media_id', url: 'cover_url' }) 
                .mockResolvedValueOnce({ media_id: 'cover_media_id_2', url: 'cover_url_2' }) 
                .mockResolvedValueOnce({ media_id: 'body_media_id', url: 'body_image_url' }); 

            vi.mocked(mockSharpInstance.metadata).mockResolvedValue({ format: 'png' });

            const { thumb_media_id, html, title } = await markdownService.convert(markdown, articlePath);

            expect(thumb_media_id).toBe('cover_media_id');
            expect(title).toBe('Title');
            expect(html).toContain('font-size: 24px;'); 
            expect(html).toContain('border-radius: 8px;'); 
            expect(mockWeChatService.addPermanentMaterial).toHaveBeenCalledTimes(3);
        });

        it('should return null thumb_media_id if cover image upload fails', async () => {
            const articlePath = '/test/path/article-upload-fail.md';
            const markdown = '# Title\nContent';
            
            mockDbService.getMaterial.mockReturnValue(undefined);
            mockWeChatService.checkMediaExists.mockResolvedValue(false);

            mockWeChatService.addPermanentMaterial = vi.fn().mockRejectedValue(new Error('Upload failed'));

            const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

            expect(thumb_media_id).toBeNull();
            expect(html).toContain('Title'); 
        });

        it('should throw error when image upload fails', async () => {
            const articlePath = '/test/path/article-upload-fail-body.md';
            const markdown = '![](./fail.png)';
            
            mockDbService.getMaterial.mockReturnValue(undefined);
            mockWeChatService.checkMediaExists.mockResolvedValue(false);
            mockWeChatService.addPermanentMaterial = vi.fn().mockRejectedValue(new Error('Upload failed'));

            await expect(markdownService.convert(markdown, articlePath)).rejects.toThrow('Upload failed');
        });
    });

    describe('Markdown Formatting with Styles', () => {
        const articlePath = '/test/format.md';

        beforeEach(() => {
            vi.mocked(fs.access).mockRejectedValue(new Error('No cover')); 
            vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png'));
            mockWeChatService.checkMediaExists.mockResolvedValue(false);
            mockWeChatService.addPermanentMaterial.mockResolvedValue({ media_id: 'dummy_id', url: 'dummy_url' });
        });

        it('should render lists flattened as paragraphs with prefix', async () => {
            const markdown = '\n- Item 1\n- Item 2\n  - Subitem 2.1\n';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).not.toContain('<ul>'); 
            expect(html).not.toContain('<li>');
            expect(html).not.toContain('<div'); 
            expect(html).not.toContain('<section'); 
            
            expect(html).toContain('•  '); 
            expect(html).toContain('text-indent: -20px;'); 
            expect(html).toContain('margin: 0 0 5px'); 
        });

        it('should render ordered lists flattened as paragraphs with prefix', async () => {
            const markdown = '\n1. First\n2. Second\n';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).not.toContain('<ol>'); 
            expect(html).not.toContain('<li>');
            expect(html).toContain('1. '); 
            expect(html).toContain('text-indent: -20px;');
            expect(html).toContain('margin: 0 0 5px'); 
        });

        it('should render blockquotes with correct inline styles', async () => {
            const markdown = '> This is a quote';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('border-left: 5px solid #d4af37;'); 
            expect(html).toContain('background-color: #fffaf0;'); 
        });

        it('should render fenced code blocks with correct inline styles', async () => {
            const markdown = '```typescript\nconst x = 1;\n```';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('background-color: #f8f8f8;'); 
            expect(html).toContain("font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;"); 
        });

        it('should render paragraphs with correct inline styles', async () => {
            const markdown = 'Just a paragraph.';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('font-size: 17px;'); 
            expect(html).toContain('line-height: 1.8;');
            expect(html).toContain('text-align: justify;');
        });
    });
});
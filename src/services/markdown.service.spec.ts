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

        vi.mocked(fs.access).mockRejectedValue(new Error('File not found')); 
        vi.mocked(fs.readFile).mockResolvedValue(createMockImageBuffer('png')); 
        vi.mocked(fileUtil.getFileHash).mockResolvedValue('mock_hash');
        mockWeChatService.checkMediaExists.mockResolvedValue(true); 
    });

    describe('Core Logic (Frontmatter, Images, H1)', () => {
        it('should extract digest from frontmatter', async () => {
            const articlePath = '/test/path/article-fm.md';
            const markdown = '---\ndigest: This is a summary.\n---\n# Title\nSome other content.';
            
            vi.mocked(fs.access).mockResolvedValue(undefined); 
            mockWeChatService.addPermanentMaterial = vi.fn().mockResolvedValue({ media_id: 'thumb_1', url: 'url' });
            
            const { digest, html } = await markdownService.convert(markdown, articlePath);
            
            expect(digest).toBe('This is a summary.');
            expect(html).toContain('Title'); 
            expect(html).toContain('Some other content');
        });

        // ... title extraction tests (unchanged logic) ...
        it('should extract title from frontmatter', async () => {
            const articlePath = '/test/path/article-title-fm.md';
            const markdown = '---\ntitle: My Custom Title\n---\n# H1 Title\nContent.';
            const { title } = await markdownService.convert(markdown, articlePath);
            expect(title).toBe('My Custom Title');
        });

        it('should extract title from unique H1 if no frontmatter title', async () => {
            const articlePath = '/test/path/article-h1-title.md';
            const markdown = '# My Unique H1\nContent.';
            const { title } = await markdownService.convert(markdown, articlePath);
            expect(title).toBe('My Unique H1');
        });

        it('should NOT extract title if multiple H1s exist', async () => {
            const articlePath = '/test/path/article-multi-h1.md';
            const markdown = '# H1 One\n# H1 Two\nContent.';
            const { title } = await markdownService.convert(markdown, articlePath);
            expect(title).toBeUndefined();
        });

        it('should process images and retain H1/cover in body with styles', async () => {
            const articlePath = '/test/path/article-images.md';
            const markdown = '# Title\n![cover](./cover.png)\nSome other content.\n![body](./body.png)';
            
            vi.mocked(fs.access).mockResolvedValue(undefined); 
            vi.mocked(fs.readFile).mockImplementation((p: string) => {
                if (p.includes('article-images.png')) return Promise.resolve(createMockImageBuffer('png'));
                if (p.includes('cover.png')) return Promise.resolve(createMockImageBuffer('png'));
                if (p.includes('body.png')) return Promise.resolve(createMockImageBuffer('png'));
                return Promise.reject(new Error('File not found: ' + p));
            });
            
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
            // Check for styles
            expect(html).toContain('style="font-size: 24px;'); // H1 style
            expect(html).toContain('style="max-width: 100%;'); // Image style
        });
    });

    describe('Markdown Formatting with Styles', () => {
        const articlePath = '/test/format.md';

        beforeEach(() => {
            vi.mocked(fs.access).mockRejectedValue(new Error('No cover')); 
        });

        it('should render lists with correct inline styles', async () => {
            const markdown = '\n- Item 1\n- Item 2\n  - Subitem 2.1\n';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('padding-left: 20px;'); // UL style
            expect(html).toContain('list-style-type: disc;'); // UL style
            expect(html).toContain('line-height: 1.6;'); // LI style
        });

        it('should render ordered lists with correct inline styles', async () => {
            const markdown = '\n1. First\n2. Second\n';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('padding-left: 20px;'); // OL style
            expect(html).toContain('list-style-type: decimal;'); // OL style
        });

        it('should render blockquotes with correct inline styles', async () => {
            const markdown = '> This is a quote';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('border-left: 4px solid'); 
            expect(html).toContain('background-color: #f8f9fa;'); 
        });

        it('should render fenced code blocks with correct inline styles', async () => {
            const markdown = '```typescript\nconst x = 1;\n```';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('background-color: #f6f8fa;'); 
            expect(html).toContain('font-family: monospace;'); 
        });

        it('should render paragraphs with correct inline styles', async () => {
            const markdown = 'Just a paragraph.';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('font-size: 16px;');
            expect(html).toContain('line-height: 1.6;');
            expect(html).toContain('text-align: justify;');
        });
    });
});
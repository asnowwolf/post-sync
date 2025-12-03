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
            
            mockDbService.getMaterial.mockReturnValue(undefined);
            mockWeChatService.checkMediaExists.mockResolvedValue(false);

            mockWeChatService.addPermanentMaterial = vi.fn()
                .mockResolvedValueOnce({ media_id: 'cover_media_id', url: 'cover_url' }) 
                .mockResolvedValueOnce({ media_id: 'body_media_id', url: 'body_image_url' });

            vi.mocked(mockSharpInstance.metadata).mockResolvedValue({ format: 'png' });

            const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

            expect(thumb_media_id).toBe('cover_media_id');
            expect(html).not.toContain('./article-four.png'); 
            expect(html).not.toContain('<h1>Title</h1>');
            
            expect(html).toContain('<img src="body_image_url"');
            expect(mockWeChatService.addPermanentMaterial).toHaveBeenCalledTimes(2);
        });

        it('should return null thumb_media_id if cover image upload fails', async () => {
            const articlePath = '/test/path/article-upload-fail.md';
            const markdown = '# Title\nContent';
            
            vi.mocked(fs.access).mockResolvedValue(undefined); 
            vi.mocked(fs.readFile).mockResolvedValueOnce(createMockImageBuffer('png'));
            
            mockDbService.getMaterial.mockReturnValue(undefined);
            mockWeChatService.checkMediaExists.mockResolvedValue(false);

            mockWeChatService.addPermanentMaterial = vi.fn().mockRejectedValue(new Error('Upload failed'));

            const { thumb_media_id, html } = await markdownService.convert(markdown, articlePath);

            expect(thumb_media_id).toBeNull();
            expect(html).not.toContain('<h1>Title</h1>');
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

    describe('Markdown Formatting', () => {
        const articlePath = '/test/format.md';

        beforeEach(() => {
            vi.mocked(fs.access).mockRejectedValue(new Error('No cover')); // No cover image logic
        });

        it('should render lists correctly', async () => {
            const markdown = `
- Item 1
- Item 2
  - Subitem 2.1
`;
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<ul>');
            expect(html).toContain('<li>Item 1</li>');
            expect(html).toContain('<li>Item 2');
            expect(html).toContain('<ul>');
            expect(html).toContain('<li>Subitem 2.1</li>');
        });

        it('should render ordered lists correctly', async () => {
            const markdown = `
1. First
2. Second
`;
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<ol>');
            expect(html).toContain('<li>First</li>');
            expect(html).toContain('<li>Second</li>');
        });

        it('should render blockquotes correctly', async () => {
            const markdown = '> This is a quote';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<blockquote>');
            expect(html).toContain('<p>This is a quote</p>');
            expect(html).toContain('</blockquote>');
        });

        it('should render inline code', async () => {
            const markdown = 'Use `code` inline.';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<code>code</code>');
        });

        it('should render fenced code blocks', async () => {
            const markdown = '```typescript\nconst x = 1;\n```';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<pre><code class="language-typescript">');
            expect(html).toContain('const x = 1;');
        });

        it('should render links', async () => {
            const markdown = '[Link](https://example.com)';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<a href="https://example.com">Link</a>');
        });

        it('should render emphasis', async () => {
            const markdown = '**Bold** and *Italic*';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<strong>Bold</strong>');
            expect(html).toContain('<em>Italic</em>');
        });

        it('should render horizontal rules', async () => {
            const markdown = '---';
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<hr>');
        });
        
        it('should render tables', async () => {
            const markdown = `
| Header 1 | Header 2 |
| --- | --- |
| Row 1 | Cell 2 |
`;
            const { html } = await markdownService.convert(markdown, articlePath);
            expect(html).toContain('<table>');
            expect(html).toContain('<thead>');
            expect(html).toContain('<th>Header 1</th>');
            expect(html).toContain('<tbody>');
            expect(html).toContain('<td>Row 1</td>');
        });
    });
});

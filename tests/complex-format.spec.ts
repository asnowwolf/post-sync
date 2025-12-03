import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownService } from '../src/services/markdown.service.js';
import { WeChatService } from '../src/services/wechat.service.js';
import { DbService } from '../src/services/db.service.js';
import * as path from 'path';
import * as fs from 'fs/promises';

// Mock Services
const mockWeChatService = {
    addPermanentMaterial: vi.fn(),
    checkMediaExists: vi.fn(),
} as unknown as WeChatService;

const mockDbService = {
    getMaterial: vi.fn(),
    saveMaterial: vi.fn(),
} as unknown as DbService;

// Mock Sharp to avoid actual image processing overhead and dependency issues
vi.mock('sharp', () => {
    const sharpInstance = {
        metadata: vi.fn().mockResolvedValue({ format: 'png' }),
        resize: vi.fn().mockReturnThis(),
        jpeg: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from('mock_processed_image')),
    };
    return {
        default: vi.fn(() => sharpInstance),
    };
});

describe('Complex Markdown Formatting', () => {
    let markdownService: MarkdownService;
    const examplesDir = path.resolve(process.cwd(), 'tests/complex-examples');

    beforeEach(() => {
        vi.clearAllMocks();
        markdownService = new MarkdownService(mockWeChatService, mockDbService);

        // Setup default mocks for WeChat service
        // We assume media check fails so it triggers upload logic (which we want to test/mock)
        mockWeChatService.checkMediaExists.mockResolvedValue(false);
        mockWeChatService.addPermanentMaterial.mockResolvedValue({
            media_id: 'mock_media_id',
            url: 'http://mock.url/image.jpg'
        });
        
        // Mock DbService to return nothing so we don't hit cache
        mockDbService.getMaterial.mockReturnValue(undefined);
    });

    it('should correctly render complex-article-1.md', async () => {
        const filePath = path.join(examplesDir, 'complex-article-1.md');
        const content = await fs.readFile(filePath, 'utf-8');
        
        const { html } = await markdownService.convert(content, filePath);
        
        // Use toMatchFileSnapshot to verify against a stored expectation file.
        // On the first run, this creates the file. On subsequent runs, it compares.
        await expect(html).toMatchFileSnapshot(path.join(examplesDir, 'complex-article-1.html'));
    });

    it('should correctly render complex-article-2.md', async () => {
        const filePath = path.join(examplesDir, 'complex-article-2.md');
        const content = await fs.readFile(filePath, 'utf-8');
        
        const { html } = await markdownService.convert(content, filePath);
        
        await expect(html).toMatchFileSnapshot(path.join(examplesDir, 'complex-article-2.html'));
    });
});

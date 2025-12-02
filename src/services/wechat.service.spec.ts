import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WeChatService } from './wechat.service.js';
import { ApiError } from '../errors.js';
import { AppConfig } from '../config.js';

// Mock config module to control wechatApiBaseUrl
const mockConfig: AppConfig = {
    appId: 'mock_app_id',
    appSecret: 'mock_app_secret',
    wechatApiBaseUrl: 'http://mock-wechat-proxy.com', // Use a mock base URL
};

vi.mock('../config.js', () => ({
    config: mockConfig,
}));

describe('WeChatService', () => {
    let wechatService: WeChatService;

    // Mock HttpClient
    const mockPost = vi.fn();
    const mockGet = vi.fn();
    const mockHttpClient = {
        post: mockPost,
        get: mockGet,
        defaults: {},
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockPost.mockReset();
        mockGet.mockReset();
        // Pass mockConfig directly to WeChatService constructor
        wechatService = new WeChatService({ ...mockConfig, httpClient: mockHttpClient as any });
        // Default successful access token response
        mockPost.mockResolvedValueOnce({
            data: { access_token: 'valid_token', expires_in: 7200 },
            status: 200,
        });
    });

    it('should get access token', async () => {
        // First call triggers request
        const token = await (wechatService as any).getAccessToken();
        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/stable_token`,
            {
                grant_type: 'client_credential',
                appid: mockConfig.appId,
                secret: mockConfig.appSecret,
                force_refresh: false,
            }
        );
        expect(token).toBe('valid_token');

        // Second call should return cached token without request
        mockPost.mockClear();
        const cachedToken = await (wechatService as any).getAccessToken();
        expect(mockPost).not.toHaveBeenCalled();
        expect(cachedToken).toBe('valid_token');
    });

    it('should create draft', async () => {
        const article = {
            title: 'Test Article',
            content: '<h1>Content</h1>',
            thumb_media_id: 'thumb_id',
        };
        mockPost.mockResolvedValueOnce({
            data: { media_id: 'draft_media_id' },
            status: 200,
        });

        const mediaId = await wechatService.createDraft(article);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/draft/add?access_token=valid_token`,
            {
                articles: [
                    {
                        ...article,
                        need_open_comment: 1,
                        only_fans_can_comment: 0,
                    },
                ],
            }
        );
        expect(mediaId).toBe('draft_media_id');
    });

    it('should publish draft', async () => {
        const mediaId = 'draft_media_id';
        mockPost.mockResolvedValueOnce({
            data: { publish_id: 'publish_job_id' },
            status: 200,
        });

        const publishId = await wechatService.publishDraft(mediaId);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/freepublish/submit?access_token=valid_token`,
            { media_id: mediaId }
        );
        expect(publishId).toBe('publish_job_id');
    });

    it('should get publish status', async () => {
        const publishId = 'publish_job_id';
        mockPost.mockResolvedValueOnce({
            data: { publish_status: 0 },
            status: 200,
        });

        const status = await wechatService.getPublishStatus(publishId);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/freepublish/get?access_token=valid_token`,
            { publish_id: publishId }
        );
        expect(status).toEqual({ publish_status: 0 });
    });

    it('should throw ApiError on failure', async () => {
        mockPost.mockResolvedValueOnce({
            data: { errcode: 40001, errmsg: 'invalid credential' },
            status: 200,
        });

        await expect(wechatService.addPermanentMaterial(Buffer.from(''), 'image', 't.jpg', 'image/jpeg'))
            .rejects.toThrow(ApiError);
    });

    it('should delete published article', async () => {
        const articleId = 'article_id_to_delete';
        mockPost.mockResolvedValueOnce({
            data: { errcode: 0, errmsg: 'ok' },
            status: 200,
        });

        await wechatService.deletePublishedArticle(articleId);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/freepublish/delete?access_token=valid_token`,
            { article_id: articleId }
        );
    });

    it('should batch get published articles', async () => {
        const offset = 0;
        const count = 20;
        const mockResponse = {
            total_count: 10,
            item_count: 10,
            item: [],
        };
        mockPost.mockResolvedValueOnce({
            data: mockResponse,
            status: 200,
        });

        const result = await wechatService.batchGetPublishedArticles(offset, count);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/freepublish/batchget?access_token=valid_token`,
            { offset, count, no_content: 1 }
        );
        expect(result).toEqual(mockResponse);
    });

    it('should delete draft', async () => {
        const mediaId = 'draft_media_id_to_delete';
        mockPost.mockResolvedValueOnce({
            data: { errcode: 0, errmsg: 'ok' },
            status: 200,
        });

        await wechatService.deleteDraft(mediaId);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/draft/delete?access_token=valid_token`,
            { media_id: mediaId }
        );
    });

    it('should batch get drafts', async () => {
        const offset = 0;
        const count = 20;
        const mockResponse = {
            total_count: 5,
            item_count: 5,
            item: [],
        };
        mockPost.mockResolvedValueOnce({
            data: mockResponse,
            status: 200,
        });

        const result = await wechatService.batchGetDrafts(offset, count);

        expect(mockPost).toHaveBeenCalledWith(
            `${mockConfig.wechatApiBaseUrl}/cgi-bin/draft/batchget?access_token=valid_token`,
            { offset, count, no_content: 1 }
        );
        expect(result).toEqual(mockResponse);
    });
});
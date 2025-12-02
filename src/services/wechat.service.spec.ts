import {beforeEach, describe, expect, it, vi} from 'vitest';
import {WeChatService} from './wechat.service.js';
import {ApiError} from '../errors.js';

describe('WeChatService', () => {
    let wechatService: WeChatService;
    const options = {
        appId: 'test_app_id',
        appSecret: 'test_app_secret',
    };

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
        wechatService = new WeChatService({...options, httpClient: mockHttpClient as any});
        // Default successful access token response
        mockPost.mockResolvedValueOnce({
            data: {access_token: 'valid_token', expires_in: 7200},
            status: 200,
        });
    });

    it('should get access token', async () => {
        // First call triggers request
        const token = await (wechatService as any).getAccessToken();
        expect(mockPost).toHaveBeenCalledWith(
            'https://api.weixin.qq.com/cgi-bin/stable_token',
            {
                grant_type: 'client_credential',
                appid: options.appId,
                secret: options.appSecret,
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

    it('should upload temporary media', async () => {
        const mediaBuffer = Buffer.from('media content');
        mockPost.mockResolvedValueOnce({
            data: {media_id: 'uploaded_media_id'},
            status: 200,
        });

        const mediaId = await wechatService.uploadTemporaryMedia(mediaBuffer, 'image', 'test.jpg', 'image/jpeg');

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('https://api.weixin.qq.com/cgi-bin/media/upload?access_token=valid_token&type=image'),
            expect.any(Object), // FormData
            expect.any(Object)  // Headers
        );
        expect(mediaId).toBe('uploaded_media_id');
    });

    it('should upload article image', async () => {
        const imageBuffer = Buffer.from('image content');
        mockPost.mockResolvedValueOnce({
            data: {url: 'http://wechat.url/image.jpg'},
            status: 200,
        });

        const url = await wechatService.uploadArticleImage(imageBuffer, 'test.jpg', 'image/jpeg');

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=valid_token'),
            expect.any(Object),
            expect.any(Object)
        );
        expect(url).toBe('http://wechat.url/image.jpg');
    });

    it('should create draft', async () => {
        const article = {
            title: 'Test Article',
            content: '<h1>Content</h1>',
            thumb_media_id: 'thumb_id',
        };
        mockPost.mockResolvedValueOnce({
            data: {media_id: 'draft_media_id'},
            status: 200,
        });

        const mediaId = await wechatService.createDraft(article);

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('https://api.weixin.qq.com/cgi-bin/freepublish/add_draft?access_token=valid_token'),
            {
                articles: {
                    ...article,
                    need_open_comment: 1,
                    only_fans_can_comment: 0,
                }
            }
        );
        expect(mediaId).toBe('draft_media_id');
    });

    it('should publish draft', async () => {
        const mediaId = 'draft_media_id';
        mockPost.mockResolvedValueOnce({
            data: {publish_id: 'publish_job_id'},
            status: 200,
        });

        const publishId = await wechatService.publishDraft(mediaId);

        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=valid_token'),
            {media_id: mediaId}
        );
        expect(publishId).toBe('publish_job_id');
    });

    it('should get publish status', async () => {
        const publishId = 'publish_job_id';
        mockGet.mockResolvedValueOnce({
            data: {publish_status: 0},
            status: 200,
        });

        const status = await wechatService.getPublishStatus(publishId);

        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('https://api.weixin.qq.com/cgi-bin/freepublish/get?access_token=valid_token'),
            {params: {publish_id: publishId}}
        );
        expect(status).toEqual({publish_status: 0});
    });

    it('should throw ApiError on failure', async () => {
        mockPost.mockResolvedValueOnce({
            data: {errcode: 40001, errmsg: 'invalid credential'},
            status: 200,
        });

        await expect(wechatService.uploadTemporaryMedia(Buffer.from(''), 'image', 't.jpg', 'image/jpeg'))
            .rejects.toThrow(ApiError);
    });
});

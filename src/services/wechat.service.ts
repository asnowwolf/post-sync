import axios, {AxiosInstance, AxiosStatic} from 'axios';
import FormData from 'form-data';
import {Stream} from 'stream';
import {ApiError} from '../errors.js';
import {logger} from '../logger.js';
import { retry } from '../utils/api-retry.util.js';

export interface WeChatServiceOptions {
    appId: string;
    appSecret: string;
    httpClient?: AxiosInstance | AxiosStatic;
    wechatApiBaseUrl: string;
}

// No longer needed as we are directly using the proxy-wechat endpoint
// const createMockHttpClient = () => { ... };

export class WeChatService {
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;
    private http: AxiosInstance | AxiosStatic;

    constructor(private options: WeChatServiceOptions) {
        this.http = options.httpClient || axios;
    }

    private async getAccessToken(forceRefresh: boolean = false): Promise<string> {
        if (!forceRefresh && this.accessToken && this.tokenExpiresAt > Date.now()) {
            return this.accessToken;
        }

        logger.info('Requesting new WeChat access token...');
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/stable_token`;
        const data = {
            grant_type: 'client_credential',
            appid: this.options.appId,
            secret: this.options.appSecret,
            force_refresh: forceRefresh,
        };

        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data);
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            });

            logger.debug(`getAccessToken response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            this.accessToken = response.data.access_token;
            // Set expiry with a 5-minute buffer
            this.tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
            logger.info('Successfully obtained new WeChat access token.');
            return this.accessToken!;
        } catch (error: any) {
            logger.error('Failed to get access token after retries:', error.message);
            if (error.response) {
                logger.error(`Error response: status=${error.response.status}, data=${JSON.stringify(error.response.data)}`);
            }
            throw new ApiError('Failed to get access token', error.response?.status, error.response?.data);
        }
    }

    public async addPermanentMaterial(mediaBuffer: Buffer, type: 'image' | 'thumb', filename: string, contentType: string): Promise<{
        media_id: string;
        url: string
    }> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/material/add_material?access_token=${token}&type=${type}`;

        const form = new FormData();
        form.append('media', Stream.Readable.from(mediaBuffer), {filename, contentType});

        logger.info(`Uploading permanent ${type} '${filename}' to WeChat...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, form, {headers: form.getHeaders()});
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            });

            logger.debug(`addPermanentMaterial response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            logger.info(`Successfully uploaded permanent ${type}. Media ID: ${response.data.media_id}`);
            return {media_id: response.data.media_id, url: response.data.url};
        } catch (error: any) {
            logger.error(`Failed to upload permanent ${type} after retries:`, error.message);
            if (error.response) {
                logger.error(`Error response: status=${error.response.status}, data=${JSON.stringify(error.response.data)}`);
            }
            throw new ApiError(`Failed to upload permanent ${type}`, error.response?.status, error.response?.data);
        }
    }

    public async createDraft(article: {
        title: string;
        content: string;
        thumb_media_id: string;
        author?: string;
        digest?: string;
    }): Promise<string> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/draft/add?access_token=${token}`;

        const data = {
            articles: [{
                ...article,
                need_open_comment: 1, // Default to open comments
                only_fans_can_comment: 0,
            }]
        };

        logger.info(`Creating draft '${article.title}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data);
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            });

            logger.debug(`createDraft response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            logger.info(`Successfully created draft. Media ID: ${response.data.media_id}`);
            return response.data.media_id;
        } catch (error: any) {
            logger.error(`Failed to create draft after retries:`, error.message);
            if (error.response) {
                logger.error(`Error response: status=${error.response.status}, data=${JSON.stringify(error.response.data)}`);
            }
            throw new ApiError('Failed to create draft', error.response?.status, error.response?.data);
        }
    }

    public async publishDraft(mediaId: string): Promise<string> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/freepublish/submit?access_token=${token}`;
        const data = {media_id: mediaId};

        logger.info(`Publishing draft with media_id '${mediaId}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data);
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            });

            logger.info(`Successfully submitted for publication. Publish ID: ${response.data.publish_id}`);
            return response.data.publish_id;
        } catch (error: any) {
            logger.error(`Failed to publish draft after retries:`, error.message);
            throw new ApiError('Failed to publish draft', error.response?.status, error.response?.data);
        }
    }

    public async getPublishStatus(publishId: string): Promise<any> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/freepublish/get?access_token=${token}`;
        const params = {publish_id: publishId};

        logger.info(`Checking publish status for publish_id '${publishId}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.get(url, {params});
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            });

            logger.info(`Publish status: ${response.data.publish_status === 0 ? 'Success' : 'In Progress/Failed'}`);
            return response.data;
        } catch (error: any) {
            logger.error(`Failed to get publish status after retries:`, error.message);
            throw new ApiError('Failed to get publish status', error.response?.status, error.response?.data);
        }
    }

    public async getDraft(mediaId: string): Promise<any> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/draft/get?access_token=${token}`;
        const data = { media_id: mediaId };

        logger.debug(`Checking existence of draft '${mediaId}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data);
                if (res.data.errcode) {
                    if (res.data.errcode === 40007) { // Invalid media_id - NOT RETRYABLE
                        return null; // Return null directly without throwing ApiError for retry condition
                    }
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                retryCondition: (error) => {
                    // Only retry for "请勿频繁请求" error, not for other API errors or 40007
                    return error.message.includes('请勿频繁请求');
                }
            });

            return response; // Can be null if errcode 40007 was returned
        } catch (error: any) {
            logger.error(`Failed to get draft after retries:`, error.message);
            throw new ApiError('Failed to get draft', error.response?.status, error.response?.data);
        }
    }

    public async updateDraft(mediaId: string, article: {
        title: string;
        content: string;
        thumb_media_id: string;
        author?: string;
        digest?: string;
    }, index: number = 0): Promise<void> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/draft/update?access_token=${token}`;
        
        const data = {
            media_id: mediaId,
            index,
            articles: {
                ...article,
                need_open_comment: 1,
                only_fans_can_comment: 0,
            }
        };

        logger.info(`Updating draft '${mediaId}' (index: ${index})...`);
        try {
            const response = await this.http.post(url, data);
            logger.debug(`updateDraft response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            if (response.data.errcode) {
                throw new ApiError(`WeChat API Error: ${response.data.errmsg}`, response.status, response.data);
            }
            logger.info(`Successfully updated draft '${mediaId}'.`);
        } catch (error: any) {
            logger.error(`Failed to update draft:`, error.message);
            throw new ApiError('Failed to update draft', error.response?.status, error.response?.data);
        }
    }

    public async checkMediaExists(mediaId: string): Promise<boolean> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/material/get_material?access_token=${token}`;
        const data = { media_id: mediaId };

        logger.debug(`Checking existence of permanent material '${mediaId}'...`);
        try {
            // Use a custom config to avoid downloading the whole stream if possible, 
            // but axios might download it anyway. 
            // For checking existence, we can try to rely on headers or just partial download if supported.
            // However, typical WeChat API usage requires POST body.
            // We'll just accept the download overhead for correctness, or catch the error.
            const response = await this.http.post(url, data, {
                responseType: 'stream', // Don't buffer the whole image in memory
                validateStatus: (status) => status < 500, // Handle 4xx manually
            });
            
            // If it's a file download, it won't have 'errcode' in JSON body easily accessible without reading stream.
            // But if it's an error, WeChat returns JSON (application/json).
            // If success, it returns content-type image/xxx.
            
            const contentType = response.headers['content-type'];
            if (contentType && contentType.includes('application/json')) {
                // It's likely an error (or a JSON response for video/news)
                // We need to read the stream to check errcode.
                const stream = response.data;
                const chunks = [];
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                const body = Buffer.concat(chunks).toString();
                const json = JSON.parse(body);
                if (json.errcode && json.errcode === 40007) {
                    return false;
                }
                if (json.errcode) {
                    logger.warn(`checkMediaExists API Error: ${json.errmsg}`);
                    return false; // Treat other errors as "not available" or assume does not exist? 
                                  // Safest to return false and let caller re-upload.
                }
            }
            
            return true; // Exists (binary stream or valid JSON w/o error)
        } catch (error: any) {
             logger.warn(`Failed to check media existence: ${error.message}`);
             return false;
        }
    }
}

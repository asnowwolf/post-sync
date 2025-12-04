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
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            logger.debug(`getAccessToken response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            this.accessToken = response.data.access_token;
            // Set expiry with a 5-minute buffer
            this.tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
            logger.info('Successfully obtained new WeChat access token.');
            return this.accessToken!;
        } catch (error: any) {
            logger.error('Failed to get access token after retries:', error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            if (error.response) {
                logger.error(`Error response: status=${error.response.status}, data=${JSON.stringify(error.response.data)}`);
            }
            throw new ApiError(`Failed to get access token: ${error.message}`, error.response?.status, error.response?.data);
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
                const res = await this.http.post(url, form, {headers: form.getHeaders(), proxy: false});
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            logger.debug(`addPermanentMaterial response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            logger.info(`Successfully uploaded permanent ${type}. Media ID: ${response.data.media_id}`);
            return {media_id: response.data.media_id, url: response.data.url};
        } catch (error: any) {
            logger.error(`Failed to upload permanent ${type} after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            if (error.response) {
                logger.error(`Error response: status=${error.response.status}, data=${JSON.stringify(error.response.data)}`);
            }
            throw new ApiError(`Failed to upload permanent ${type}: ${error.message}`, error.response?.status, error.response?.data);
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
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            logger.debug(`createDraft response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            logger.info(`Successfully created draft. Media ID: ${response.data.media_id}`);
            return response.data.media_id;
        } catch (error: any) {
            logger.error(`Failed to create draft after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            if (error.response) {
                logger.error(`Error response: status=${error.response.status}, data=${JSON.stringify(error.response.data)}`);
            }
            throw new ApiError(`Failed to create draft: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async publishDraft(mediaId: string): Promise<string> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/freepublish/submit?access_token=${token}`;
        const data = {media_id: mediaId};

        logger.info(`Publishing draft with media_id '${mediaId}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 60000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 10
            });

            logger.info(`Successfully submitted for publication. Publish ID: ${response.data.publish_id}`);
            return response.data.publish_id;
        } catch (error: any) {
            logger.error(`Failed to publish draft after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to publish draft: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async getPublishStatus(publishId: string): Promise<any> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/freepublish/get?access_token=${token}`;
        const data = {publish_id: publishId};

        logger.info(`Checking publish status for publish_id '${publishId}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            logger.info(`Publish status: ${response.data.publish_status === 0 ? 'Success' : 'In Progress/Failed'}`);
            return response.data;
        } catch (error: any) {
            logger.error(`Failed to get publish status after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to get publish status: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async getDraft(mediaId: string): Promise<any> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/draft/get?access_token=${token}`;
        const data = { media_id: mediaId };

        logger.debug(`Checking existence of draft '${mediaId}'...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    if (res.data.errcode === 40007) { // Invalid media_id - NOT RETRYABLE
                        return null; // Return null directly without throwing ApiError for retry condition
                    }
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4,
                retryCondition: (error) => {
                    // Only retry for "请勿频繁请求" error, not for other API errors or 40007
                    return error.message.includes('请勿频繁请求');
                }
            });

            return response; // Can be null if errcode 40007 was returned
        } catch (error: any) {
            logger.error(`Failed to get draft after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to get draft: ${error.message}`, error.response?.status, error.response?.data);
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
            const response = await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            logger.debug(`updateDraft response: status=${response.status}, data=${JSON.stringify(response.data)}`);
            logger.info(`Successfully updated draft '${mediaId}'.`);
        } catch (error: any) {
            logger.error(`Failed to update draft after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to update draft: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async checkMediaExists(mediaId: string): Promise<boolean> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/material/get_material?access_token=${token}`;
        const data = { media_id: mediaId };

        logger.debug(`Checking existence of permanent material '${mediaId}'...`);
        try {
            const result = await retry(async () => {
                const response = await this.http.post(url, data, {
                    responseType: 'stream',
                    validateStatus: (status) => status < 500,
                    proxy: false
                });

                const contentType = response.headers['content-type'];
                if (contentType && contentType.includes('application/json')) {
                    const stream = response.data;
                    const chunks = [];
                    for await (const chunk of stream) {
                        chunks.push(chunk);
                    }
                    const body = Buffer.concat(chunks).toString();
                    const json = JSON.parse(body);

                    if (json.errcode) {
                        if (json.errcode === 40007) {
                            return false; // Not a retryable error, return false immediately
                        }
                        // This will be caught by the outer retry's catch, and then evaluated by retryCondition
                        throw new ApiError(`WeChat API Error: ${json.errmsg}`, response.status, json);
                    }
                }
                return true; // Successfully determined it exists (or is binary stream without JSON error)
            });
            return result; // Can be true or false
        } catch (error: any) {
            logger.warn(`Failed to check media existence after retries: ${error.message}`);
            return false;
        }
    }

    public async deletePublishedArticle(articleId: string): Promise<void> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/freepublish/delete?access_token=${token}`;
        const data = { article_id: articleId };

        logger.info(`Deleting published article '${articleId}'...`);
        try {
            await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });
            logger.info(`Successfully deleted published article '${articleId}'.`);
        } catch (error: any) {
            logger.error(`Failed to delete published article after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to delete published article: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async batchGetPublishedArticles(offset: number, count: number): Promise<any> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/freepublish/batchget?access_token=${token}`;
        const data = {
            offset,
            count,
            no_content: 1 // Only get metadata, not content
        };

        logger.info(`Batch getting published articles (offset: ${offset}, count: ${count})...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            return response.data;
        } catch (error: any) {
            logger.error(`Failed to batch get published articles after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to batch get published articles: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async deleteDraft(mediaId: string): Promise<void> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/draft/delete?access_token=${token}`;
        const data = { media_id: mediaId };

        logger.info(`Deleting draft '${mediaId}'...`);
        try {
            await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });
            logger.info(`Successfully deleted draft '${mediaId}'.`);
        } catch (error: any) {
            logger.error(`Failed to delete draft after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to delete draft: ${error.message}`, error.response?.status, error.response?.data);
        }
    }

    public async batchGetDrafts(offset: number, count: number): Promise<any> {
        const token = await this.getAccessToken();
        const url = `${this.options.wechatApiBaseUrl}/cgi-bin/draft/batchget?access_token=${token}`;
        const data = {
            offset,
            count,
            no_content: 1
        };

        logger.info(`Batch getting drafts (offset: ${offset}, count: ${count})...`);
        try {
            const response = await retry(async () => {
                const res = await this.http.post(url, data, { proxy: false });
                if (res.data.errcode) {
                    throw new ApiError(`WeChat API Error: ${res.data.errmsg}`, res.status, res.data);
                }
                return res;
            }, {
                delayMs: 15000,
                backoffStrategy: 'exponential',
                maxDelayMs: 600000,
                maxAttempts: 4
            });

            return response.data;
        } catch (error: any) {
            logger.error(`Failed to batch get drafts after retries:`, error.message);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(`Failed to batch get drafts: ${error.message}`, error.response?.status, error.response?.data);
        }
    }
}

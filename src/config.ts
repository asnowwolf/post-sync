import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config({path: path.resolve(process.cwd(), '.env')});

export interface AppConfig {
    appId: string;
    appSecret: string;
    wechatApiBaseUrl: string;
}

export const config: AppConfig = {
    appId: process.env.WECHAT_APP_ID || '',
    appSecret: process.env.WECHAT_APP_SECRET || '',
    wechatApiBaseUrl: process.env.WECHAT_API_BASE_URL || 'https://proxy-wechat.zhizuo.biz', // Default to existing proxy
};

if (!config.appId || !config.appSecret) {
    // In a real CLI, you'd handle this more gracefully,
    // perhaps by throwing an error that's caught at the top level.
    console.error("Error: WeChat AppID and AppSecret must be provided in the .env file (WECHAT_APP_ID, WECHAT_APP_SECRET).");
    process.exit(1);
}


import * as path from 'path';
import { getPostSyncWorkDir, readJsonFile } from './utils/file.util.js';

export interface ProfileConfig {
    id: string;
    appId: string;
    appSecret: string;
}

export interface AppConfig {
    wechatApiBaseUrl: string;
    profiles: ProfileConfig[];
}

// Internal representation of the loaded config file
interface LoadedConfigFile {
    wechatApiBaseUrl?: string;
    profiles?: ProfileConfig[];
}

let appConfig: AppConfig;
const configFilePath = path.join(getPostSyncWorkDir(), 'config.json');

async function initializeConfig() {
    try {
        const loadedConfigFile: LoadedConfigFile = await readJsonFile<LoadedConfigFile>(configFilePath);

        if (!loadedConfigFile.profiles || loadedConfigFile.profiles.length === 0) {
            console.error(`Error: No profiles found in the configuration file located at ${configFilePath}.`);
            process.exit(1);
        }

        appConfig = {
            wechatApiBaseUrl: process.env.WECHAT_API_BASE_URL || loadedConfigFile.wechatApiBaseUrl || 'https://proxy-wechat.zhizuo.biz',
            profiles: loadedConfigFile.profiles,
        };

    } catch (error) {
        console.error(`Error loading configuration from ${configFilePath}:`, error);
        process.exit(1);
    }
}

// Immediately initialize the configuration when the module is loaded
await initializeConfig();

export function getConfig(profileId?: string): { appId: string; appSecret: string; wechatApiBaseUrl: string } {
    const selectedProfile = profileId
        ? appConfig.profiles.find(p => p.id === profileId)
        : appConfig.profiles[0]; // Default to the first profile if no ID is provided

    if (!selectedProfile) {
        console.error(`Error: Profile '${profileId || 'default'}' not found in the configuration file.`);
        process.exit(1);
    }

    if (!selectedProfile.appId || !selectedProfile.appSecret) {
        console.error(`Error: WeChat AppID and AppSecret must be provided for profile '${selectedProfile.id}' in the configuration file.`);
        process.exit(1);
    }

    return {
        appId: selectedProfile.appId,
        appSecret: selectedProfile.appSecret,
        wechatApiBaseUrl: appConfig.wechatApiBaseUrl,
    };
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FileError } from '../errors.js';
import * as os from 'os';

export function getPostSyncWorkDir(): string {
    const homeDir = os.homedir();
    const workDir = path.join(homeDir, '.post-sync');
    if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
    }
    return workDir;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error: any) {
        throw new FileError(`Failed to read or parse JSON file: ${filePath}. ${error.message}`, filePath);
    }
}

export function getFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(new FileError(`Failed to read file for hashing: ${filePath}`, filePath)));
    });
}

export async function getFileList(inputPath: string): Promise<string[]> {
    try {
        const stats = await fs.promises.lstat(inputPath);
        let realPath = inputPath;
        if (stats.isSymbolicLink()) {
            realPath = await fs.promises.realpath(inputPath);
        }

        const realStats = await fs.promises.stat(realPath);

        if (realStats.isDirectory()) {
            const files = await fs.promises.readdir(realPath);
            return files
                .filter(file => path.extname(file).toLowerCase() === '.md')
                .map(file => path.join(realPath, file))
                .sort(); // Sort alphabetically for now
        } else if (realStats.isFile()) {
            if (path.extname(realPath).toLowerCase() === '.md') {
                return [realPath];
            }
            return [];
        }
        return [];
    } catch (error: any) {
        throw new FileError(`Failed to get file list for path: ${inputPath}. ${error.message}`, inputPath);
    }
}


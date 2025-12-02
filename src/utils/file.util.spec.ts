import {beforeEach, describe, expect, it, vi} from 'vitest';
import {getFileHash, getFileList} from './file.util.js';
import * as fs from 'fs';
import {FileError} from '../errors.js';

// Mock fs.promises
vi.mock('fs', async () => {
    return {
        promises: {
            lstat: vi.fn(),
            realpath: vi.fn(),
            stat: vi.fn(),
            readdir: vi.fn(),
        },
        createReadStream: vi.fn(),
    };
});

describe('File Util', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getFileList', () => {
        it('should return a list of markdown files in a directory', async () => {
            const dirPath = '/test/dir';
            const files = ['file1.md', 'file2.txt', 'file3.MD'];

            (fs.promises.lstat as any).mockResolvedValue({isSymbolicLink: () => false});
            (fs.promises.stat as any).mockResolvedValue({isDirectory: () => true});
            (fs.promises.readdir as any).mockResolvedValue(files);

            const result = await getFileList(dirPath);
            expect(result).toEqual(['/test/dir/file1.md', '/test/dir/file3.MD'].sort());
        });

        it('should return the file itself if input is a markdown file', async () => {
            const filePath = '/test/file.md';
            (fs.promises.lstat as any).mockResolvedValue({isSymbolicLink: () => false});
            (fs.promises.stat as any).mockResolvedValue({isDirectory: () => false, isFile: () => true});

            const result = await getFileList(filePath);
            expect(result).toEqual([filePath]);
        });

        it('should resolve symlinks', async () => {
            const symlinkPath = '/test/symlink';
            const realPath = '/test/real/dir';
            (fs.promises.lstat as any).mockResolvedValue({isSymbolicLink: () => true});
            (fs.promises.realpath as any).mockResolvedValue(realPath);
            (fs.promises.stat as any).mockResolvedValue({isDirectory: () => true});
            (fs.promises.readdir as any).mockResolvedValue(['file.md']);

            const result = await getFileList(symlinkPath);
            expect(fs.promises.realpath).toHaveBeenCalledWith(symlinkPath);
            expect(result).toEqual(['/test/real/dir/file.md']);
        });

        it('should throw FileError on failure', async () => {
            (fs.promises.lstat as any).mockRejectedValue(new Error('access denied'));
            await expect(getFileList('/path')).rejects.toThrow(FileError);
        });
    });

    describe('getFileHash', () => {
        it('should calculate MD5 hash of a file', async () => {
            const filePath = '/test/file.md';
            const mockStream = {
                on: vi.fn((event, cb) => {
                    if (event === 'data') cb(Buffer.from('content'));
                    if (event === 'end') cb();
                    return mockStream;
                }),
            };
            (fs.createReadStream as any).mockReturnValue(mockStream);

            const hash = await getFileHash(filePath);
            // md5 of 'content' is '9a0364b9e99bb480dd25e1f0284c8555'
            expect(hash).toBe('9a0364b9e99bb480dd25e1f0284c8555');
        });

        it('should throw FileError on read error', async () => {
            const mockStream = {
                on: vi.fn((event, cb) => {
                    if (event === 'error') cb(new Error('read error'));
                    return mockStream;
                }),
            };
            (fs.createReadStream as any).mockReturnValue(mockStream);

            await expect(getFileHash('/path')).rejects.toThrow(FileError);
        });
    });
});

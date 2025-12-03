import {beforeEach, describe, expect, it, vi} from 'vitest';
import {getFileHash, getFileList} from './file.util.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {FileError} from '../errors.js';
import { finished } from 'stream/promises'; 

vi.mock('crypto', () => ({
    createHash: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        digest: vi.fn(() => 'a73d328479e0db9668352b22f03ec1c33f269a8b'), 
    })),
}));

vi.mock('fs', async (importOriginal) => {
    const actualFs = await importOriginal<typeof import('fs')>();
    return {
        ...actualFs,
        createReadStream: vi.fn(), 
        promises: {
            ...actualFs.promises,
            lstat: vi.fn(),
            realpath: vi.fn(),
            stat: vi.fn(),
            readdir: vi.fn(),
        },
    };
});

vi.mock('stream/promises'); 

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
        let mockCreateReadStream: vi.Mock;
        let mockFinished: vi.MockedFunction<typeof finished>; 
        let mockStreamInstance: any;

        beforeEach(() => {
            vi.clearAllMocks();
            mockCreateReadStream = vi.spyOn(fs, 'createReadStream') as vi.Mock;
            
            mockFinished = vi.mocked(finished); 
            mockFinished.mockResolvedValue(undefined); 

            mockStreamInstance = {
                pipe: vi.fn((dest: any) => {
                    dest.update(Buffer.from('content')); 
                    return mockStreamInstance;
                }),
                on: vi.fn().mockReturnThis(), 
                emit: vi.fn(), 
            };
            mockCreateReadStream.mockReturnValue(mockStreamInstance);
        });

        it('should calculate SHA1 hash of a file', async () => {
            const filePath = '/test/file.md';

            vi.mocked(crypto.createHash).mockImplementationOnce(() => ({
                update: vi.fn().mockReturnThis(),
                digest: vi.fn(() => 'a73d328479e0db9668352b22f03ec1c33f269a8b'),
            } as any)); 

            const hash = await getFileHash(filePath);

            expect(mockCreateReadStream).toHaveBeenCalledWith(filePath);
            expect(mockStreamInstance.pipe).toHaveBeenCalled(); 
            expect(mockFinished).toHaveBeenCalledWith(mockStreamInstance); 
            expect(hash).toBe('a73d328479e0db9668352b22f03ec1c33f269a8b');
        });

        it('should throw FileError on read error', async () => {
            const filePath = '/path';
            mockFinished.mockRejectedValue(new FileError('read error', filePath)); 

            await expect(getFileHash(filePath)).rejects.toThrow(FileError);
            expect(mockCreateReadStream).toHaveBeenCalledWith(filePath);
        });
    });
});

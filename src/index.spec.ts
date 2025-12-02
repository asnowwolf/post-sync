import {describe, expect, it, vi} from 'vitest';

const mockName = vi.fn().mockReturnThis();
const mockDescription = vi.fn().mockReturnThis();
const mockVersion = vi.fn().mockReturnThis();
const mockCommand = vi.fn().mockReturnThis();
const mockOption = vi.fn().mockReturnThis();
const mockAction = vi.fn().mockReturnThis();
const mockParse = vi.fn().mockReturnThis();

vi.mock('commander', () => {
    return {
        Command: class {
            name = mockName;
            description = mockDescription;
            version = mockVersion;
            command = mockCommand;
            option = mockOption;
            action = mockAction;
            parse = mockParse;
        },
    };
});

describe('CLI', () => {
    it('should define commands', async () => {
        await import('./index.js');

        expect(mockName).toHaveBeenCalledWith('post-sync');
        expect(mockCommand).toHaveBeenCalledWith('create <path>');
        expect(mockCommand).toHaveBeenCalledWith('publish <path>');
        expect(mockCommand).toHaveBeenCalledWith('clean');
    });
});

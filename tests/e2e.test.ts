import {exec} from 'child_process';
import * as path from 'path';
import {promisify} from 'util';
import {fileURLToPath} from 'url';
import {beforeAll, describe, expect, it} from 'vitest';
import * as fs from 'fs/promises';

const execPromise = promisify(exec);

// Path to the user's test data
const TEST_DATA_PATH = './tests/examples';

// Derive __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Construct the CLI entry command using the compiled JS
const CLI_ENTRY = `node ${path.resolve(__dirname, '../dist/index.js')}`;

// Helper to filter out dotenv messages from stdout/stderr
const filterDotenvLogs = (output: string | undefined) => {
    return (output || '').split('\n').filter(line => !line.includes('[dotenv@')).join('\n');
};

describe('End-to-End Test for post-sync CLI (Full Verification)', () => {
    // Clear the .ps directory to ensure a clean database before ALL tests run
    beforeAll(async () => {
        const psDirPath = path.resolve(__dirname, '../.ps');
        try {
            await fs.rm(psDirPath, {recursive: true, force: true});
            console.log(`Cleaned up .ps directory: ${psDirPath}`);
        } catch (error) {
            console.warn(`Could not clean .ps directory: ${error}`);
        }
    });

    it('should run the create command successfully on the specified directory', async () => {
        // Run without MOCK_WECHAT_API to perform real API calls
        const command = `${CLI_ENTRY} create "${TEST_DATA_PATH}"`;

        try {
            const {stdout, stderr} = await execPromise(command, {
                timeout: 60000,
                // Ensure process.env is passed so config.ts can read WECHAT_APP_ID/SECRET/PROXY_URL
                env: process.env
            });

            const filteredStdout = filterDotenvLogs(stdout);
            const filteredStderr = filterDotenvLogs(stderr);

            console.log('Create command stdout (filtered):', filteredStdout);
            if (filteredStderr) {
                console.error('Create command stderr (filtered):', filteredStderr);
            }

            expect(filteredStdout).toContain("'create' command called");
            // Expect real API calls, not mock logs
            expect(filteredStdout).toContain("Requesting new WeChat access token.");
            expect(filteredStdout).toContain("Successfully obtained new WeChat access token.");
            expect(filteredStdout).toContain("Uploading permanent image");
            expect(filteredStdout).toContain("Successfully uploaded permanent image.");
            expect(filteredStdout).toContain("Creating draft");
            expect(filteredStdout).toContain("Successfully created draft.");
            expect(filteredStdout).not.toContain("An error occurred");

        } catch (error: any) {
            console.error('Failed to execute create command:', filterDotenvLogs(error.stdout || ''), filterDotenvLogs(error.stderr || ''));
            throw error;
        }
    }, 60000);

    it('should run the publish command successfully after creating drafts', async () => {
        // This test depends on the 'create' command having been run, so the DB should have entries.
        // Run without MOCK_WECHAT_API to perform real API calls
        const command = `${CLI_ENTRY} publish "${TEST_DATA_PATH}"`;

        try {
            const {stdout, stderr} = await execPromise(command, {
                timeout: 60000,
                env: process.env // Ensure process.env is passed
            });

            const filteredStdout = filterDotenvLogs(stdout);
            const filteredStderr = filterDotenvLogs(stderr);

            console.log('Publish command stdout (filtered):', filteredStdout);
            if (filteredStderr) {
                console.error('Publish command stderr (filtered):', filteredStderr);
            }

            expect(filteredStdout).toContain("'publish' command called");
            // Expect real API calls, not mock logs
            expect(filteredStdout).toContain("Requesting new WeChat access token.");
            expect(filteredStdout).toContain("Successfully obtained new WeChat access token.");
            expect(filteredStdout).toContain("Publishing draft with media_id");
            expect(filteredStdout).toContain("Successfully submitted for publication.");
            expect(filteredStdout).not.toContain("An error occurred");

        } catch (error: any) {
            console.error('Failed to execute publish command:', filterDotenvLogs(error.stdout || ''), filterDotenvLogs(error.stderr || ''));
            throw error;
        }
    }, 60000);
});

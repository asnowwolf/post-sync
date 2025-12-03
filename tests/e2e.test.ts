import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as http from 'http';
import { AddressInfo } from 'net';

const execPromise = promisify(exec);

// Path to the user's test data
const TEST_DATA_PATH = './tests/examples';

// Derive __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Construct the CLI entry command using the compiled JS
const CLI_ENTRY = `node ${path.resolve(__dirname, '../dist/index.js')}`;

// Globally mock os.homedir to control the home directory for all modules that use it
// Define variables that will hold the dynamically generated paths
let _tempHomedirGlobal: string;
let _tempPostSyncDirGlobal: string;
let _tempConfigPathGlobal: string;
let _tempDbPathGlobal: string;
let _mockServer: http.Server;
let _mockServerPort: number;
interface MockApiRequest { path: string; method: string; body?: any; }
let _mockApiRequests: MockApiRequest[] = [];

vi.mock('os', async (importOriginal) => {
    const actualOs = await importOriginal<typeof os>();
    // Define tempHomedirInstance inside the mock factory to ensure it's initialized before being used by the homedir mock function
    const tempHomedirInstance = path.join(actualOs.tmpdir(), `post-sync-test-home-${Date.now()}`);
    
    return {
        ...actualOs,
        homedir: vi.fn(() => tempHomedirInstance), // Always return the dynamically created temporary homedir
        // Expose these for external access in beforeAll/afterAll
        __tempHomedir: tempHomedirInstance,
        __tempPostSyncDir: path.join(tempHomedirInstance, '.post-sync'),
        __tempConfigPath: path.join(path.join(tempHomedirInstance, '.post-sync'), 'config.json'),
        __tempDbPath: path.join(path.join(tempHomedirInstance, '.post-sync'), 'db.sqlite'),
    };
});

describe('End-to-End Test for post-sync CLI (Full Verification)', () => {
    beforeAll(async () => {
        // Start Mock Server
        _mockServer = http.createServer((req, res) => {
            const url = new URL(req.url || '', `http://localhost:${_mockServerPort}`);
            const pathname = url.pathname;

            let body: any[] = [];
            req.on('data', (chunk) => {
                body.push(chunk);
            }).on('end', () => {
                const requestBody = Buffer.concat(body).toString();
                let parsedBody: any = {};
                try {
                    // Attempt to parse as JSON first
                    if (req.headers['content-type']?.includes('application/json')) {
                        parsedBody = JSON.parse(requestBody);
                    } else if (req.headers['content-type']?.includes('multipart/form-data')) {
                        // For multipart, we just record its presence, parsing is complex
                        parsedBody = { __formData: true, raw: requestBody.substring(0, 100) + '...' };
                    }
                } catch (e) {
                    parsedBody = { __raw: requestBody }; // Store raw if parsing fails
                }

                _mockApiRequests.push({ path: pathname, method: req.method || 'GET', body: parsedBody });

                res.setHeader('Content-Type', 'application/json');
                
                // Simple mock responses
                if (pathname === '/cgi-bin/stable_token') {
                    res.end(JSON.stringify({ access_token: 'mock_access_token', expires_in: 7200 }));
                } else if (pathname === '/cgi-bin/media/uploadimg') {
                    res.end(JSON.stringify({ url: 'http://mock-server/image.jpg' }));
                } else if (pathname === '/cgi-bin/media/upload') {
                    res.end(JSON.stringify({ media_id: 'mock_temp_media_id', type: 'image', created_at: Date.now() }));
                } else if (pathname === '/cgi-bin/material/add_material') {
                    res.end(JSON.stringify({ media_id: 'mock_perm_media_id', url: 'http://mock-server/perm_image.jpg' }));
                } else if (pathname === '/cgi-bin/draft/add') {
                    res.end(JSON.stringify({ media_id: 'mock_draft_media_id' }));
                } else if (pathname === '/cgi-bin/freepublish/submit') {
                    res.end(JSON.stringify({ publish_id: 'mock_publish_id', errcode: 0, errmsg: 'ok' }));
                } else if (pathname === '/cgi-bin/freepublish/get') {
                    res.end(JSON.stringify({ publish_status: 0, errcode: 0, errmsg: 'ok' })); // 0 means success
                } else {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ errcode: 404, errmsg: 'Not Found' }));
                }
            });
        });

        await new Promise<void>((resolve) => {
            _mockServer.listen(0, () => {
                const address = _mockServer.address() as AddressInfo;
                _mockServerPort = address.port;
                console.log(`Mock WeChat API server listening on port ${_mockServerPort}`);
                resolve();
            });
        });

        // Import os after mocking to get the mocked values
        const mockedOs = await import('os');
        _tempHomedirGlobal = (mockedOs as any).__tempHomedir;
        _tempPostSyncDirGlobal = path.join(_tempHomedirGlobal, '.post-sync');
        _tempConfigPathGlobal = path.join(_tempPostSyncDirGlobal, 'config.json');
        _tempDbPathGlobal = path.join(_tempPostSyncDirGlobal, 'db.sqlite');

        // Create temporary home directory structure
        await fs.mkdir(_tempPostSyncDirGlobal, { recursive: true });

        // Write a mock config.json pointing to local mock server
        const mockConfig = {
            wechatApiBaseUrl: `http://localhost:${_mockServerPort}`,
            profiles: [
                {
                    id: 'default',
                    appId: 'mock_app_id',
                    appSecret: 'mock_app_secret',
                },
                {
                    id: 'tech_blog',
                    appId: 'mock_tech_blog_app_id',
                    appSecret: 'mock_tech_blog_app_secret',
                },
            ],
        };
        await fs.writeFile(_tempConfigPathGlobal, JSON.stringify(mockConfig), 'utf-8');

        console.log(`Using temporary work directory: ${_tempPostSyncDirGlobal}`);
        console.log(`Mock config written to: ${_tempConfigPathGlobal}`);
    }, 60000);

    // Clear API requests before each test
    beforeEach(() => {
        _mockApiRequests = [];
    });


    afterAll(async () => {
        // Stop Mock Server
        if (_mockServer) {
            _mockServer.close();
        }

        // Clean up temporary home directory
        try {
            await fs.rm(_tempHomedirGlobal, { recursive: true, force: true });
            console.log(`Cleaned up temporary home directory: ${_tempHomedirGlobal}`);
        } catch (error) {
            console.warn(`Could not clean temporary home directory ${_tempHomedirGlobal}: ${error}`);
        }
    }, 60000);

    it('should run the create command successfully on the specified directory', async () => {
        const command = `${CLI_ENTRY} create "${TEST_DATA_PATH}"`;

        try {
            const { stdout, stderr } = await execPromise(command, {
                timeout: 60000,
                env: { ...process.env, HOME: _tempHomedirGlobal, WECHAT_API_BASE_URL: '' } // Unset WECHAT_API_BASE_URL
            });

            console.log('Create command stdout:', stdout);
            if (stderr) {
                console.error('Create command stderr:', stderr);
            }

            expect(stdout).toContain("'create' command called");
            expect(stdout).not.toContain("[dotenv@"); // Should not use .env
            expect(stdout).toContain(`Database connected at ${_tempDbPathGlobal}`); // New DB path
            // Removed specific WeChat API call expectations as they can vary
            expect(stdout).toContain("Processing");
            // Verify database file exists
            await expect(fs.access(_tempDbPathGlobal)).resolves.toBeUndefined();

            // --- WeChat API Call Assertions for 'create' command ---
            // Expect 4 calls for addPermanentMaterial (2 manual cover uploads + 2 cover-in-body uploads due to lack of get_material mock)
            const addMaterialCalls = _mockApiRequests.filter(req => req.path.includes('/cgi-bin/material/add_material'));
            expect(addMaterialCalls).toHaveLength(4);


            // Expect 2 calls for createDraft (for two articles)
            const createDraftCalls = _mockApiRequests.filter(req => req.path.includes('/cgi-bin/draft/add'));
            expect(createDraftCalls).toHaveLength(2);
            // Sort calls by title to ensure order, as file processing order might vary? fileUtil sorts alphabetically.
            // article1 comes before article2.
            expect(createDraftCalls[0].body.articles[0].title).toEqual('Article 1');
            expect(createDraftCalls[0].body.articles[0].thumb_media_id).toEqual('mock_perm_media_id');
            expect(createDraftCalls[1].body.articles[0].title).toEqual('Article 2');
            expect(createDraftCalls[1].body.articles[0].thumb_media_id).toEqual('mock_perm_media_id');

        } catch (error: any) {
            console.error('Failed to execute create command:', error.stdout || '', error.stderr || '');
            throw error;
        }
    }, 60000);

    it('should run the publish command successfully after creating drafts', async () => {
        const command = `${CLI_ENTRY} publish "${TEST_DATA_PATH}" -y`;

        try {
            const { stdout, stderr } = await execPromise(command, {
                timeout: 60000,
                env: { ...process.env, HOME: _tempHomedirGlobal, WECHAT_API_BASE_URL: '' } // Unset WECHAT_API_BASE_URL
            });

            console.log('Publish command stdout:', stdout);
            if (stderr) {
                console.error('Publish command stderr:', stderr);
            }

            expect(stdout).toContain("'publish' command called");
            expect(stdout).not.toContain("[dotenv@"); // Should not use .env
            expect(stdout).toContain(`Database connected at ${_tempDbPathGlobal}`); // New DB path
            expect(stdout).toContain("Publishing draft with media_id");
            expect(stdout).toContain("Successfully submitted for publication.");
            expect(stdout).not.toContain("An error occurred");

            // --- WeChat API Call Assertions for 'publish' command ---
            const publishDraftCalls = _mockApiRequests.filter(req => req.path.includes('/cgi-bin/freepublish/submit'));
            expect(publishDraftCalls).toHaveLength(2); // Should attempt to publish both articles
            expect(publishDraftCalls[0].body).toEqual({ media_id: 'mock_draft_media_id' });
            expect(publishDraftCalls[1].body).toEqual({ media_id: 'mock_draft_media_id' });

        } catch (error: any) {
            console.error('Failed to execute publish command:', error.stdout || '', error.stderr || '');
            throw error;
        }
    }, 60000);

    it('should run the post command successfully (create and publish)', async () => {
        // Clear the database for a clean run of the post command
        await fs.rm(_tempDbPathGlobal, { force: true });

        const command = `${CLI_ENTRY} post "${TEST_DATA_PATH}" -y`;

        try {
            const { stdout, stderr } = await execPromise(command, {
                timeout: 60000,
                env: { ...process.env, HOME: _tempHomedirGlobal, WECHAT_API_BASE_URL: '' } // Unset WECHAT_API_BASE_URL
            });

            console.log('Post command stdout:', stdout);
            if (stderr) {
                console.error('Post command stderr:', stderr);
            }

            expect(stdout).toContain("'post' command called");
            expect(stdout).not.toContain("[dotenv@"); // Should not use .env
            expect(stdout).toContain(`Database connected at ${_tempDbPathGlobal}`); // New DB path
            expect(stdout).toContain("Processing");
            expect(stdout).toContain("Successfully created draft.");
            expect(stdout).toContain("Attempting to publish draft");
            expect(stdout).toContain("Successfully submitted for publication.");
            expect(stdout).not.toContain("An error occurred");

            // Verify database file exists
            await expect(fs.access(_tempDbPathGlobal)).resolves.toBeUndefined();

            // --- WeChat API Call Assertions for 'post' command ---
            // Expect 4 calls for addPermanentMaterial
            const addMaterialCalls = _mockApiRequests.filter(req => req.path.includes('/cgi-bin/material/add_material'));
            expect(addMaterialCalls).toHaveLength(4);


            // Expect 2 calls for createDraft
            const createDraftCalls = _mockApiRequests.filter(req => req.path.includes('/cgi-bin/draft/add'));
            expect(createDraftCalls).toHaveLength(2);
            expect(createDraftCalls[0].body.articles[0].title).toEqual('Article 1');
            expect(createDraftCalls[0].body.articles[0].thumb_media_id).toEqual('mock_perm_media_id');
            expect(createDraftCalls[1].body.articles[0].title).toEqual('Article 2');
            expect(createDraftCalls[1].body.articles[0].thumb_media_id).toEqual('mock_perm_media_id');


            // Expect 2 calls for publishDraft
            const publishDraftCalls = _mockApiRequests.filter(req => req.path.includes('/cgi-bin/freepublish/submit'));
            expect(publishDraftCalls).toHaveLength(2);
            expect(publishDraftCalls[0].body).toEqual({ media_id: 'mock_draft_media_id' });
            expect(publishDraftCalls[1].body).toEqual({ media_id: 'mock_draft_media_id' });

        } catch (error: any) {
            console.error('Failed to execute post command:', error.stdout || '', error.stderr || '');
            throw error;
        }
    }, 60000);
});

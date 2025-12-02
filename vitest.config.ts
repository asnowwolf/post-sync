import {defineConfig} from 'vitest/config';

import * as path from 'path'; // Import path

export default defineConfig({
    test: {
        globals: true, // Enable Jest-like globals (describe, it, expect)
        environment: 'node',
    },
    resolve: {
        alias: {
            '@utils/': path.resolve(__dirname, './src/utils/'), // Use path.resolve
        },
    },
});

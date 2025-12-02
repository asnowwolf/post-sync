import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        globals: true, // Enable Jest-like globals (describe, it, expect)
        environment: 'node',
    },
});

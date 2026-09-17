import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { characterApiPlugin } from './server/vite-plugin';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    plugins: [
      react(),
      characterApiPlugin({
        NEXON_API_KEY: env.NEXON_API_KEY,
        ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      }),
    ],
    test: { include: ['tests/**/*.test.ts'] },
    build: { target: 'es2022' },
  };
});

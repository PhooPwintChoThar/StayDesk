import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

if (process.env.VITEST) {
  process.env.VITE_DEV_ROLE_SWITCH = process.env.VITE_DEV_ROLE_SWITCH || 'true';
}

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.js',
    // Form-filling tests type many fields; allow for slower machines.
    testTimeout: 20000
  }
});
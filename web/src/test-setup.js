import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { logout } from './api.js';
import { clearToasts } from './toast.js';

afterEach(() => {
	cleanup();
	logout();
	clearToasts();
});
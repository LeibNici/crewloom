import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setAuthContext } from '../src/api/client';

afterEach(() => {
  cleanup();
  setAuthContext({ token: null, role: null });
  try {
    window.localStorage.clear();
  } catch {
    /* 忽略 */
  }
});

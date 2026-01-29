import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  getWebexBaseUrl,
  getWebexToken,
  getWebexHeaders,
  getWebexJsonHeaders,
  getWebexUrl,
  validateWebexConfig,
  initializeAuth,
  isAuthInitialized
} from '../lib/webex-config.js';

describe('Webex Configuration Module', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('getWebexBaseUrl', () => {
    it('should return default base URL when env var is not set', () => {
      delete process.env.WEBEX_API_BASE_URL;
      const baseUrl = getWebexBaseUrl();
      assert.strictEqual(baseUrl, 'https://webexapis.com/v1');
    });

    it('should return custom base URL when env var is set', () => {
      process.env.WEBEX_API_BASE_URL = 'https://custom.webex.com/v2';
      const baseUrl = getWebexBaseUrl();
      assert.strictEqual(baseUrl, 'https://custom.webex.com/v2');
    });
  });

  describe('getWebexToken (after initializeAuth)', () => {
    beforeEach(async () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'test-token-123';
      await initializeAuth();
    });

    it('should return token without Bearer prefix', async () => {
      const token = await getWebexToken();
      assert.strictEqual(token, 'test-token-123');
    });
  });

  describe('getWebexToken with Bearer prefix (after initializeAuth)', () => {
    beforeEach(async () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'Bearer test-token-123';
      await initializeAuth();
    });

    it('should remove Bearer prefix if present', async () => {
      const token = await getWebexToken();
      assert.strictEqual(token, 'test-token-123');
    });
  });

  describe('getWebexToken without initialization', () => {
    it('should throw error when auth is not initialized', () => {
      // This test runs without initializeAuth being called for this context
      // Note: Due to module-level state, this test may not work as expected
      // if initializeAuth was called in a previous test
    });
  });

  describe('getWebexHeaders', () => {
    beforeEach(async () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'test-token-123';
      await initializeAuth();
    });

    it('should return standard headers with Authorization', async () => {
      const headers = await getWebexHeaders();
      assert.deepStrictEqual(headers, {
        'Accept': 'application/json',
        'Authorization': 'Bearer test-token-123'
      });
    });

    it('should merge additional headers', async () => {
      const headers = await getWebexHeaders({ 'Custom-Header': 'custom-value' });
      assert.deepStrictEqual(headers, {
        'Accept': 'application/json',
        'Authorization': 'Bearer test-token-123',
        'Custom-Header': 'custom-value'
      });
    });

    it('should allow overriding default headers', async () => {
      const headers = await getWebexHeaders({ 'Accept': 'text/plain' });
      assert.deepStrictEqual(headers, {
        'Accept': 'text/plain',
        'Authorization': 'Bearer test-token-123'
      });
    });
  });

  describe('getWebexJsonHeaders', () => {
    beforeEach(async () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'test-token-123';
      await initializeAuth();
    });

    it('should return JSON headers with Content-Type', async () => {
      const headers = await getWebexJsonHeaders();
      assert.deepStrictEqual(headers, {
        'Accept': 'application/json',
        'Authorization': 'Bearer test-token-123',
        'Content-Type': 'application/json'
      });
    });

    it('should merge additional headers with JSON headers', async () => {
      const headers = await getWebexJsonHeaders({ 'X-Custom': 'value' });
      assert.deepStrictEqual(headers, {
        'Accept': 'application/json',
        'Authorization': 'Bearer test-token-123',
        'Content-Type': 'application/json',
        'X-Custom': 'value'
      });
    });
  });

  describe('getWebexUrl', () => {
    beforeEach(() => {
      process.env.WEBEX_API_BASE_URL = 'https://webexapis.com/v1';
    });

    it('should construct URL with leading slash', () => {
      const url = getWebexUrl('/messages');
      assert.strictEqual(url, 'https://webexapis.com/v1/messages');
    });

    it('should construct URL without leading slash', () => {
      const url = getWebexUrl('messages');
      assert.strictEqual(url, 'https://webexapis.com/v1/messages');
    });

    it('should handle complex endpoints', () => {
      const url = getWebexUrl('/rooms/123/messages');
      assert.strictEqual(url, 'https://webexapis.com/v1/rooms/123/messages');
    });

    it('should work with custom base URL', () => {
      process.env.WEBEX_API_BASE_URL = 'https://custom.api.com/v2';
      const url = getWebexUrl('/test');
      assert.strictEqual(url, 'https://custom.api.com/v2/test');
    });
  });

  describe('validateWebexConfig', () => {
    it('should not throw when static token is set', () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'test-token';
      assert.doesNotThrow(() => {
        validateWebexConfig();
      });
    });

    it('should not throw when OAuth credentials are set', () => {
      delete process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
      process.env.WEBEX_OAUTH_CLIENT_ID = 'test-client-id';
      process.env.WEBEX_OAUTH_CLIENT_SECRET = 'test-client-secret';
      assert.doesNotThrow(() => {
        validateWebexConfig();
      });
    });

    it('should throw when no auth method is configured', () => {
      delete process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
      delete process.env.WEBEX_OAUTH_CLIENT_ID;
      delete process.env.WEBEX_OAUTH_CLIENT_SECRET;
      delete process.env.WEBEX_AUTO_REFRESH_TOKEN;
      assert.throws(() => {
        validateWebexConfig();
      }, /Missing authentication configuration/);
    });

    it('should throw when static token is empty and no OAuth', () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = '';
      delete process.env.WEBEX_OAUTH_CLIENT_ID;
      delete process.env.WEBEX_OAUTH_CLIENT_SECRET;
      delete process.env.WEBEX_AUTO_REFRESH_TOKEN;
      assert.throws(() => {
        validateWebexConfig();
      }, /Missing authentication configuration/);
    });
  });

  describe('initializeAuth', () => {
    it('should initialize with static token', async () => {
      process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'static-test-token';
      await initializeAuth();
      assert.strictEqual(isAuthInitialized(), true);
      assert.strictEqual(await getWebexToken(), 'static-test-token');
    });

    it('should throw when no auth method configured', async () => {
      delete process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
      delete process.env.WEBEX_OAUTH_CLIENT_ID;
      delete process.env.WEBEX_OAUTH_CLIENT_SECRET;
      delete process.env.WEBEX_AUTO_REFRESH_TOKEN;
      await assert.rejects(
        async () => { await initializeAuth(); },
        /No authentication configured/
      );
    });
  });
});

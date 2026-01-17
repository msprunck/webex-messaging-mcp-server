/**
 * Webex API Configuration Module
 * Centralizes authentication and base URL configuration for all Webex tools
 * Supports static API tokens, auto-refresh personal tokens, and OAuth authentication
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getValidToken, hasOAuthCredentials, setCachedToken, getCachedToken, getAuthStatus, forceReauthenticate, clearTokens } from './oauth/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Internal state
let _cachedToken = null;
let _authInitialized = false;
let _authMethod = null;  // 'static', 'auto-refresh', or 'oauth'

// Lazy-loaded keychain module (only on macOS with auto-refresh enabled)
let _keychainTokenManager = null;

/**
 * Initialize authentication
 * Must be called before server starts accepting requests
 * Handles OAuth flow if needed and caches the token for synchronous access
 * @returns {Promise<void>}
 */
export async function initializeAuth() {
  // Priority 1: Static token from environment (backward compatible)
  const staticToken = process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
  if (staticToken) {
    _cachedToken = staticToken.replace(/^Bearer\s+/, '');
    _authInitialized = true;
    _authMethod = 'static';
    console.error('[Auth] Using static API key from environment');
    return;
  }

  // Priority 2: Auto-refresh personal token (macOS only)
  if (process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true') {
    if (process.platform !== 'darwin') {
      throw new Error('Auto-refresh token is only supported on macOS');
    }

    console.error('[Auth] Using auto-refresh personal token mode...');
    _keychainTokenManager = await import('./keychain/token-manager.js');

    // Set up callback for when token is refreshed
    _keychainTokenManager.setTokenRefreshCallback((newToken) => {
      _cachedToken = newToken;
      console.error('[Auth] Token refreshed via auto-refresh');
    });

    _cachedToken = await _keychainTokenManager.getValidToken();
    _authInitialized = true;
    _authMethod = 'auto-refresh';
    console.error('[Auth] Auto-refresh authentication complete');
    return;
  }

  // Priority 3: OAuth flow
  if (hasOAuthCredentials()) {
    console.error('[Auth] No static token found, using OAuth...');
    _cachedToken = await getValidToken();
    _authInitialized = true;
    _authMethod = 'oauth';
    console.error('[Auth] OAuth authentication complete');
    return;
  }

  // No authentication method available
  throw new Error(
    'No authentication configured. Either set WEBEX_PUBLIC_WORKSPACE_API_KEY, ' +
    'WEBEX_AUTO_REFRESH_TOKEN=true (macOS), or configure OAuth with ' +
    'WEBEX_OAUTH_CLIENT_ID and WEBEX_OAUTH_CLIENT_SECRET'
  );
}

/**
 * Check if authentication has been initialized
 * @returns {boolean} True if initialized
 */
export function isAuthInitialized() {
  return _authInitialized;
}

/**
 * Get the Webex API base URL
 * @returns {string} The base URL for Webex API
 */
export function getWebexBaseUrl() {
  return process.env.WEBEX_API_BASE_URL || 'https://webexapis.com/v1';
}

/**
 * Get the Webex API token (without Bearer prefix)
 * @returns {string} The API token
 * @throws {Error} If authentication not initialized
 */
export function getWebexToken() {
  // Check if using OAuth and token might have been refreshed
  if (_authMethod === 'oauth') {
    const oauthToken = getCachedToken();
    if (oauthToken) {
      _cachedToken = oauthToken;
    }
  }

  // Check if using auto-refresh and token might have been refreshed
  if (_authMethod === 'auto-refresh' && _keychainTokenManager) {
    const autoRefreshToken = _keychainTokenManager.getCachedToken();
    if (autoRefreshToken) {
      _cachedToken = autoRefreshToken;
    }
  }

  if (!_authInitialized) {
    throw new Error('Authentication not initialized. Call initializeAuth() first.');
  }

  if (!_cachedToken) {
    throw new Error('No valid token available. Authentication may have failed.');
  }

  return _cachedToken;
}

/**
 * Get standard headers for Webex API requests
 * @param {Object} additionalHeaders - Additional headers to include
 * @returns {Object} Headers object for fetch requests
 */
export function getWebexHeaders(additionalHeaders = {}) {
  const token = getWebexToken();

  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...additionalHeaders
  };
}

/**
 * Get headers for POST/PUT requests with JSON content
 * @param {Object} additionalHeaders - Additional headers to include
 * @returns {Object} Headers object for JSON requests
 */
export function getWebexJsonHeaders(additionalHeaders = {}) {
  return getWebexHeaders({
    'Content-Type': 'application/json',
    ...additionalHeaders
  });
}

/**
 * Construct a full Webex API URL
 * @param {string} endpoint - The API endpoint (e.g., '/messages', '/rooms')
 * @returns {string} The complete URL
 */
export function getWebexUrl(endpoint) {
  const baseUrl = getWebexBaseUrl();
  // Ensure endpoint starts with /
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${baseUrl}${cleanEndpoint}`;
}

/**
 * Validate that authentication is configured
 * @throws {Error} If no authentication method is configured
 */
export function validateWebexConfig() {
  const hasStaticToken = !!process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
  const hasAutoRefresh = process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true';
  const hasOAuth = hasOAuthCredentials();

  if (!hasStaticToken && !hasAutoRefresh && !hasOAuth) {
    throw new Error(
      'Missing authentication configuration. Set WEBEX_PUBLIC_WORKSPACE_API_KEY, ' +
      'WEBEX_AUTO_REFRESH_TOKEN=true (macOS), or configure OAuth with ' +
      'WEBEX_OAUTH_CLIENT_ID and WEBEX_OAUTH_CLIENT_SECRET'
    );
  }
}

// Validate configuration on module load (warning only, actual init happens at startup)
try {
  validateWebexConfig();
} catch (error) {
  console.warn(`[Webex Config Warning] ${error.message}`);
}

/**
 * Get full authentication status
 * @returns {Promise<Object>} Authentication status details
 */
export async function getFullAuthStatus() {
  const hasStaticToken = !!process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
  const hasAutoRefresh = process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true';

  if (hasStaticToken) {
    return {
      authenticated: true,
      method: 'static_token',
      message: 'Using static API token from WEBEX_PUBLIC_WORKSPACE_API_KEY'
    };
  }

  if (hasAutoRefresh) {
    if (_keychainTokenManager) {
      const tokenStatus = await _keychainTokenManager.getTokenStatus();
      return {
        authenticated: tokenStatus.isValid,
        method: 'auto_refresh',
        message: tokenStatus.isValid
          ? `Using auto-refresh personal token (expires in ${tokenStatus.expiresIn})`
          : 'Auto-refresh token expired or not yet fetched',
        tokenStatus
      };
    }
    return {
      authenticated: false,
      method: 'auto_refresh',
      message: 'Auto-refresh mode configured but not initialized'
    };
  }

  if (hasOAuthCredentials()) {
    return await getAuthStatus();
  }

  return {
    authenticated: false,
    method: null,
    message: 'No authentication configured'
  };
}

/**
 * Authenticate with OAuth (handles both first-time auth and re-authentication)
 * @param {boolean} force - Force re-authentication even if already authenticated
 * @returns {Promise<Object>} Result of authentication
 */
export async function reauthenticate(force = true) {
  const hasStaticToken = !!process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
  const hasAutoRefresh = process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true';

  if (hasStaticToken) {
    return {
      success: false,
      message: 'Cannot authenticate when using static token. Update WEBEX_PUBLIC_WORKSPACE_API_KEY environment variable instead.'
    };
  }

  // Handle auto-refresh mode
  if (hasAutoRefresh) {
    return await refreshAutoToken();
  }

  if (!hasOAuthCredentials()) {
    return {
      success: false,
      message: 'OAuth not configured. Set WEBEX_OAUTH_CLIENT_ID and WEBEX_OAUTH_CLIENT_SECRET in your .env file.'
    };
  }

  try {
    let token;
    if (force) {
      // Force re-authentication
      token = await forceReauthenticate();
    } else {
      // Try to get valid token (may use cached/stored token)
      token = await getValidToken();
    }
    _cachedToken = token;
    _authInitialized = true;
    _authMethod = 'oauth';
    return {
      success: true,
      message: 'Authentication successful'
    };
  } catch (error) {
    return {
      success: false,
      message: `Authentication failed: ${error.message}`
    };
  }
}

/**
 * Force refresh the auto-refresh personal token
 * @returns {Promise<Object>} Result of refresh
 */
export async function refreshAutoToken() {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      message: 'Auto-refresh token is only supported on macOS'
    };
  }

  try {
    if (!_keychainTokenManager) {
      _keychainTokenManager = await import('./keychain/token-manager.js');
      _keychainTokenManager.setTokenRefreshCallback((newToken) => {
        _cachedToken = newToken;
        console.error('[Auth] Token refreshed via auto-refresh');
      });
    }

    console.error('[Auth] Forcing token refresh via browser...');
    _cachedToken = await _keychainTokenManager.forceRefresh();
    _authInitialized = true;
    _authMethod = 'auto-refresh';

    return {
      success: true,
      message: 'Personal token refreshed successfully via browser automation'
    };
  } catch (error) {
    return {
      success: false,
      message: `Token refresh failed: ${error.message}`
    };
  }
}

/**
 * Logout - clear stored tokens
 * @returns {Promise<Object>} Result of logout
 */
export async function logout() {
  const hasStaticToken = !!process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
  const hasAutoRefresh = process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true';

  if (hasStaticToken) {
    return {
      success: false,
      message: 'Cannot logout when using static token. Remove WEBEX_PUBLIC_WORKSPACE_API_KEY environment variable to disable.'
    };
  }

  try {
    // Clear auto-refresh tokens if applicable
    if (hasAutoRefresh && _keychainTokenManager) {
      await _keychainTokenManager.clearCachedToken();
    }

    // Clear OAuth tokens
    await clearTokens();

    _cachedToken = null;
    _authInitialized = false;
    _authMethod = null;

    return {
      success: true,
      message: 'Logged out successfully. Stored tokens have been cleared.'
    };
  } catch (error) {
    return {
      success: false,
      message: `Logout failed: ${error.message}`
    };
  }
}

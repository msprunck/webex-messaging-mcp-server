/**
 * Token Manager
 * Orchestrates token retrieval, caching, and automatic refresh scheduling
 */

import { storeToken, loadToken, clearToken, isTokenValid } from './index.js';
import { fetchTokenFromBrowser } from './browser-automation.js';

// How many minutes before expiry to trigger refresh
const REFRESH_BEFORE_EXPIRY_MINUTES = 30;

// Internal state
let _refreshTimeout = null;
let _cachedToken = null;
let _tokenExpiresAt = null;
let _onTokenRefreshed = null;

/**
 * Set a callback to be called when token is refreshed
 * @param {Function} callback - Callback function that receives the new token
 */
export function setTokenRefreshCallback(callback) {
  _onTokenRefreshed = callback;
}

/**
 * Get a valid token, fetching from browser if necessary
 * @returns {Promise<string>} The valid access token
 */
export async function getValidToken() {
  // First, check if we have a valid cached token in memory
  if (_cachedToken && _tokenExpiresAt && _tokenExpiresAt > new Date()) {
    return _cachedToken;
  }

  // Check Keychain for stored token
  const stored = await loadToken();

  if (stored && stored.expiresAt > new Date()) {
    // Token is still valid
    _cachedToken = stored.token;
    _tokenExpiresAt = stored.expiresAt;

    // Schedule refresh before expiry
    scheduleRefresh(stored.expiresAt);

    console.error('[TokenManager] Using valid token from Keychain');
    return stored.token;
  }

  // Token is missing or expired, fetch new one from browser
  console.error('[TokenManager] Token expired or missing, fetching from browser...');
  return await forceRefresh();
}

/**
 * Force refresh the token via browser automation
 * @returns {Promise<string>} The new access token
 */
export async function forceRefresh() {
  console.error('[TokenManager] Starting browser token extraction...');

  const { token, expiresAt } = await fetchTokenFromBrowser();

  // Store in Keychain
  await storeToken(token, expiresAt);

  // Cache in memory
  _cachedToken = token;
  _tokenExpiresAt = expiresAt;

  // Schedule next refresh
  scheduleRefresh(expiresAt);

  // Notify callback if set
  if (_onTokenRefreshed) {
    _onTokenRefreshed(token);
  }

  console.error(`[TokenManager] Token refreshed, expires at ${expiresAt.toISOString()}`);

  return token;
}

/**
 * Schedule automatic token refresh before expiry
 * @param {Date} expiresAt - When the current token expires
 */
function scheduleRefresh(expiresAt) {
  // Clear any existing scheduled refresh
  if (_refreshTimeout) {
    clearTimeout(_refreshTimeout);
    _refreshTimeout = null;
  }

  // Calculate when to refresh (REFRESH_BEFORE_EXPIRY_MINUTES before expiry)
  const refreshAt = new Date(expiresAt.getTime() - REFRESH_BEFORE_EXPIRY_MINUTES * 60 * 1000);
  const now = new Date();
  const msUntilRefresh = refreshAt.getTime() - now.getTime();

  if (msUntilRefresh <= 0) {
    // Token will expire within the refresh window, refresh immediately
    console.error('[TokenManager] Token expiring soon, scheduling immediate refresh');
    _refreshTimeout = setTimeout(async () => {
      try {
        await forceRefresh();
      } catch (error) {
        console.error('[TokenManager] Scheduled refresh failed:', error.message);
      }
    }, 1000);  // Small delay to avoid blocking
    return;
  }

  // Schedule refresh
  console.error(`[TokenManager] Scheduling refresh in ${Math.round(msUntilRefresh / 1000 / 60)} minutes`);

  _refreshTimeout = setTimeout(async () => {
    try {
      console.error('[TokenManager] Executing scheduled token refresh...');
      await forceRefresh();
    } catch (error) {
      console.error('[TokenManager] Scheduled refresh failed:', error.message);
      // Retry in 5 minutes if refresh fails
      _refreshTimeout = setTimeout(async () => {
        try {
          await forceRefresh();
        } catch (retryError) {
          console.error('[TokenManager] Refresh retry failed:', retryError.message);
        }
      }, 5 * 60 * 1000);
    }
  }, msUntilRefresh);
}

/**
 * Get the current cached token (if any)
 * @returns {string|null}
 */
export function getCachedToken() {
  if (_cachedToken && _tokenExpiresAt && _tokenExpiresAt > new Date()) {
    return _cachedToken;
  }
  return null;
}

/**
 * Clear the cached token and stop any scheduled refreshes
 */
export async function clearCachedToken() {
  if (_refreshTimeout) {
    clearTimeout(_refreshTimeout);
    _refreshTimeout = null;
  }

  _cachedToken = null;
  _tokenExpiresAt = null;

  await clearToken();
  console.error('[TokenManager] Token cache cleared');
}

/**
 * Get token status information
 * @returns {Promise<Object>}
 */
export async function getTokenStatus() {
  const stored = await loadToken();

  if (!stored) {
    return {
      hasToken: false,
      isValid: false,
      expiresAt: null,
      expiresIn: null
    };
  }

  const now = new Date();
  const isValid = stored.expiresAt > now;
  const expiresIn = isValid ? Math.round((stored.expiresAt.getTime() - now.getTime()) / 1000 / 60) : 0;

  return {
    hasToken: true,
    isValid,
    expiresAt: stored.expiresAt.toISOString(),
    expiresIn: isValid ? `${expiresIn} minutes` : 'expired'
  };
}

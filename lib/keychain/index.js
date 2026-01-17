/**
 * macOS Keychain Integration
 * Stores and retrieves personal access tokens securely using the macOS Keychain
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const KEYCHAIN_SERVICE = 'webex-mcp-server';
const KEYCHAIN_ACCOUNT = 'personal-access-token';
const KEYCHAIN_EXPIRY_ACCOUNT = 'personal-access-token-expiry';

/**
 * Store token in macOS Keychain
 * @param {string} token - The access token to store
 * @param {Date} expiresAt - When the token expires
 */
export async function storeToken(token, expiresAt) {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain storage is only supported on macOS');
  }

  // Delete existing entries first (ignore errors if they don't exist)
  try {
    await deleteFromKeychain(KEYCHAIN_ACCOUNT);
  } catch (e) {
    // Ignore - may not exist
  }
  try {
    await deleteFromKeychain(KEYCHAIN_EXPIRY_ACCOUNT);
  } catch (e) {
    // Ignore - may not exist
  }

  // Store the token
  await addToKeychain(KEYCHAIN_ACCOUNT, token);

  // Store the expiry time as ISO string
  await addToKeychain(KEYCHAIN_EXPIRY_ACCOUNT, expiresAt.toISOString());

  console.error('[Keychain] Token stored successfully');
}

/**
 * Load token from macOS Keychain
 * @returns {Promise<{token: string, expiresAt: Date} | null>}
 */
export async function loadToken() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const token = await getFromKeychain(KEYCHAIN_ACCOUNT);
    const expiryStr = await getFromKeychain(KEYCHAIN_EXPIRY_ACCOUNT);

    if (!token || !expiryStr) {
      return null;
    }

    const expiresAt = new Date(expiryStr);

    return { token, expiresAt };
  } catch (error) {
    // Token not found or error reading
    console.error('[Keychain] No stored token found');
    return null;
  }
}

/**
 * Clear token from macOS Keychain
 */
export async function clearToken() {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    await deleteFromKeychain(KEYCHAIN_ACCOUNT);
  } catch (e) {
    // Ignore - may not exist
  }
  try {
    await deleteFromKeychain(KEYCHAIN_EXPIRY_ACCOUNT);
  } catch (e) {
    // Ignore - may not exist
  }

  console.error('[Keychain] Token cleared');
}

/**
 * Check if a valid (non-expired) token exists in Keychain
 * @returns {Promise<boolean>}
 */
export async function isTokenValid() {
  const stored = await loadToken();

  if (!stored) {
    return false;
  }

  // Check if token is expired
  const now = new Date();
  return stored.expiresAt > now;
}

/**
 * Add an item to the Keychain
 * @param {string} account - The account name
 * @param {string} password - The password/value to store
 */
async function addToKeychain(account, password) {
  // Use -U flag to update if exists, otherwise add
  const command = [
    'security',
    'add-generic-password',
    '-a', account,
    '-s', KEYCHAIN_SERVICE,
    '-w', password,
    '-U'  // Update if exists
  ];

  try {
    await execAsync(command.map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' '));
  } catch (error) {
    throw new Error(`Failed to store in Keychain: ${error.message}`);
  }
}

/**
 * Get an item from the Keychain
 * @param {string} account - The account name
 * @returns {Promise<string>}
 */
async function getFromKeychain(account) {
  const command = [
    'security',
    'find-generic-password',
    '-a', account,
    '-s', KEYCHAIN_SERVICE,
    '-w'  // Output only the password
  ];

  try {
    const { stdout } = await execAsync(command.map(arg => `"${arg}"`).join(' '));
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to read from Keychain: ${error.message}`);
  }
}

/**
 * Delete an item from the Keychain
 * @param {string} account - The account name
 */
async function deleteFromKeychain(account) {
  const command = [
    'security',
    'delete-generic-password',
    '-a', account,
    '-s', KEYCHAIN_SERVICE
  ];

  try {
    await execAsync(command.map(arg => `"${arg}"`).join(' '));
  } catch (error) {
    // Ignore errors - item may not exist
  }
}

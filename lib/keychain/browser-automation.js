/**
 * Browser Automation for Token Extraction
 * Uses AppleScript to control Chrome and extract personal access token from Webex developer portal
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

const WEBEX_DEVELOPER_PORTAL = 'https://developer.webex.com/docs/getting-started';
const TOKEN_LIFETIME_HOURS = 12;

/**
 * Fetch token from Webex developer portal via Chrome browser automation
 * @returns {Promise<{token: string, expiresAt: Date}>}
 */
export async function fetchTokenFromBrowser() {
  if (process.platform !== 'darwin') {
    throw new Error('Browser automation is only supported on macOS');
  }

  // Check if Chrome is installed
  await checkChromeInstalled();

  console.error('[Browser] Opening Webex developer portal in Chrome...');

  // Execute AppleScript to open Chrome, navigate to the page, and extract token
  const token = await executeAppleScript();

  if (!token) {
    throw new Error(
      'Could not extract token from Webex developer portal. ' +
      'Please ensure you are logged into developer.webex.com in Chrome.'
    );
  }

  // Calculate expiry time (12 hours from now)
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_HOURS * 60 * 60 * 1000);

  console.error('[Browser] Token extracted successfully');

  return { token, expiresAt };
}

/**
 * Check if Google Chrome is installed
 */
async function checkChromeInstalled() {
  try {
    await execAsync('test -d "/Applications/Google Chrome.app"');
  } catch (error) {
    throw new Error(
      'Google Chrome is not installed. Please install Chrome from https://www.google.com/chrome/'
    );
  }
}

/**
 * Execute AppleScript to extract token from Chrome
 * @returns {Promise<string|null>}
 */
async function executeAppleScript() {
  // JavaScript to click the copy button for the token
  const clickCopyJs = `
(function() {
  var copyBtn = document.querySelector('#copy-token-modal-button');
  if (copyBtn) {
    copyBtn.click();
    return 'clicked_copy';
  }
  return 'not_found';
})()
`.trim();

  // JavaScript to click the OK confirmation button
  const clickOkJs = `
(function() {
  var okBtn = document.querySelector('#confirm-copy-button');
  if (okBtn) {
    okBtn.click();
    return 'clicked_ok';
  }
  return 'not_found';
})()
`.trim();

  // Create AppleScript content that clicks copy button, OK button, and reads clipboard
  const appleScript = `
tell application "Google Chrome"
  activate

  if (count of windows) = 0 then
    make new window
  end if

  set URL of active tab of front window to "${WEBEX_DEVELOPER_PORTAL}"

  set maxWait to 15
  set waited to 0
  repeat while waited < maxWait
    delay 1
    set waited to waited + 1
    try
      set pageState to execute active tab of front window javascript "document.readyState"
      if pageState is "complete" then
        exit repeat
      end if
    end try
  end repeat

  delay 3

  -- Click the copy button
  try
    execute active tab of front window javascript "${clickCopyJs.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
    delay 1
  end try

  -- Click the OK confirmation button
  try
    execute active tab of front window javascript "${clickOkJs.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
    delay 0.5
  end try
end tell

-- Read from clipboard
delay 0.5
set tokenValue to the clipboard
return tokenValue
`;

  // Write AppleScript to temp file to avoid shell escaping issues
  const tmpFile = join(tmpdir(), `webex-token-${Date.now()}.scpt`);

  try {
    writeFileSync(tmpFile, appleScript, 'utf8');

    const { stdout } = await execAsync(`osascript "${tmpFile}"`, {
      timeout: 30000
    });

    const result = stdout.trim();

    // Validate the result looks like a token
    if (result && result.length > 50 && !result.includes(' ')) {
      return result;
    }

    console.error('[Browser] Token extraction returned invalid result:', result ? 'invalid format' : 'empty');
    return null;
  } catch (error) {
    if (error.message.includes('not allowed')) {
      throw new Error(
        'Terminal/IDE needs permission to control Chrome. ' +
        'Go to System Preferences > Security & Privacy > Privacy > Accessibility and add your Terminal or IDE.'
      );
    }
    console.error('[Browser] AppleScript error:', error.message);
    throw error;
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if Chrome has a tab with Webex developer portal
 * @returns {Promise<boolean>}
 */
export async function isLoggedIntoWebex() {
  if (process.platform !== 'darwin') {
    return false;
  }

  const appleScript = `
tell application "Google Chrome"
  if running then
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t contains "developer.webex.com" then
          return true
        end if
      end repeat
    end repeat
  end if
  return false
end tell
`;

  const tmpFile = join(tmpdir(), `webex-check-${Date.now()}.scpt`);

  try {
    writeFileSync(tmpFile, appleScript, 'utf8');
    const { stdout } = await execAsync(`osascript "${tmpFile}"`);
    return stdout.trim() === 'true';
  } catch (error) {
    return false;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

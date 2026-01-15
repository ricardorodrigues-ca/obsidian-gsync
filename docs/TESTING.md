# Testing the Obsidian Google Drive Sync Plugin Locally

This guide explains how to set up a local development environment and test the plugin.

## Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- [Obsidian](https://obsidian.md/) installed
- A Google account
- A test vault (recommended: create a new vault for testing)

## Setting Up the Development Environment

### 1. Clone and Build the Plugin

```bash
# Clone the repository
git clone https://github.com/ricardorodrigues-ca/obsidian-gsync.git
cd obsidian-gsync

# Install dependencies
npm install

# Build for development (watch mode - rebuilds on changes)
npm run dev

# Or build once for production
npm run build
```

### 2. Link the Plugin to Your Test Vault

There are two methods to load the plugin into Obsidian:

#### Method A: Symlink (Recommended for Development)

```bash
# Create the plugins directory if it doesn't exist
mkdir -p /path/to/your/test-vault/.obsidian/plugins

# Create a symlink to your development folder
ln -s /path/to/obsidian-gsync /path/to/your/test-vault/.obsidian/plugins/obsidian-gsync
```

**Windows (PowerShell as Administrator):**
```powershell
New-Item -ItemType SymbolicLink -Path "C:\path\to\test-vault\.obsidian\plugins\obsidian-gsync" -Target "C:\path\to\obsidian-gsync"
```

#### Method B: Copy Files

Copy the following files to your vault's `.obsidian/plugins/obsidian-gsync/` folder:
- `main.js`
- `manifest.json`
- `styles.css`

### 3. Enable the Plugin

1. Open Obsidian with your test vault
2. Go to **Settings** > **Community plugins**
3. Turn off **Restricted mode** if enabled
4. Find "Google Drive Sync" in the list
5. Click the toggle to enable it

## Setting Up Google OAuth Credentials

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** > **New Project**
3. Name it (e.g., "Obsidian GSync Test")
4. Click **Create**

### 2. Enable the Google Drive API

1. In your project, go to **APIs & Services** > **Library**
2. Search for "Google Drive API"
3. Click on it and press **Enable**

### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Select **External** (or Internal if using Google Workspace)
3. Fill in the required fields:
   - App name: "Obsidian GSync Test"
   - User support email: Your email
   - Developer contact: Your email
4. Click **Save and Continue**
5. On Scopes page, click **Add or Remove Scopes**
6. Add these scopes:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/drive.appdata`
7. Click **Save and Continue**
8. Add your email as a test user
9. Click **Save and Continue**

### 4. Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Desktop app** as application type
4. Name it (e.g., "Obsidian Desktop Client")
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

### 5. Add Redirect URI

1. Click on your newly created OAuth client
2. Under **Authorized redirect URIs**, click **Add URI**
3. Enter: `http://localhost:42813/callback`
4. Click **Save**

## Testing the Plugin

### Test 1: Authentication

1. Open Obsidian Settings > **Google Drive Sync**
2. Enter your Client ID and Client Secret
3. Click **Connect to Google Drive**
4. A browser window should open for Google sign-in
5. Complete the sign-in process
6. Return to Obsidian - status should show "Connected"

**Expected Result:** Status shows "Connected to Google Drive"

**Troubleshooting:**
- If the browser doesn't open, check the console for errors (Ctrl+Shift+I)
- Ensure port 42813 is not in use by another application
- Verify the redirect URI matches exactly

### Test 2: Initial Sync (Upload)

1. Create some test files in your vault:
   ```
   test-folder/
   ├── note1.md
   ├── note2.md
   └── subfolder/
       └── note3.md
   ```
2. Click the cloud icon in the ribbon or use command "Sync Now"
3. Check the status bar for progress

**Expected Result:**
- Files appear in Google Drive under "ObsidianVault" folder
- Status bar shows progress then "Ready"

**Verify in Google Drive:**
1. Go to [Google Drive](https://drive.google.com/)
2. Look for "ObsidianVault" folder
3. Verify all files and folders are present

### Test 3: Download Changes

1. In Google Drive, edit one of your synced files
2. Or upload a new file to the ObsidianVault folder
3. In Obsidian, trigger a sync
4. Check that changes appear locally

**Expected Result:** Remote changes are downloaded to your vault

### Test 4: Conflict Resolution

1. Edit a file locally in Obsidian
2. Edit the same file in Google Drive (different content)
3. Trigger a sync
4. Based on your conflict resolution setting:
   - **Newer:** The more recent version wins
   - **Local:** Local version is uploaded
   - **Remote:** Remote version is downloaded
   - **Ask:** Both versions are kept (local renamed with `_conflict_` suffix)

### Test 5: Auto Sync

1. Enable "Auto Sync" in settings
2. Set interval to 5 minutes (minimum)
3. Make changes and wait for auto sync
4. Check console logs if Debug Mode is enabled

**Expected Result:** Sync triggers automatically at the set interval

### Test 6: Excluded Folders

1. Ensure `.obsidian` is in excluded folders (default)
2. Create a file in `.obsidian/test.txt`
3. Trigger a sync
4. Verify the file does NOT appear in Google Drive

**Expected Result:** Excluded folders/files are not synced

### Test 7: Status Bar and Ribbon Icon

1. Observe the status bar during sync operations
2. Verify it shows:
   - "GSync: Ready" when idle
   - "GSync: X/Y" during sync with progress
   - "GSync: Error" if something fails
3. Verify ribbon icon animates during sync

## Debugging

### Enable Debug Mode

1. Go to Settings > Google Drive Sync
2. Enable "Debug Mode"
3. Open Developer Console (Ctrl+Shift+I or Cmd+Shift+I)
4. Look for log messages starting with "GSync:" or "Uploaded:"/"Downloaded:"

### Common Issues

| Issue | Solution |
|-------|----------|
| "Not authenticated" | Re-authenticate in settings |
| Port 42813 in use | Kill process using the port or restart Obsidian |
| Sync hangs | Check console for errors, verify network connection |
| Files not syncing | Check excluded folders/extensions settings |
| OAuth error | Verify Client ID/Secret, check redirect URI |

### Checking Network Requests

1. Open Developer Tools (Ctrl+Shift+I)
2. Go to **Network** tab
3. Filter by "googleapis.com"
4. Trigger a sync and observe API calls

## Testing Checklist

- [ ] Plugin loads without errors
- [ ] Settings tab displays correctly
- [ ] OAuth authentication works
- [ ] Initial upload syncs all files
- [ ] Download syncs remote changes
- [ ] Conflict resolution works as expected
- [ ] Auto sync triggers at intervals
- [ ] Excluded folders are respected
- [ ] Status bar updates correctly
- [ ] Ribbon icon shows sync animation
- [ ] Commands work from command palette
- [ ] Disconnect/reconnect works
- [ ] Reset sync state forces full sync

## Development Workflow

```bash
# Terminal 1: Watch for TypeScript changes
npm run dev

# Terminal 2: Watch plugin folder for changes (optional)
# Obsidian will auto-reload on main.js changes if you have Hot Reload plugin

# After making changes:
# 1. Save your TypeScript files
# 2. esbuild rebuilds main.js automatically
# 3. In Obsidian: Ctrl+P > "Reload app without saving" (or restart Obsidian)
```

### Hot Reload Plugin (Optional)

For faster development, install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin:
1. Install from Community Plugins
2. Enable it
3. Now when `main.js` changes, the plugin auto-reloads

## Clean Up

After testing, you may want to:

1. **Remove test data from Google Drive:**
   - Delete the "ObsidianVault" folder

2. **Reset plugin state:**
   - Go to Settings > Google Drive Sync
   - Click "Disconnect"
   - Click "Reset Sync State"

3. **Remove OAuth credentials (optional):**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Delete the test project or revoke the OAuth client

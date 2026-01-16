import { App, PluginSettingTab, Setting, TextComponent, Notice } from 'obsidian';
import type GSyncPlugin from './main';

export class GSyncSettingTab extends PluginSettingTab {
	plugin: GSyncPlugin;
	private authCodeInput: TextComponent | null = null;
	private authFlowStarted: boolean = false;

	constructor(app: App, plugin: GSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Google Drive Sync Settings' });

		// OAuth Credentials Section
		containerEl.createEl('h3', { text: 'Google OAuth Credentials' });
		containerEl.createEl('p', {
			text: 'To use this plugin, you need to create your own Google OAuth credentials.',
			cls: 'setting-item-description',
		});

		const instructionsEl = containerEl.createEl('details');
		instructionsEl.createEl('summary', { text: 'How to get OAuth credentials' });
		const instructionsList = instructionsEl.createEl('ol');
		instructionsList.createEl('li', { text: 'Go to the Google Cloud Console (https://console.cloud.google.com/)' });
		instructionsList.createEl('li', { text: 'Create a new project or select an existing one' });
		instructionsList.createEl('li', { text: 'Enable the Google Drive API for your project' });
		instructionsList.createEl('li', { text: 'Go to "Credentials" and create OAuth 2.0 credentials' });
		instructionsList.createEl('li', { text: 'Set the application type to "Desktop app" or "TV and Limited Input"' });
		instructionsList.createEl('li', { text: 'Copy the Client ID and Client Secret below' });

		let clientIdInput: TextComponent;
		let clientSecretInput: TextComponent;

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('Your Google OAuth Client ID')
			.addText(text => {
				clientIdInput = text;
				text.setPlaceholder('Enter your Client ID')
					.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Client Secret')
			.setDesc('Your Google OAuth Client Secret')
			.addText(text => {
				clientSecretInput = text;
				text.setPlaceholder('Enter your Client Secret')
					.inputEl.type = 'password';
			});

		// Connection Status
		containerEl.createEl('h3', { text: 'Connection Status' });

		const isAuthenticated = this.plugin.authService.isAuthenticated();

		if (isAuthenticated) {
			new Setting(containerEl)
				.setName('Status')
				.setDesc('Connected to Google Drive')
				.addButton(button => button
					.setButtonText('Disconnect')
					.setWarning()
					.onClick(async () => {
						await this.plugin.authService.revokeAccess();
						this.authFlowStarted = false;
						this.display();
					}));
		} else {
			new Setting(containerEl)
				.setName('Status')
				.setDesc('Not connected');

			// Step 1: Start auth flow
			new Setting(containerEl)
				.setName('Step 1: Sign in with Google')
				.setDesc('Opens Google sign-in in your browser. After signing in, you\'ll receive an authorization code.')
				.addButton(button => button
					.setButtonText('Sign in with Google')
					.setCta()
					.onClick(async () => {
						const clientId = clientIdInput.getValue().trim();
						const clientSecret = clientSecretInput.getValue().trim();

						if (!clientId || !clientSecret) {
							new Notice('Please enter both Client ID and Client Secret first');
							return;
						}

						this.plugin.authService.setCredentials({ clientId, clientSecret });
						const authUrl = await this.plugin.authService.startAuthFlow();

						if (authUrl) {
							this.authFlowStarted = true;
							this.display(); // Refresh to show the code input
						}
					}));

			// Step 2: Enter authorization code (only show after auth flow started)
			if (this.authFlowStarted) {
				const codeContainer = containerEl.createDiv({ cls: 'gsync-auth-code-section' });
				codeContainer.createEl('p', {
					text: 'After signing in with Google, copy the authorization code and paste it below:',
					cls: 'setting-item-description',
				});

				new Setting(codeContainer)
					.setName('Step 2: Enter Authorization Code')
					.setDesc('Paste the code from Google here')
					.addText(text => {
						this.authCodeInput = text;
						text.setPlaceholder('Paste authorization code here')
							.inputEl.style.width = '300px';
					})
					.addButton(button => button
						.setButtonText('Submit Code')
						.setCta()
						.onClick(async () => {
							const code = this.authCodeInput?.getValue().trim();
							if (!code) {
								new Notice('Please enter the authorization code');
								return;
							}

							const success = await this.plugin.authService.completeAuthFlow(code);
							if (success) {
								this.authFlowStarted = false;
								this.display(); // Refresh the settings view
							}
						}));
			}
		}

		// Sync Configuration Section
		containerEl.createEl('h3', { text: 'Sync Configuration' });

		new Setting(containerEl)
			.setName('Sync Folder Name')
			.setDesc('Name of the folder in Google Drive where your vault will be synced')
			.addText(text => text
				.setPlaceholder('ObsidianVault')
				.setValue(this.plugin.settings.syncFolderName)
				.onChange(async (value) => {
					this.plugin.settings.syncFolderName = value || 'ObsidianVault';
					// Reset folder ID if name changes
					this.plugin.settings.syncFolderId = '';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto Sync')
			.setDesc('Automatically sync your vault at regular intervals')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					if (value) {
						this.plugin.startAutoSync();
					} else {
						this.plugin.stopAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Auto Sync Interval')
			.setDesc('How often to sync (in minutes)')
			.addSlider(slider => slider
				.setLimits(5, 120, 5)
				.setValue(this.plugin.settings.autoSyncInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.autoSyncInterval = value;
					await this.plugin.saveSettings();
					if (this.plugin.settings.autoSync) {
						this.plugin.stopAutoSync();
						this.plugin.startAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Sync on Startup')
			.setDesc('Automatically sync when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		// Conflict Resolution Section
		containerEl.createEl('h3', { text: 'Conflict Resolution' });

		new Setting(containerEl)
			.setName('Conflict Resolution Strategy')
			.setDesc('How to handle conflicts when both local and remote files have changed')
			.addDropdown(dropdown => dropdown
				.addOption('newer', 'Keep newer version')
				.addOption('local', 'Always keep local version')
				.addOption('remote', 'Always keep remote version')
				.addOption('ask', 'Keep both (rename local)')
				.setValue(this.plugin.settings.conflictResolution)
				.onChange(async (value: 'local' | 'remote' | 'newer' | 'ask') => {
					this.plugin.settings.conflictResolution = value;
					await this.plugin.saveSettings();
				}));

		// File Filters Section
		containerEl.createEl('h3', { text: 'File Filters' });

		new Setting(containerEl)
			.setName('Excluded Folders')
			.setDesc('Folders to exclude from sync (comma-separated)')
			.addTextArea(text => text
				.setPlaceholder('.obsidian, .git, .trash')
				.setValue(this.plugin.settings.excludedFolders.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.excludedFolders = value
						.split(',')
						.map(s => s.trim())
						.filter(s => s.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Excluded Extensions')
			.setDesc('File extensions to exclude from sync (comma-separated, include the dot)')
			.addTextArea(text => text
				.setPlaceholder('.tmp, .bak')
				.setValue(this.plugin.settings.excludedExtensions.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.excludedExtensions = value
						.split(',')
						.map(s => s.trim())
						.filter(s => s.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include Hidden Files')
			.setDesc('Include files and folders starting with a dot (except .obsidian)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeHiddenFiles)
				.onChange(async (value) => {
					this.plugin.settings.includeHiddenFiles = value;
					await this.plugin.saveSettings();
				}));

		// Manual Sync Section
		containerEl.createEl('h3', { text: 'Manual Sync' });

		new Setting(containerEl)
			.setName('Sync Now')
			.setDesc('Manually trigger a sync')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					if (!this.plugin.authService.isAuthenticated()) {
						new Notice('Please connect to Google Drive first');
						return;
					}
					await this.plugin.syncService.sync();
				}));

		// Last Sync Info
		if (this.plugin.settings.lastSyncTime > 0) {
			const lastSync = new Date(this.plugin.settings.lastSyncTime);
			new Setting(containerEl)
				.setName('Last Sync')
				.setDesc(lastSync.toLocaleString());
		}

		// Advanced Section
		containerEl.createEl('h3', { text: 'Advanced' });

		new Setting(containerEl)
			.setName('Debug Mode')
			.setDesc('Enable debug logging in the console')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Reset Sync State')
			.setDesc('Clear the last sync time to force a full sync on next run')
			.addButton(button => button
				.setButtonText('Reset')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.lastSyncTime = 0;
					this.plugin.settings.syncFolderId = '';
					await this.plugin.saveSettings();
					new Notice('Sync state reset. Next sync will be a full sync.');
					this.display();
				}));
	}
}

import { Notice, TFile, TFolder, Vault } from 'obsidian';
import type GSyncPlugin from './main';
import { FileMetadata, SyncStatus, ConflictInfo } from './settings';

export type SyncAction = 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict' | 'skip';

export interface SyncPlan {
	uploads: FileMetadata[];
	downloads: FileMetadata[];
	deleteLocal: FileMetadata[];
	deleteRemote: FileMetadata[];
	conflicts: ConflictInfo[];
}

export class SyncService {
	private plugin: GSyncPlugin;
	private isSyncing: boolean = false;
	private syncStatusCallback?: (status: SyncStatus) => void;

	constructor(plugin: GSyncPlugin) {
		this.plugin = plugin;
	}

	onSyncStatusChange(callback: (status: SyncStatus) => void) {
		this.syncStatusCallback = callback;
	}

	private updateStatus(status: SyncStatus) {
		if (this.syncStatusCallback) {
			this.syncStatusCallback(status);
		}
	}

	async sync(): Promise<void> {
		if (this.isSyncing) {
			new Notice('Sync already in progress');
			return;
		}

		if (!this.plugin.authService.isAuthenticated()) {
			new Notice('Please authenticate with Google Drive first');
			return;
		}

		this.isSyncing = true;
		this.updateStatus({ status: 'syncing', message: 'Starting sync...' });

		try {
			// Ensure sync folder exists
			if (!this.plugin.settings.syncFolderId) {
				this.updateStatus({ status: 'syncing', message: 'Creating sync folder...' });
				const folderId = await this.plugin.driveService.getOrCreateSyncFolder(
					this.plugin.settings.syncFolderName
				);
				this.plugin.settings.syncFolderId = folderId;
				await this.plugin.saveSettings();
			}

			// Build file indices
			this.updateStatus({ status: 'syncing', message: 'Scanning local files...' });
			const localIndex = await this.buildLocalFileIndex();

			this.updateStatus({ status: 'syncing', message: 'Scanning remote files...' });
			const remoteIndex = await this.plugin.driveService.buildRemoteFileIndex(
				this.plugin.settings.syncFolderId
			);

			// Create sync plan
			this.updateStatus({ status: 'syncing', message: 'Planning sync...' });
			const plan = this.createSyncPlan(localIndex, remoteIndex);

			// Execute sync plan
			await this.executeSyncPlan(plan, localIndex, remoteIndex);

			// Update last sync time
			this.plugin.settings.lastSyncTime = Date.now();
			await this.plugin.saveSettings();

			this.updateStatus({ status: 'idle', message: 'Sync completed' });
			new Notice('Sync completed successfully');
		} catch (error) {
			console.error('Sync error:', error);
			this.updateStatus({ status: 'error', message: `Sync failed: ${error}` });
			new Notice(`Sync failed: ${error}`);
		} finally {
			this.isSyncing = false;
		}
	}

	private async buildLocalFileIndex(): Promise<Map<string, FileMetadata>> {
		const index = new Map<string, FileMetadata>();
		const vault = this.plugin.app.vault;

		const processFile = async (file: TFile) => {
			if (this.shouldExclude(file.path)) {
				return;
			}

			const stat = await vault.adapter.stat(file.path);
			if (stat) {
				index.set(file.path, {
					path: file.path,
					name: file.name,
					mtime: stat.mtime,
					size: stat.size,
					isFolder: false,
				});
			}
		};

		const processFolder = (folder: TFolder) => {
			if (this.shouldExclude(folder.path)) {
				return;
			}

			if (folder.path !== '/') {
				index.set(folder.path, {
					path: folder.path,
					name: folder.name,
					mtime: 0,
					size: 0,
					isFolder: true,
				});
			}
		};

		// Process all files and folders
		const allFiles = vault.getFiles();
		for (const file of allFiles) {
			await processFile(file);
		}

		// Get all folders
		const root = vault.getRoot();
		const processAllFolders = (folder: TFolder) => {
			processFolder(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					processAllFolders(child);
				}
			}
		};
		processAllFolders(root);

		return index;
	}

	private shouldExclude(path: string): boolean {
		// Check excluded folders
		for (const folder of this.plugin.settings.excludedFolders) {
			if (path.startsWith(folder) || path.startsWith('/' + folder)) {
				return true;
			}
		}

		// Check excluded extensions
		for (const ext of this.plugin.settings.excludedExtensions) {
			if (path.endsWith(ext)) {
				return true;
			}
		}

		// Check hidden files
		if (!this.plugin.settings.includeHiddenFiles) {
			const parts = path.split('/');
			for (const part of parts) {
				if (part.startsWith('.') && part !== '.') {
					return true;
				}
			}
		}

		return false;
	}

	private createSyncPlan(
		localIndex: Map<string, FileMetadata>,
		remoteIndex: Map<string, FileMetadata>
	): SyncPlan {
		const plan: SyncPlan = {
			uploads: [],
			downloads: [],
			deleteLocal: [],
			deleteRemote: [],
			conflicts: [],
		};

		const lastSyncTime = this.plugin.settings.lastSyncTime;

		// Process local files
		for (const [path, localFile] of localIndex) {
			const remoteFile = remoteIndex.get(path);

			if (!remoteFile) {
				// File exists locally but not remotely
				if (lastSyncTime === 0 || localFile.mtime > lastSyncTime) {
					// New local file or modified since last sync
					plan.uploads.push(localFile);
				} else {
					// File was deleted remotely
					plan.deleteLocal.push(localFile);
				}
			} else if (!localFile.isFolder && !remoteFile.isFolder) {
				// Both exist, check for conflicts
				const localNewer = localFile.mtime > (remoteFile.driveMtime || 0);
				const remoteNewer = (remoteFile.driveMtime || 0) > localFile.mtime;

				if (localNewer && remoteNewer) {
					// Conflict - both modified
					plan.conflicts.push({ localFile, remoteFile, path });
				} else if (localNewer && localFile.mtime > lastSyncTime) {
					// Local is newer and modified since last sync
					plan.uploads.push({ ...localFile, driveId: remoteFile.driveId });
				} else if (remoteNewer && (remoteFile.driveMtime || 0) > lastSyncTime) {
					// Remote is newer and modified since last sync
					plan.downloads.push(remoteFile);
				}
			}
		}

		// Process remote files not in local index
		for (const [path, remoteFile] of remoteIndex) {
			if (!localIndex.has(path)) {
				if (lastSyncTime === 0 || (remoteFile.driveMtime || 0) > lastSyncTime) {
					// New remote file
					plan.downloads.push(remoteFile);
				} else {
					// File was deleted locally
					plan.deleteRemote.push(remoteFile);
				}
			}
		}

		return plan;
	}

	private async executeSyncPlan(
		plan: SyncPlan,
		localIndex: Map<string, FileMetadata>,
		remoteIndex: Map<string, FileMetadata>
	): Promise<void> {
		const total = plan.uploads.length + plan.downloads.length +
			plan.deleteLocal.length + plan.deleteRemote.length +
			plan.conflicts.length;
		let progress = 0;

		// Handle conflicts first based on settings
		for (const conflict of plan.conflicts) {
			progress++;
			this.updateStatus({
				status: 'syncing',
				message: `Resolving conflict: ${conflict.path}`,
				progress,
				total,
			});

			await this.resolveConflict(conflict);
		}

		// Upload files
		for (const file of plan.uploads) {
			if (file.isFolder) continue;
			progress++;
			this.updateStatus({
				status: 'syncing',
				message: `Uploading: ${file.path}`,
				progress,
				total,
			});

			await this.uploadFile(file);
		}

		// Download files
		for (const file of plan.downloads) {
			if (file.isFolder) continue;
			progress++;
			this.updateStatus({
				status: 'syncing',
				message: `Downloading: ${file.path}`,
				progress,
				total,
			});

			await this.downloadFile(file);
		}

		// Delete local files
		for (const file of plan.deleteLocal) {
			progress++;
			this.updateStatus({
				status: 'syncing',
				message: `Deleting local: ${file.path}`,
				progress,
				total,
			});

			await this.deleteLocalFile(file);
		}

		// Delete remote files
		for (const file of plan.deleteRemote) {
			progress++;
			this.updateStatus({
				status: 'syncing',
				message: `Deleting remote: ${file.path}`,
				progress,
				total,
			});

			await this.deleteRemoteFile(file);
		}
	}

	private async resolveConflict(conflict: ConflictInfo): Promise<void> {
		const resolution = this.plugin.settings.conflictResolution;

		switch (resolution) {
			case 'local':
				await this.uploadFile(conflict.localFile);
				break;
			case 'remote':
				await this.downloadFile(conflict.remoteFile);
				break;
			case 'newer':
				if (conflict.localFile.mtime > (conflict.remoteFile.driveMtime || 0)) {
					await this.uploadFile(conflict.localFile);
				} else {
					await this.downloadFile(conflict.remoteFile);
				}
				break;
			case 'ask':
				// For now, keep both by renaming local
				const parts = conflict.path.split('.');
				const ext = parts.length > 1 ? '.' + parts.pop() : '';
				const base = parts.join('.');
				const newPath = `${base}_conflict_${Date.now()}${ext}`;

				const content = await this.plugin.app.vault.adapter.read(conflict.path);
				await this.plugin.app.vault.create(newPath, content);
				await this.downloadFile(conflict.remoteFile);
				break;
		}
	}

	private async uploadFile(file: FileMetadata): Promise<void> {
		try {
			const content = await this.plugin.app.vault.adapter.readBinary(file.path);
			const mimeType = this.getMimeType(file.path);

			// Ensure parent folder exists
			const parentPath = file.path.substring(0, file.path.lastIndexOf('/'));
			let parentId = this.plugin.settings.syncFolderId;

			if (parentPath) {
				parentId = await this.plugin.driveService.ensureFolderPath(
					parentPath,
					this.plugin.settings.syncFolderId
				);
			}

			await this.plugin.driveService.uploadFile(
				file.name,
				content,
				mimeType,
				parentId,
				file.driveId
			);

			if (this.plugin.settings.debugMode) {
				console.log(`Uploaded: ${file.path}`);
			}
		} catch (error) {
			console.error(`Failed to upload ${file.path}:`, error);
			throw error;
		}
	}

	private async downloadFile(file: FileMetadata): Promise<void> {
		if (!file.driveId) {
			console.error(`No drive ID for file: ${file.path}`);
			return;
		}

		try {
			const content = await this.plugin.driveService.downloadFile(file.driveId);

			// Ensure parent folder exists locally
			const parentPath = file.path.substring(0, file.path.lastIndexOf('/'));
			if (parentPath) {
				const exists = await this.plugin.app.vault.adapter.exists(parentPath);
				if (!exists) {
					await this.plugin.app.vault.createFolder(parentPath);
				}
			}

			// Write the file
			await this.plugin.app.vault.adapter.writeBinary(file.path, content);

			if (this.plugin.settings.debugMode) {
				console.log(`Downloaded: ${file.path}`);
			}
		} catch (error) {
			console.error(`Failed to download ${file.path}:`, error);
			throw error;
		}
	}

	private async deleteLocalFile(file: FileMetadata): Promise<void> {
		try {
			if (file.isFolder) {
				// Check if folder is empty
				const exists = await this.plugin.app.vault.adapter.exists(file.path);
				if (exists) {
					const list = await this.plugin.app.vault.adapter.list(file.path);
					if (list.files.length === 0 && list.folders.length === 0) {
						await this.plugin.app.vault.adapter.rmdir(file.path, false);
					}
				}
			} else {
				const exists = await this.plugin.app.vault.adapter.exists(file.path);
				if (exists) {
					const abstractFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
					if (abstractFile instanceof TFile) {
						await this.plugin.app.vault.trash(abstractFile, true);
					}
				}
			}

			if (this.plugin.settings.debugMode) {
				console.log(`Deleted local: ${file.path}`);
			}
		} catch (error) {
			console.error(`Failed to delete local ${file.path}:`, error);
		}
	}

	private async deleteRemoteFile(file: FileMetadata): Promise<void> {
		if (!file.driveId) return;

		try {
			await this.plugin.driveService.moveToTrash(file.driveId);

			if (this.plugin.settings.debugMode) {
				console.log(`Deleted remote: ${file.path}`);
			}
		} catch (error) {
			console.error(`Failed to delete remote ${file.path}:`, error);
		}
	}

	private getMimeType(path: string): string {
		const ext = path.split('.').pop()?.toLowerCase();
		const mimeTypes: Record<string, string> = {
			'md': 'text/markdown',
			'txt': 'text/plain',
			'json': 'application/json',
			'css': 'text/css',
			'js': 'application/javascript',
			'png': 'image/png',
			'jpg': 'image/jpeg',
			'jpeg': 'image/jpeg',
			'gif': 'image/gif',
			'svg': 'image/svg+xml',
			'pdf': 'application/pdf',
			'mp3': 'audio/mpeg',
			'mp4': 'video/mp4',
			'webp': 'image/webp',
			'canvas': 'application/json',
		};

		return mimeTypes[ext || ''] || 'application/octet-stream';
	}

	isSyncInProgress(): boolean {
		return this.isSyncing;
	}
}

import { requestUrl, RequestUrlResponse } from 'obsidian';
import type GSyncPlugin from './main';
import { FileMetadata } from './settings';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	size?: string;
	md5Checksum?: string;
	parents?: string[];
	trashed?: boolean;
}

export interface DriveFileList {
	files: DriveFile[];
	nextPageToken?: string;
}

export class GoogleDriveService {
	private plugin: GSyncPlugin;

	constructor(plugin: GSyncPlugin) {
		this.plugin = plugin;
	}

	private async getAccessToken(): Promise<string> {
		const token = await this.plugin.authService.getValidAccessToken();
		if (!token) {
			throw new Error('Not authenticated with Google Drive');
		}
		return token;
	}

	private async makeRequest(
		url: string,
		method: string = 'GET',
		body?: any,
		headers?: Record<string, string>,
		contentType?: string
	): Promise<RequestUrlResponse> {
		const token = await this.getAccessToken();

		const requestHeaders: Record<string, string> = {
			'Authorization': `Bearer ${token}`,
			...headers,
		};

		if (contentType) {
			requestHeaders['Content-Type'] = contentType;
		}

		const response = await requestUrl({
			url,
			method,
			headers: requestHeaders,
			body: body,
			throw: false,
		});

		if (response.status >= 400) {
			console.error('Drive API error:', response.status, response.text);
			throw new Error(`Drive API error: ${response.status}`);
		}

		return response;
	}

	async createFolder(name: string, parentId?: string): Promise<DriveFile> {
		const metadata: any = {
			name: name,
			mimeType: 'application/vnd.google-apps.folder',
		};

		if (parentId) {
			metadata.parents = [parentId];
		}

		const response = await this.makeRequest(
			`${DRIVE_API_BASE}/files`,
			'POST',
			JSON.stringify(metadata),
			{},
			'application/json'
		);

		return response.json;
	}

	async getOrCreateSyncFolder(folderName: string): Promise<string> {
		// First, try to find an existing folder
		const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
		const response = await this.makeRequest(
			`${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`
		);

		const files = response.json.files;
		if (files && files.length > 0) {
			return files[0].id;
		}

		// Create a new folder
		const folder = await this.createFolder(folderName);
		return folder.id;
	}

	async listFiles(folderId: string, pageToken?: string): Promise<DriveFileList> {
		const query = `'${folderId}' in parents and trashed=false`;
		let url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum,parents)&pageSize=1000`;

		if (pageToken) {
			url += `&pageToken=${pageToken}`;
		}

		const response = await this.makeRequest(url);
		return response.json;
	}

	async listAllFiles(folderId: string): Promise<DriveFile[]> {
		const allFiles: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const result = await this.listFiles(folderId, pageToken);
			allFiles.push(...result.files);
			pageToken = result.nextPageToken;
		} while (pageToken);

		return allFiles;
	}

	async getFileMetadata(fileId: string): Promise<DriveFile> {
		const response = await this.makeRequest(
			`${DRIVE_API_BASE}/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,md5Checksum,parents`
		);
		return response.json;
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const response = await this.makeRequest(
			`${DRIVE_API_BASE}/files/${fileId}?alt=media`
		);
		return response.arrayBuffer;
	}

	async uploadFile(
		name: string,
		content: ArrayBuffer,
		mimeType: string,
		parentId: string,
		existingFileId?: string
	): Promise<DriveFile> {
		const metadata: any = {
			name: name,
		};

		if (!existingFileId) {
			metadata.parents = [parentId];
		}

		const boundary = '-------gsync_boundary';
		const delimiter = `\r\n--${boundary}\r\n`;
		const closeDelimiter = `\r\n--${boundary}--`;

		// Create multipart body
		const metadataStr = JSON.stringify(metadata);
		const encoder = new TextEncoder();
		const metadataBytes = encoder.encode(
			delimiter +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			metadataStr +
			delimiter +
			`Content-Type: ${mimeType}\r\n` +
			'Content-Transfer-Encoding: base64\r\n\r\n'
		);

		const closeBytes = encoder.encode(closeDelimiter);

		// Convert content to base64
		const base64Content = this.arrayBufferToBase64(content);
		const contentBytes = encoder.encode(base64Content);

		// Combine all parts
		const body = new Uint8Array(metadataBytes.length + contentBytes.length + closeBytes.length);
		body.set(metadataBytes, 0);
		body.set(contentBytes, metadataBytes.length);
		body.set(closeBytes, metadataBytes.length + contentBytes.length);

		const url = existingFileId
			? `${DRIVE_UPLOAD_BASE}/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum`
			: `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum`;

		const method = existingFileId ? 'PATCH' : 'POST';

		const response = await this.makeRequest(
			url,
			method,
			body.buffer,
			{},
			`multipart/related; boundary=${boundary}`
		);

		return response.json;
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.makeRequest(
			`${DRIVE_API_BASE}/files/${fileId}`,
			'DELETE'
		);
	}

	async moveToTrash(fileId: string): Promise<void> {
		await this.makeRequest(
			`${DRIVE_API_BASE}/files/${fileId}`,
			'PATCH',
			JSON.stringify({ trashed: true }),
			{},
			'application/json'
		);
	}

	private arrayBufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]!);
		}
		return btoa(binary);
	}

	async buildRemoteFileIndex(folderId: string, basePath: string = ''): Promise<Map<string, FileMetadata>> {
		const index = new Map<string, FileMetadata>();
		const files = await this.listAllFiles(folderId);

		for (const file of files) {
			const path = basePath ? `${basePath}/${file.name}` : file.name;
			const isFolder = file.mimeType === 'application/vnd.google-apps.folder';

			index.set(path, {
				path: path,
				name: file.name,
				mtime: new Date(file.modifiedTime).getTime(),
				size: parseInt(file.size || '0'),
				isFolder: isFolder,
				driveId: file.id,
				driveMtime: new Date(file.modifiedTime).getTime(),
				md5Checksum: file.md5Checksum,
			});

			// Recursively process subfolders
			if (isFolder) {
				const subIndex = await this.buildRemoteFileIndex(file.id, path);
				subIndex.forEach((value, key) => index.set(key, value));
			}
		}

		return index;
	}

	async ensureFolderPath(folderPath: string, rootFolderId: string): Promise<string> {
		const parts = folderPath.split('/').filter(p => p);
		let currentParentId = rootFolderId;

		for (const part of parts) {
			const query = `name='${part}' and '${currentParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
			const response = await this.makeRequest(
				`${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`
			);

			const files = response.json.files;
			if (files && files.length > 0) {
				currentParentId = files[0].id;
			} else {
				const folder = await this.createFolder(part, currentParentId);
				currentParentId = folder.id;
			}
		}

		return currentParentId;
	}

	async getFileIdByPath(filePath: string, rootFolderId: string): Promise<string | null> {
		const parts = filePath.split('/').filter(p => p);
		let currentParentId = rootFolderId;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			const isLast = i === parts.length - 1;
			const mimeTypeCondition = isLast ? '' : ` and mimeType='application/vnd.google-apps.folder'`;

			const query = `name='${part}' and '${currentParentId}' in parents${mimeTypeCondition} and trashed=false`;
			const response = await this.makeRequest(
				`${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`
			);

			const files = response.json.files;
			if (!files || files.length === 0) {
				return null;
			}
			currentParentId = files[0].id;
		}

		return currentParentId;
	}
}

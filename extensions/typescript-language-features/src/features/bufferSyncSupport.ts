/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { CancellationTokenSource, Disposable, TextDocument, TextDocumentChangeEvent, TextDocumentContentChangeEvent, Uri, workspace } from 'vscode';
import * as Proto from '../protocol';
import { ITypeScriptServiceClient } from '../typescriptService';
import { Delayer } from '../utils/async';
import { disposeAll } from '../utils/dispose';
import * as languageModeIds from '../utils/languageModeIds';


interface IDiagnosticRequestor {
	requestDiagnostic(resource: Uri): void;
}

function mode2ScriptKind(mode: string): 'TS' | 'TSX' | 'JS' | 'JSX' | undefined {
	switch (mode) {
		case languageModeIds.typescript: return 'TS';
		case languageModeIds.typescriptreact: return 'TSX';
		case languageModeIds.javascript: return 'JS';
		case languageModeIds.javascriptreact: return 'JSX';
	}
	return undefined;
}

class SyncedBuffer {

	constructor(
		private readonly document: TextDocument,
		private readonly filepath: string,
		private readonly diagnosticRequestor: IDiagnosticRequestor,
		private readonly client: ITypeScriptServiceClient
	) { }

	public open(): void {
		const args: Proto.OpenRequestArgs = {
			file: this.filepath,
			fileContent: this.document.getText(),
		};

		if (this.client.apiVersion.has203Features()) {
			const scriptKind = mode2ScriptKind(this.document.languageId);
			if (scriptKind) {
				args.scriptKindName = scriptKind;
			}
		}

		if (this.client.apiVersion.has230Features()) {
			args.projectRootPath = this.client.getWorkspaceRootForResource(this.document.uri);
		}

		if (this.client.apiVersion.has240Features()) {
			const tsPluginsForDocument = this.client.plugins
				.filter(x => x.languages.indexOf(this.document.languageId) >= 0);

			if (tsPluginsForDocument.length) {
				(args as any).plugins = tsPluginsForDocument.map(plugin => plugin.name);
			}
		}

		this.client.execute('open', args, false);
	}

	public get lineCount(): number {
		return this.document.lineCount;
	}

	public close(): void {
		const args: Proto.FileRequestArgs = {
			file: this.filepath
		};
		this.client.execute('close', args, false);
	}

	public onContentChanged(events: TextDocumentContentChangeEvent[]): void {
		const filePath = this.client.normalizePath(this.document.uri);
		if (!filePath) {
			return;
		}

		for (const { range, text } of events) {
			const args: Proto.ChangeRequestArgs = {
				file: filePath,
				line: range.start.line + 1,
				offset: range.start.character + 1,
				endLine: range.end.line + 1,
				endOffset: range.end.character + 1,
				insertString: text
			};
			this.client.execute('change', args, false);
		}
		this.diagnosticRequestor.requestDiagnostic(this.document.uri);
	}
}

class SyncedBufferMap {
	private readonly _map = new Map<string, SyncedBuffer>();

	constructor(
		private readonly _normalizePath: (resource: Uri) => string | null
	) { }

	public has(resource: Uri): boolean {
		const file = this._normalizePath(resource);
		return !!file && this._map.has(file);
	}

	public get(resource: Uri): SyncedBuffer | undefined {
		const file = this._normalizePath(resource);
		return file ? this._map.get(file) : undefined;
	}

	public set(resource: Uri, buffer: SyncedBuffer) {
		const file = this._normalizePath(resource);
		if (file) {
			this._map.set(file, buffer);
		}
	}

	public delete(resource: Uri): void {
		const file = this._normalizePath(resource);
		if (file) {
			this._map.delete(file);
		}
	}

	public get allBuffers(): Iterable<SyncedBuffer> {
		return this._map.values();
	}

	public get allResources(): Iterable<string> {
		return this._map.keys();
	}
}


export interface Diagnostics {
	delete(resource: Uri): void;
}

export default class BufferSyncSupport {

	private readonly client: ITypeScriptServiceClient;

	private _validate: boolean;
	private readonly modeIds: Set<string>;
	private readonly diagnostics: Diagnostics;
	private readonly disposables: Disposable[] = [];
	private readonly syncedBuffers: SyncedBufferMap;

	private readonly pendingDiagnostics = new Map<string, number>();
	private readonly diagnosticDelayer: Delayer<any>;
	private pendingGetErr: { request: Promise<any>, files: string[], token: CancellationTokenSource } | undefined;

	constructor(
		client: ITypeScriptServiceClient,
		modeIds: string[],
		diagnostics: Diagnostics,
		validate: boolean
	) {
		this.client = client;
		this.modeIds = new Set<string>(modeIds);
		this.diagnostics = diagnostics;
		this._validate = validate;

		this.diagnosticDelayer = new Delayer<any>(300);

		this.syncedBuffers = new SyncedBufferMap(path => this.client.normalizePath(path));
	}

	public listen(): void {
		workspace.onDidOpenTextDocument(this.openTextDocument, this, this.disposables);
		workspace.onDidCloseTextDocument(this.onDidCloseTextDocument, this, this.disposables);
		workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this, this.disposables);
		workspace.textDocuments.forEach(this.openTextDocument, this);
	}

	public set validate(value: boolean) {
		this._validate = value;
	}

	public handles(resource: Uri): boolean {
		return this.syncedBuffers.has(resource);
	}

	public reOpenDocuments(): void {
		for (const buffer of this.syncedBuffers.allBuffers) {
			buffer.open();
		}
	}

	public dispose(): void {
		disposeAll(this.disposables);
	}

	public openTextDocument(document: TextDocument): void {
		if (!this.modeIds.has(document.languageId)) {
			return;
		}
		const resource = document.uri;
		const filepath = this.client.normalizePath(resource);
		if (!filepath) {
			return;
		}

		if (this.syncedBuffers.has(resource)) {
			return;
		}

		const syncedBuffer = new SyncedBuffer(document, filepath, this, this.client);
		this.syncedBuffers.set(resource, syncedBuffer);
		syncedBuffer.open();
		this.requestDiagnostic(resource);
	}

	public closeResource(resource: Uri): void {
		const syncedBuffer = this.syncedBuffers.get(resource);
		if (!syncedBuffer) {
			return;
		}
		this.syncedBuffers.delete(resource);
		syncedBuffer.close();
		if (!fs.existsSync(resource.fsPath)) {
			this.diagnostics.delete(resource);
			this.requestAllDiagnostics();
		}
	}

	private onDidCloseTextDocument(document: TextDocument): void {
		this.closeResource(document.uri);
	}

	private onDidChangeTextDocument(e: TextDocumentChangeEvent): void {
		const syncedBuffer = this.syncedBuffers.get(e.document.uri);
		if (syncedBuffer) {
			syncedBuffer.onContentChanged(e.contentChanges);
			if (this.pendingGetErr) {
				this.pendingGetErr.token.cancel();
				this.pendingGetErr = undefined;
			}
		}
	}

	public requestAllDiagnostics() {
		if (!this._validate) {
			return;
		}
		for (const filePath of this.syncedBuffers.allResources) {
			this.pendingDiagnostics.set(filePath, Date.now());
		}
		this.diagnosticDelayer.trigger(() => {
			this.sendPendingDiagnostics();
		}, 200);
	}

	public getErr(resources: Uri[]): any {
		const handledResources = resources.filter(resource => this.handles(resource));
		if (!handledResources.length) {
			return;
		}

		for (const resource of handledResources) {
			const file = this.client.normalizePath(resource);
			if (file) {
				this.pendingDiagnostics.set(file, Date.now());
			}
		}

		this.diagnosticDelayer.trigger(() => {
			this.sendPendingDiagnostics();
		}, 200);
	}

	public requestDiagnostic(resource: Uri): void {
		if (!this._validate) {
			return;
		}

		const file = this.client.normalizePath(resource);
		if (!file) {
			return;
		}

		this.pendingDiagnostics.set(file, Date.now());
		const buffer = this.syncedBuffers.get(resource);
		let delay = 300;
		if (buffer) {
			const lineCount = buffer.lineCount;
			delay = Math.min(Math.max(Math.ceil(lineCount / 20), 300), 800);
		}
		this.diagnosticDelayer.trigger(() => {
			this.sendPendingDiagnostics();
		}, delay);
	}

	public hasPendingDiagnostics(resource: Uri): boolean {
		const file = this.client.normalizePath(resource);
		return !file || this.pendingDiagnostics.has(file);
	}

	private sendPendingDiagnostics(): void {
		if (!this._validate) {
			return;
		}
		const files = new Set(Array.from(this.pendingDiagnostics.entries())
			.sort((a, b) => a[1] - b[1])
			.map(entry => entry[0]));

		// Add all open TS buffers to the geterr request. They might be visible
		for (const file of this.syncedBuffers.allResources) {
			if (!this.pendingDiagnostics.get(file)) {
				files.add(file);
			}
		}

		if (this.pendingGetErr) {
			for (const file of this.pendingGetErr.files) {
				files.add(file);
			}
		}

		if (files.size) {
			const fileList = Array.from(files);
			const args: Proto.GeterrRequestArgs = {
				delay: 0,
				files: fileList
			};
			const token = new CancellationTokenSource();

			const getErr = this.pendingGetErr = {
				request: this.client.executeAsync('geterr', args, token.token)
					.then(undefined, () => { })
					.then(() => {
						if (this.pendingGetErr === getErr) {
							this.pendingGetErr = undefined;
						}
					}),
				files: fileList,
				token
			};
		}
		this.pendingDiagnostics.clear();
	}
}
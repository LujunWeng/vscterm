/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { IInstantiationService, createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IEditorService, ACTIVE_GROUP_TYPE, SIDE_GROUP_TYPE } from 'vs/workbench/services/editor/common/editorService';
import { IEditorGroupsService, IEditorGroup } from 'vs/workbench/services/group/common/editorGroupsService';
import * as vscode from 'vscode';
import { WebviewEditorInput } from './webviewEditorInput';
import { GroupIdentifier } from 'vs/workbench/common/editor';

export const IWebviewEditorService = createDecorator<IWebviewEditorService>('webviewEditorService');

export interface ICreateWebViewShowOptions {
	group: IEditorGroup | GroupIdentifier | ACTIVE_GROUP_TYPE | SIDE_GROUP_TYPE;
	preserveFocus: boolean;
}

export interface IWebviewEditorService {
	_serviceBrand: any;

	createWebview(
		viewType: string,
		title: string,
		showOptions: ICreateWebViewShowOptions,
		options: WebviewInputOptions,
		extensionLocation: URI,
		events: WebviewEvents
	): WebviewEditorInput;

	reviveWebview(
		viewType: string,
		title: string,
		state: any,
		options: WebviewInputOptions,
		extensionLocation: URI
	): WebviewEditorInput;

	revealWebview(
		webview: WebviewEditorInput,
		group: IEditorGroup,
		preserveFocus: boolean
	): void;

	registerReviver(
		viewType: string,
		reviver: WebviewReviver
	): IDisposable;

	canRevive(
		input: WebviewEditorInput
	): boolean;
}

export interface WebviewReviver {
	canRevive(
		webview: WebviewEditorInput
	): boolean;

	reviveWebview(
		webview: WebviewEditorInput
	): TPromise<void>;
}

export interface WebviewEvents {
	onMessage?(message: any): void;
	onDispose?(): void;
	onDidClickLink?(link: URI, options: vscode.WebviewOptions): void;
}

export interface WebviewInputOptions extends vscode.WebviewOptions, vscode.WebviewPanelOptions {
	tryRestoreScrollPosition?: boolean;
}

export class WebviewEditorService implements IWebviewEditorService {
	_serviceBrand: any;

	private readonly _revivers = new Map<string, WebviewReviver[]>();
	private _awaitingRevival: { input: WebviewEditorInput, resolve: (x: any) => void }[] = [];

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
	) { }

	createWebview(
		viewType: string,
		title: string,
		showOptions: ICreateWebViewShowOptions,
		options: vscode.WebviewOptions,
		extensionLocation: URI,
		events: WebviewEvents
	): WebviewEditorInput {
		const webviewInput = this._instantiationService.createInstance(WebviewEditorInput, viewType, title, options, {}, events, extensionLocation, undefined);
		this._editorService.openEditor(webviewInput, { pinned: true, preserveFocus: showOptions.preserveFocus }, showOptions.group);
		return webviewInput;
	}

	revealWebview(
		webview: WebviewEditorInput,
		group: IEditorGroup,
		preserveFocus: boolean
	): void {
		if (webview.group === group.id) {
			this._editorService.openEditor(webview, { preserveFocus }, webview.group);
		} else {
			this._editorGroupService.getGroup(webview.group).moveEditor(webview, group, { preserveFocus });
		}
	}

	reviveWebview(
		viewType: string,
		title: string,
		state: any,
		options: WebviewInputOptions,
		extensionLocation: URI
	): WebviewEditorInput {
		const webviewInput = this._instantiationService.createInstance(WebviewEditorInput, viewType, title, options, state, {}, extensionLocation, {
			canRevive: (_webview) => {
				return true;
			},
			reviveWebview: async (webview: WebviewEditorInput): TPromise<void> => {
				const didRevive = await this.tryRevive(webview);
				if (didRevive) {
					return;
				}
				// A reviver may not be registered yet. Put into queue and resolve promise when we can revive
				let resolve: (value: void) => void;
				const promise = new TPromise<void>(r => { resolve = r; });
				this._awaitingRevival.push({ input: webview, resolve });
				return promise;
			}
		});

		return webviewInput;
	}

	registerReviver(
		viewType: string,
		reviver: WebviewReviver
	): IDisposable {
		if (this._revivers.has(viewType)) {
			this._revivers.get(viewType).push(reviver);
		} else {
			this._revivers.set(viewType, [reviver]);
		}


		// Resolve any pending views
		const toRevive = this._awaitingRevival.filter(x => x.input.viewType === viewType);
		this._awaitingRevival = this._awaitingRevival.filter(x => x.input.viewType !== viewType);

		for (const input of toRevive) {
			reviver.reviveWebview(input.input).then(() => input.resolve(void 0));
		}

		return toDisposable(() => {
			this._revivers.delete(viewType);
		});
	}

	canRevive(
		webview: WebviewEditorInput
	): boolean {
		const viewType = webview.viewType;
		return this._revivers.has(viewType) && this._revivers.get(viewType).some(reviver => reviver.canRevive(webview));
	}

	private async tryRevive(
		webview: WebviewEditorInput
	): TPromise<boolean> {
		const revivers = this._revivers.get(webview.viewType);
		if (!revivers) {
			return false;
		}

		for (const reviver of revivers) {
			if (reviver.canRevive(webview)) {
				await reviver.reviveWebview(webview);
				return true;
			}
		}
		return false;
	}
}
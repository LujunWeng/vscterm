/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import * as map from 'vs/base/common/map';
import URI, { UriComponents } from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { localize } from 'vs/nls';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { EditorViewColumn, viewColumnToEditorGroup, editorGroupToViewColumn } from 'vs/workbench/api/shared/editor';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ExtHostContext, ExtHostWebviewsShape, IExtHostContext, MainContext, MainThreadWebviewsShape, WebviewPanelHandle } from 'vs/workbench/api/node/extHost.protocol';
import { WebviewEditor } from 'vs/workbench/parts/webview/electron-browser/webviewEditor';
import { WebviewEditorInput } from 'vs/workbench/parts/webview/electron-browser/webviewEditorInput';
import { IWebviewEditorService, WebviewInputOptions, WebviewReviver, ICreateWebViewShowOptions } from 'vs/workbench/parts/webview/electron-browser/webviewEditorService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IEditorGroupsService } from 'vs/workbench/services/group/common/editorGroupsService';
import { extHostNamedCustomer } from './extHostCustomers';

@extHostNamedCustomer(MainContext.MainThreadWebviews)
export class MainThreadWebviews implements MainThreadWebviewsShape, WebviewReviver {

	private static readonly viewType = 'mainThreadWebview';

	private static readonly standardSupportedLinkSchemes = ['http', 'https', 'mailto'];

	private static revivalPool = 0;

	private _toDispose: IDisposable[] = [];

	private readonly _proxy: ExtHostWebviewsShape;
	private readonly _webviews = new Map<WebviewPanelHandle, WebviewEditorInput>();
	private readonly _revivers = new Set<string>();

	private _activeWebview: WebviewPanelHandle | undefined = undefined;

	constructor(
		context: IExtHostContext,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewEditorService private readonly _webviewService: IWebviewEditorService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IExtensionService private readonly _extensionService: IExtensionService,

	) {
		this._proxy = context.getProxy(ExtHostContext.ExtHostWebviews);
		_editorService.onDidActiveEditorChange(this.onActiveEditorChanged, this, this._toDispose);
		_editorService.onDidVisibleEditorsChange(this.onVisibleEditorsChanged, this, this._toDispose);

		this._toDispose.push(_webviewService.registerReviver(MainThreadWebviews.viewType, this));

		lifecycleService.onWillShutdown(e => {
			e.veto(this._onWillShutdown());
		}, this, this._toDispose);
	}

	dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	$createWebviewPanel(
		handle: WebviewPanelHandle,
		viewType: string,
		title: string,
		showOptions: { viewColumn: EditorViewColumn | null, preserveFocus: boolean },
		options: WebviewInputOptions,
		extensionLocation: UriComponents
	): void {
		const mainThreadShowOptions: ICreateWebViewShowOptions = Object.create(null);
		if (showOptions) {
			mainThreadShowOptions.preserveFocus = showOptions.preserveFocus;
			mainThreadShowOptions.group = viewColumnToEditorGroup(this._editorGroupService, showOptions.viewColumn);
		}

		const webview = this._webviewService.createWebview(MainThreadWebviews.viewType, title, mainThreadShowOptions, options, URI.revive(extensionLocation), this.createWebviewEventDelegate(handle));
		webview.state = {
			viewType: viewType,
			state: undefined
		};

		this._webviews.set(handle, webview);
		this._activeWebview = handle;
	}

	$disposeWebview(handle: WebviewPanelHandle): void {
		const webview = this.getWebview(handle);
		webview.dispose();
	}

	$setTitle(handle: WebviewPanelHandle, value: string): void {
		const webview = this.getWebview(handle);
		webview.setName(value);
	}

	$setHtml(handle: WebviewPanelHandle, value: string): void {
		const webview = this.getWebview(handle);
		webview.html = value;
	}

	$reveal(handle: WebviewPanelHandle, viewColumn: EditorViewColumn | null, preserveFocus: boolean): void {
		const webview = this.getWebview(handle);
		if (webview.isDisposed()) {
			return;
		}

		const targetGroup = this._editorGroupService.getGroup(viewColumnToEditorGroup(this._editorGroupService, viewColumn));

		this._webviewService.revealWebview(webview, targetGroup || this._editorGroupService.activeGroup, preserveFocus);
	}

	async $postMessage(handle: WebviewPanelHandle, message: any): TPromise<boolean> {
		const webview = this.getWebview(handle);
		const editors = this._editorService.visibleControls
			.filter(e => e instanceof WebviewEditor)
			.map(e => e as WebviewEditor)
			.filter(e => e.input.matches(webview));

		for (const editor of editors) {
			editor.sendMessage(message);
		}

		return (editors.length > 0);
	}

	$registerSerializer(viewType: string): void {
		this._revivers.add(viewType);
	}

	$unregisterSerializer(viewType: string): void {
		this._revivers.delete(viewType);
	}

	reviveWebview(webview: WebviewEditorInput): TPromise<void> {
		const viewType = webview.state.viewType;
		return this._extensionService.activateByEvent(`onWebviewPanel:${viewType}`).then(() => {
			const handle = 'revival-' + MainThreadWebviews.revivalPool++;
			this._webviews.set(handle, webview);
			webview._events = this.createWebviewEventDelegate(handle);

			let state = undefined;
			if (webview.state.state) {
				try {
					state = JSON.parse(webview.state.state);
				} catch {
					// noop
				}
			}

			return this._proxy.$deserializeWebviewPanel(handle, webview.state.viewType, webview.getTitle(), state, editorGroupToViewColumn(this._editorGroupService, webview.group), webview.options)
				.then(undefined, () => {
					webview.html = MainThreadWebviews.getDeserializationFailedContents(viewType);
				});
		});
	}

	canRevive(webview: WebviewEditorInput): boolean {
		if (webview.isDisposed() || !webview.state) {
			return false;
		}

		return this._revivers.has(webview.state.viewType) || !!webview.reviver;
	}

	private _onWillShutdown(): TPromise<boolean> {
		this._webviews.forEach((view) => {
			if (this.canRevive(view)) {
				view.state.state = view.webviewState;
			}
		});

		return TPromise.as(false); // Don't veto shutdown

	}

	private createWebviewEventDelegate(handle: WebviewPanelHandle) {
		return {
			onDidClickLink: uri => this.onDidClickLink(handle, uri),
			onMessage: message => this._proxy.$onMessage(handle, message),
			onDispose: () => {
				this._proxy.$onDidDisposeWebviewPanel(handle).then(
					() => this._webviews.delete(handle),
					() => this._webviews.delete(handle));
			}
		};
	}

	private getWebview(handle: WebviewPanelHandle): WebviewEditorInput {
		const webview = this._webviews.get(handle);
		if (!webview) {
			throw new Error('Unknown webview handle:' + handle);
		}
		return webview;
	}

	private onActiveEditorChanged() {
		const activeEditor = this._editorService.activeControl;
		let newActiveWebview: { input: WebviewEditorInput, handle: WebviewPanelHandle } | undefined = undefined;
		if (activeEditor && activeEditor.input instanceof WebviewEditorInput) {
			for (const handle of map.keys(this._webviews)) {
				const input = this._webviews.get(handle);
				if (input.matches(activeEditor.input)) {
					newActiveWebview = { input, handle };
					break;
				}
			}
		}

		if (newActiveWebview && newActiveWebview.handle === this._activeWebview) {
			// Webview itself unchanged but position may have changed
			this._proxy.$onDidChangeWebviewPanelViewState(newActiveWebview.handle, true, editorGroupToViewColumn(this._editorGroupService, newActiveWebview.input.group));
			return;
		}

		// Broadcast view state update for currently active
		if (typeof this._activeWebview !== 'undefined') {
			const oldActiveWebview = this._webviews.get(this._activeWebview);
			if (oldActiveWebview) {
				this._proxy.$onDidChangeWebviewPanelViewState(this._activeWebview, false, editorGroupToViewColumn(this._editorGroupService, oldActiveWebview.group));
			}
		}

		// Then for newly active
		if (newActiveWebview) {
			this._proxy.$onDidChangeWebviewPanelViewState(newActiveWebview.handle, true, editorGroupToViewColumn(this._editorGroupService, activeEditor.group));
			this._activeWebview = newActiveWebview.handle;
		} else {
			this._activeWebview = undefined;
		}
	}

	private onVisibleEditorsChanged(): void {
		for (const workbenchEditor of this._editorService.visibleControls) {
			if (!workbenchEditor.input) {
				return;
			}

			this._webviews.forEach((input, handle) => {
				const inputPosition = editorGroupToViewColumn(this._editorGroupService, input.group);
				const editorPosition = editorGroupToViewColumn(this._editorGroupService, workbenchEditor.group);

				if (workbenchEditor.input.matches(input) && inputPosition !== editorPosition) {
					input.updateGroup(workbenchEditor.group.id);
					this._proxy.$onDidChangeWebviewPanelViewState(handle, handle === this._activeWebview, editorPosition);
				}
			});
		}
	}
	private onDidClickLink(handle: WebviewPanelHandle, link: URI): void {
		if (!link) {
			return;
		}

		const webview = this.getWebview(handle);
		const enableCommandUris = webview.options.enableCommandUris;
		if (MainThreadWebviews.standardSupportedLinkSchemes.indexOf(link.scheme) >= 0 || enableCommandUris && link.scheme === 'command') {
			this._openerService.open(link);
		}
	}

	private static getDeserializationFailedContents(viewType: string) {
		return `<!DOCTYPE html>
		<html>
			<head>
				<base href="https://code.visualstudio.com/raw/">
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; script-src 'none'; style-src vscode-core-resource: https: 'unsafe-inline'; child-src 'none'; frame-src 'none';">
			</head>
			<body>${localize('errorMessage', "An error occurred while restoring view:{0}", viewType)}</body>
		</html>`;
	}
}

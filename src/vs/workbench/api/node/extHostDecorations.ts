/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import URI from 'vs/base/common/uri';
import { MainContext, IMainContext, ExtHostDecorationsShape, MainThreadDecorationsShape, DecorationData, DecorationRequest, DecorationReply } from 'vs/workbench/api/node/extHost.protocol';
import { TPromise } from 'vs/base/common/winjs.base';
import { Disposable } from 'vs/workbench/api/node/extHostTypes';
import { asWinJsPromise } from 'vs/base/common/async';

export class ExtHostDecorations implements ExtHostDecorationsShape {

	private static _handlePool = 0;

	private readonly _provider = new Map<number, vscode.DecorationProvider>();
	private readonly _proxy: MainThreadDecorationsShape;

	constructor(mainContext: IMainContext) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadDecorations);
	}

	registerDecorationProvider(provider: vscode.DecorationProvider, label: string): vscode.Disposable {
		const handle = ExtHostDecorations._handlePool++;
		this._provider.set(handle, provider);
		this._proxy.$registerDecorationProvider(handle, label);

		const listener = provider.onDidChangeDecorations(e => {
			this._proxy.$onDidChange(handle, !e ? null : Array.isArray(e) ? e : [e]);
		});

		return new Disposable(() => {
			listener.dispose();
			this._proxy.$unregisterDecorationProvider(handle);
			this._provider.delete(handle);
		});
	}

	$provideDecorations(requests: DecorationRequest[]): TPromise<DecorationReply> {
		const result: DecorationReply = Object.create(null);
		return TPromise.join(requests.map(request => {
			const { handle, uri, id } = request;
			const provider = this._provider.get(handle);
			if (!provider) {
				// might have been unregistered in the meantime
				return void 0;
			}
			return asWinJsPromise(token => provider.provideDecoration(URI.revive(uri), token)).then(data => {
				result[id] = data && <DecorationData>[data.priority, data.bubble, data.title, data.abbreviation, data.color, data.source];
			}, err => {
				console.error(err);
			});

		})).then(() => {
			return result;
		});
	}
}

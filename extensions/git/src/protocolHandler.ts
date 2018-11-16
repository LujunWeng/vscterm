/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { ProtocolHandler, Uri, window, Disposable, commands } from 'vscode';
import { dispose } from './util';
import * as querystring from 'querystring';

export class GitProtocolHandler implements ProtocolHandler {

	private disposables: Disposable[] = [];

	constructor() {
		this.disposables.push(window.registerProtocolHandler(this));
	}

	handleUri(uri: Uri): void {
		switch (uri.path) {
			case '/clone': this.clone(uri);
		}
	}

	private clone(uri: Uri): void {
		const data = querystring.parse(uri.query);

		if (!data.url) {
			console.warn('Failed to open URI:', uri);
		}

		commands.executeCommand('git.clone', data.url);
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}
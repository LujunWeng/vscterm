/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Viewlet } from '../workbench/viewlet';
import { Code } from '../../vscode/code';

const SEARCH_BOX = 'div.extensions-viewlet[id="workbench.view.extensions"] input.search-box';

export class Extensions extends Viewlet {

	constructor(code: Code) {
		super(code);
	}

	async openExtensionsViewlet(): Promise<any> {
		if (process.platform === 'darwin') {
			await this.code.dispatchKeybinding('cmd+shift+x');
		} else {
			await this.code.dispatchKeybinding('ctrl+shift+x');
		}

		await this.code.waitForActiveElement(SEARCH_BOX);
	}

	async searchForExtension(name: string): Promise<any> {
		await this.code.waitAndClick(SEARCH_BOX);
		await this.code.waitForActiveElement(SEARCH_BOX);
		await this.code.waitForSetValue(SEARCH_BOX, `name:"${name}"`);
	}

	async installExtension(name: string): Promise<void> {
		await this.searchForExtension(name);
		await this.code.waitAndClick(`div.extensions-viewlet[id="workbench.view.extensions"] .monaco-list-row[aria-label="${name}"] .extension li[class='action-item'] .extension-action.install`);
		await this.code.waitForElement(`div.extensions-viewlet[id="workbench.view.extensions"] .monaco-list-row[aria-label="${name}"] .extension li[class='action-item'] .extension-action.reload`);
	}
}
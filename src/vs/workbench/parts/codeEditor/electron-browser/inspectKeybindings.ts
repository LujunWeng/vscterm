/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import { registerEditorAction, ServicesAccessor, EditorAction } from 'vs/editor/browser/editorExtensions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { WorkbenchKeybindingService } from 'vs/workbench/services/keybinding/electron-browser/keybindingService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IUntitledResourceInput } from 'vs/workbench/common/editor';

class InspectKeyMap extends EditorAction {

	constructor() {
		super({
			id: 'workbench.action.inspectKeyMappings',
			label: nls.localize('workbench.action.inspectKeyMap', "Developer: Inspect Key Mappings"),
			alias: 'Developer: Inspect Key Mappings',
			precondition: null
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const keybindingService = accessor.get(IKeybindingService);
		const editorService = accessor.get(IEditorService);

		if (keybindingService instanceof WorkbenchKeybindingService) {
			editorService.openEditor({ contents: keybindingService.dumpDebugInfo(), options: { pinned: true } } as IUntitledResourceInput);
		}
	}
}

registerEditorAction(InspectKeyMap);

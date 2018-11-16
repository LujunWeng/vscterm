/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IEditorOptions, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { localize } from 'vs/nls';
import { disposed } from 'vs/base/common/errors';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { equals as objectEquals } from 'vs/base/common/objects';
import URI, { UriComponents } from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IRange } from 'vs/editor/common/core/range';
import { ISelection } from 'vs/editor/common/core/selection';
import { IDecorationOptions, IDecorationRenderOptions, ILineChange } from 'vs/editor/common/editorCommon';
import { ISingleEditOperation } from 'vs/editor/common/model';
import { EditorViewColumn, viewColumnToEditorGroup, editorGroupToViewColumn } from 'vs/workbench/api/shared/editor';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IApplyEditsOptions, ITextEditorConfigurationUpdate, IUndoStopOptions, TextEditorRevealType, WorkspaceEditDto, reviveWorkspaceEditDto } from 'vs/workbench/api/node/extHost.protocol';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditorGroupsService } from 'vs/workbench/services/group/common/editorGroupsService';
import { ExtHostContext, ExtHostEditorsShape, IExtHostContext, ITextDocumentShowOptions, ITextEditorPositionData, MainThreadTextEditorsShape } from '../node/extHost.protocol';
import { MainThreadDocumentsAndEditors } from './mainThreadDocumentsAndEditors';
import { MainThreadTextEditor } from './mainThreadEditor';

export class MainThreadTextEditors implements MainThreadTextEditorsShape {

	private _proxy: ExtHostEditorsShape;
	private _documentsAndEditors: MainThreadDocumentsAndEditors;
	private _toDispose: IDisposable[];
	private _textEditorsListenersMap: { [editorId: string]: IDisposable[]; };
	private _editorPositionData: ITextEditorPositionData;
	private _registeredDecorationTypes: { [decorationType: string]: boolean; };

	constructor(
		documentsAndEditors: MainThreadDocumentsAndEditors,
		extHostContext: IExtHostContext,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostEditors);
		this._documentsAndEditors = documentsAndEditors;
		this._toDispose = [];
		this._textEditorsListenersMap = Object.create(null);
		this._editorPositionData = null;

		this._toDispose.push(documentsAndEditors.onTextEditorAdd(editors => editors.forEach(this._onTextEditorAdd, this)));
		this._toDispose.push(documentsAndEditors.onTextEditorRemove(editors => editors.forEach(this._onTextEditorRemove, this)));

		this._toDispose.push(this._editorService.onDidVisibleEditorsChange(() => this._updateActiveAndVisibleTextEditors()));
		this._toDispose.push(this._editorGroupService.onDidRemoveGroup(() => this._updateActiveAndVisibleTextEditors()));

		this._registeredDecorationTypes = Object.create(null);
	}

	public dispose(): void {
		Object.keys(this._textEditorsListenersMap).forEach((editorId) => {
			dispose(this._textEditorsListenersMap[editorId]);
		});
		this._textEditorsListenersMap = Object.create(null);
		this._toDispose = dispose(this._toDispose);
		for (let decorationType in this._registeredDecorationTypes) {
			this._codeEditorService.removeDecorationType(decorationType);
		}
		this._registeredDecorationTypes = Object.create(null);
	}

	private _onTextEditorAdd(textEditor: MainThreadTextEditor): void {
		let id = textEditor.getId();
		let toDispose: IDisposable[] = [];
		toDispose.push(textEditor.onPropertiesChanged((data) => {
			this._proxy.$acceptEditorPropertiesChanged(id, data);
		}));

		this._textEditorsListenersMap[id] = toDispose;
	}

	private _onTextEditorRemove(id: string): void {
		dispose(this._textEditorsListenersMap[id]);
		delete this._textEditorsListenersMap[id];
	}

	private _updateActiveAndVisibleTextEditors(): void {

		// editor columns
		let editorPositionData = this._getTextEditorPositionData();
		if (!objectEquals(this._editorPositionData, editorPositionData)) {
			this._editorPositionData = editorPositionData;
			this._proxy.$acceptEditorPositionData(this._editorPositionData);
		}
	}

	private _getTextEditorPositionData(): ITextEditorPositionData {
		let result: ITextEditorPositionData = Object.create(null);
		for (let workbenchEditor of this._editorService.visibleControls) {
			const id = this._documentsAndEditors.findTextEditorIdFor(workbenchEditor);
			if (id) {
				result[id] = editorGroupToViewColumn(this._editorGroupService, workbenchEditor.group);
			}
		}
		return result;
	}

	// --- from extension host process

	$tryShowTextDocument(resource: UriComponents, options: ITextDocumentShowOptions): TPromise<string> {
		const uri = URI.revive(resource);

		const editorOptions: ITextEditorOptions = {
			preserveFocus: options.preserveFocus,
			pinned: options.pinned,
			selection: options.selection
		};

		const input = {
			resource: uri,
			options: editorOptions
		};

		return this._editorService.openEditor(input, viewColumnToEditorGroup(this._editorGroupService, options.position)).then(editor => {
			if (!editor) {
				return undefined;
			}
			return this._documentsAndEditors.findTextEditorIdFor(editor);
		});
	}

	$tryShowEditor(id: string, position?: EditorViewColumn): TPromise<void> {
		let mainThreadEditor = this._documentsAndEditors.getEditor(id);
		if (mainThreadEditor) {
			let model = mainThreadEditor.getModel();
			return this._editorService.openEditor({
				resource: model.uri,
				options: { preserveFocus: false }
			}, viewColumnToEditorGroup(this._editorGroupService, position)).then(() => { return; });
		}
		return undefined;
	}

	$tryHideEditor(id: string): TPromise<void> {
		let mainThreadEditor = this._documentsAndEditors.getEditor(id);
		if (mainThreadEditor) {
			let editors = this._editorService.visibleControls;
			for (let editor of editors) {
				if (mainThreadEditor.matches(editor)) {
					return editor.group.closeEditor(editor.input).then(() => { return; });
				}
			}
		}
		return undefined;
	}

	$trySetSelections(id: string, selections: ISelection[]): TPromise<void> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setSelections(selections);
		return TPromise.as(null);
	}

	$trySetDecorations(id: string, key: string, ranges: IDecorationOptions[]): TPromise<void> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setDecorations(key, ranges);
		return TPromise.as(null);
	}

	$trySetDecorationsFast(id: string, key: string, ranges: number[]): TPromise<void> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setDecorationsFast(key, ranges);
		return TPromise.as(null);
	}

	$tryRevealRange(id: string, range: IRange, revealType: TextEditorRevealType): TPromise<void> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).revealRange(range, revealType);
		return undefined;
	}

	$trySetOptions(id: string, options: ITextEditorConfigurationUpdate): TPromise<void> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError(disposed(`TextEditor(${id})`));
		}
		this._documentsAndEditors.getEditor(id).setConfiguration(options);
		return TPromise.as(null);
	}

	$tryApplyEdits(id: string, modelVersionId: number, edits: ISingleEditOperation[], opts: IApplyEditsOptions): TPromise<boolean> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError<boolean>(disposed(`TextEditor(${id})`));
		}
		return TPromise.as(this._documentsAndEditors.getEditor(id).applyEdits(modelVersionId, edits, opts));
	}

	$tryApplyWorkspaceEdit(dto: WorkspaceEditDto): TPromise<boolean> {
		const { edits } = reviveWorkspaceEditDto(dto);
		return this._bulkEditService.apply({ edits }, undefined).then(() => true, err => false);
	}

	$tryInsertSnippet(id: string, template: string, ranges: IRange[], opts: IUndoStopOptions): TPromise<boolean> {
		if (!this._documentsAndEditors.getEditor(id)) {
			return TPromise.wrapError<boolean>(disposed(`TextEditor(${id})`));
		}
		return TPromise.as(this._documentsAndEditors.getEditor(id).insertSnippet(template, ranges, opts));
	}

	$registerTextEditorDecorationType(key: string, options: IDecorationRenderOptions): void {
		this._registeredDecorationTypes[key] = true;
		this._codeEditorService.registerDecorationType(key, options);
	}

	$removeTextEditorDecorationType(key: string): void {
		delete this._registeredDecorationTypes[key];
		this._codeEditorService.removeDecorationType(key);
	}

	$getDiffInformation(id: string): TPromise<ILineChange[]> {
		const editor = this._documentsAndEditors.getEditor(id);

		if (!editor) {
			return TPromise.wrapError<ILineChange[]>(new Error('No such TextEditor'));
		}

		const codeEditor = editor.getCodeEditor();
		const codeEditorId = codeEditor.getId();
		const diffEditors = this._codeEditorService.listDiffEditors();
		const [diffEditor] = diffEditors.filter(d => d.getOriginalEditor().getId() === codeEditorId || d.getModifiedEditor().getId() === codeEditorId);

		if (!diffEditor) {
			return TPromise.as([]);
		}

		return TPromise.as(diffEditor.getLineChanges());
	}
}

// --- commands

CommandsRegistry.registerCommand('_workbench.open', function (accessor: ServicesAccessor, args: [URI, IEditorOptions, EditorViewColumn]) {
	const editorService = accessor.get(IEditorService);
	const editorGroupService = accessor.get(IEditorGroupsService);

	const [resource, options, position] = args;

	return editorService.openEditor({ resource, options }, viewColumnToEditorGroup(editorGroupService, position)).then(() => void 0);
});

CommandsRegistry.registerCommand('_workbench.diff', function (accessor: ServicesAccessor, args: [URI, URI, string, string, IEditorOptions, EditorViewColumn]) {
	const editorService = accessor.get(IEditorService);
	const editorGroupService = accessor.get(IEditorGroupsService);

	let [leftResource, rightResource, label, description, options, position] = args;

	if (!options || typeof options !== 'object') {
		options = {
			preserveFocus: false
		};
	}

	if (!label) {
		label = localize('diffLeftRightLabel', "{0} ⟷ {1}", leftResource.toString(true), rightResource.toString(true));
	}

	return editorService.openEditor({ leftResource, rightResource, label, description, options }, viewColumnToEditorGroup(editorGroupService, position)).then(() => void 0);
});
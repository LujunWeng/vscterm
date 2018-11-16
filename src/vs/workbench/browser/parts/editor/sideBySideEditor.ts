/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TPromise } from 'vs/base/common/winjs.base';
import * as DOM from 'vs/base/browser/dom';
import { Registry } from 'vs/platform/registry/common/platform';
import { EditorInput, EditorOptions, SideBySideEditorInput, IEditorControl, IEditor } from 'vs/workbench/common/editor';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { VSash } from 'vs/base/browser/ui/sash/sash';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { scrollbarShadow } from 'vs/platform/theme/common/colorRegistry';
import { IEditorRegistry, Extensions as EditorExtensions } from 'vs/workbench/browser/editor';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IEditorGroup } from 'vs/workbench/services/group/common/editorGroupsService';

export class SideBySideEditor extends BaseEditor {

	public static readonly ID: string = 'workbench.editor.sidebysideEditor';

	private dimension: DOM.Dimension;

	protected masterEditor: BaseEditor;
	private masterEditorContainer: HTMLElement;

	protected detailsEditor: BaseEditor;
	private detailsEditorContainer: HTMLElement;

	private sash: VSash;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService
	) {
		super(SideBySideEditor.ID, telemetryService, themeService);
	}

	protected createEditor(parent: HTMLElement): void {
		DOM.addClass(parent, 'side-by-side-editor');
		this.createSash(parent);
	}

	public setInput(newInput: SideBySideEditorInput, options: EditorOptions, token: CancellationToken): Thenable<void> {
		const oldInput = <SideBySideEditorInput>this.input;
		return super.setInput(newInput, options, token)
			.then(() => this.updateInput(oldInput, newInput, options, token));
	}

	public setOptions(options: EditorOptions): void {
		if (this.masterEditor) {
			this.masterEditor.setOptions(options);
		}
	}

	protected setEditorVisible(visible: boolean, group: IEditorGroup): void {
		if (this.masterEditor) {
			this.masterEditor.setVisible(visible, group);
		}
		if (this.detailsEditor) {
			this.detailsEditor.setVisible(visible, group);
		}
		super.setEditorVisible(visible, group);
	}

	public clearInput(): void {
		if (this.masterEditor) {
			this.masterEditor.clearInput();
		}
		if (this.detailsEditor) {
			this.detailsEditor.clearInput();
		}
		this.disposeEditors();
		super.clearInput();
	}

	public focus(): void {
		if (this.masterEditor) {
			this.masterEditor.focus();
		}
	}

	public layout(dimension: DOM.Dimension): void {
		this.dimension = dimension;
		this.sash.setDimenesion(this.dimension);
	}

	public getControl(): IEditorControl {
		if (this.masterEditor) {
			return this.masterEditor.getControl();
		}
		return null;
	}

	public getMasterEditor(): IEditor {
		return this.masterEditor;
	}

	public getDetailsEditor(): IEditor {
		return this.detailsEditor;
	}

	public supportsCenteredLayout(): boolean {
		return false;
	}

	private updateInput(oldInput: SideBySideEditorInput, newInput: SideBySideEditorInput, options: EditorOptions, token: CancellationToken): void {
		if (!newInput.matches(oldInput)) {
			if (oldInput) {
				this.disposeEditors();
			}
			this.createEditorContainers();

			return this.setNewInput(newInput, options, token);
		} else {
			this.detailsEditor.setInput(newInput.details, null, token);
			this.masterEditor.setInput(newInput.master, options, token);

			return void 0;
		}
	}

	private setNewInput(newInput: SideBySideEditorInput, options: EditorOptions, token: CancellationToken): void {
		const detailsEditor = this._createEditor(<EditorInput>newInput.details, this.detailsEditorContainer);
		const masterEditor = this._createEditor(<EditorInput>newInput.master, this.masterEditorContainer);

		this.onEditorsCreated(detailsEditor, masterEditor, newInput.details, newInput.master, options, token);
	}

	private _createEditor(editorInput: EditorInput, container: HTMLElement): BaseEditor {
		const descriptor = Registry.as<IEditorRegistry>(EditorExtensions.Editors).getEditor(editorInput);

		const editor = descriptor.instantiate(this.instantiationService);
		editor.create(container);
		editor.setVisible(this.isVisible(), this.group);

		return editor;
	}

	private onEditorsCreated(details: BaseEditor, master: BaseEditor, detailsInput: EditorInput, masterInput: EditorInput, options: EditorOptions, token: CancellationToken): TPromise<void> {
		this.detailsEditor = details;
		this.masterEditor = master;
		this.dolayout(this.sash.getVerticalSashLeft());
		return TPromise.join([this.detailsEditor.setInput(detailsInput, null, token), this.masterEditor.setInput(masterInput, options, token)]).then(() => this.focus());
	}

	private createEditorContainers(): void {
		const parentElement = this.getContainer();
		this.detailsEditorContainer = DOM.append(parentElement, DOM.$('.details-editor-container'));
		this.detailsEditorContainer.style.position = 'absolute';
		this.masterEditorContainer = DOM.append(parentElement, DOM.$('.master-editor-container'));
		this.masterEditorContainer.style.position = 'absolute';

		this.updateStyles();
	}

	public updateStyles(): void {
		super.updateStyles();

		if (this.masterEditorContainer) {
			this.masterEditorContainer.style.boxShadow = `-6px 0 5px -5px ${this.getColor(scrollbarShadow)}`;
		}
	}

	private createSash(parentElement: HTMLElement): void {
		this.sash = this._register(new VSash(parentElement, 220));
		this._register(this.sash.onPositionChange(position => this.dolayout(position)));
	}

	private dolayout(splitPoint: number): void {
		if (!this.detailsEditor || !this.masterEditor || !this.dimension) {
			return;
		}
		const masterEditorWidth = this.dimension.width - splitPoint;
		const detailsEditorWidth = this.dimension.width - masterEditorWidth;

		this.detailsEditorContainer.style.width = `${detailsEditorWidth}px`;
		this.detailsEditorContainer.style.height = `${this.dimension.height}px`;
		this.detailsEditorContainer.style.left = '0px';

		this.masterEditorContainer.style.width = `${masterEditorWidth}px`;
		this.masterEditorContainer.style.height = `${this.dimension.height}px`;
		this.masterEditorContainer.style.left = `${splitPoint}px`;

		this.detailsEditor.layout(new DOM.Dimension(detailsEditorWidth, this.dimension.height));
		this.masterEditor.layout(new DOM.Dimension(masterEditorWidth, this.dimension.height));
	}

	private disposeEditors(): void {
		const parentContainer = this.getContainer();
		if (this.detailsEditor) {
			this.detailsEditor.dispose();
			this.detailsEditor = null;
		}
		if (this.masterEditor) {
			this.masterEditor.dispose();
			this.masterEditor = null;
		}
		if (this.detailsEditorContainer) {
			parentContainer.removeChild(this.detailsEditorContainer);
			this.detailsEditorContainer = null;
		}
		if (this.masterEditorContainer) {
			parentContainer.removeChild(this.masterEditorContainer);
			this.masterEditorContainer = null;
		}
	}

	public dispose(): void {
		this.disposeEditors();
		super.dispose();
	}
}

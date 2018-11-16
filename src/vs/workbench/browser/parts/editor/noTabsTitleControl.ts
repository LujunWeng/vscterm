/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/notabstitlecontrol';
import { toResource, Verbosity, IEditorInput } from 'vs/workbench/common/editor';
import { TitleControl } from 'vs/workbench/browser/parts/editor/titleControl';
import { ResourceLabel } from 'vs/workbench/browser/labels';
import { TAB_ACTIVE_FOREGROUND, TAB_UNFOCUSED_ACTIVE_FOREGROUND } from 'vs/workbench/common/theme';
import { EventType as TouchEventType, GestureEvent, Gesture } from 'vs/base/browser/touch';
import { addDisposableListener, EventType, addClass, EventHelper, removeClass } from 'vs/base/browser/dom';
import { IEditorPartOptions } from 'vs/workbench/browser/parts/editor/editor';

export class NoTabsTitleControl extends TitleControl {
	private titleContainer: HTMLElement;
	private editorLabel: ResourceLabel;
	private lastRenderedActiveEditor: IEditorInput;

	protected create(parent: HTMLElement): void {
		this.titleContainer = parent;
		this.titleContainer.draggable = true;

		//Container listeners
		this.registerContainerListeners();

		// Gesture Support
		Gesture.addTarget(this.titleContainer);

		// Editor Label
		this.editorLabel = this._register(this.instantiationService.createInstance(ResourceLabel, this.titleContainer, void 0));
		this._register(this.editorLabel.onClick(e => this.onTitleLabelClick(e)));

		// Right Actions Container
		const actionsContainer = document.createElement('div');
		addClass(actionsContainer, 'title-actions');
		this.titleContainer.appendChild(actionsContainer);

		// Editor actions toolbar
		this.createEditorActionsToolBar(actionsContainer);
	}

	private registerContainerListeners(): void {

		// Group dragging
		this.enableGroupDragging(this.titleContainer);

		// Pin on double click
		this._register(addDisposableListener(this.titleContainer, EventType.DBLCLICK, (e: MouseEvent) => this.onTitleDoubleClick(e)));

		// Detect mouse click
		this._register(addDisposableListener(this.titleContainer, EventType.CLICK, (e: MouseEvent) => this.onTitleClick(e)));

		// Detect touch
		this._register(addDisposableListener(this.titleContainer, TouchEventType.Tap, (e: GestureEvent) => this.onTitleClick(e)));

		// Context Menu
		this._register(addDisposableListener(this.titleContainer, EventType.CONTEXT_MENU, (e: Event) => this.onContextMenu(this.group.activeEditor, e, this.titleContainer)));
		this._register(addDisposableListener(this.titleContainer, TouchEventType.Contextmenu, (e: Event) => this.onContextMenu(this.group.activeEditor, e, this.titleContainer)));
	}

	private onTitleLabelClick(e: MouseEvent): void {
		EventHelper.stop(e, false);

		// delayed to let the onTitleClick() come first which can cause a focus change which can close quick open
		setTimeout(() => this.quickOpenService.show());
	}

	private onTitleDoubleClick(e: MouseEvent): void {
		EventHelper.stop(e);

		this.group.pinEditor();
	}

	private onTitleClick(e: MouseEvent | GestureEvent): void {

		// Close editor on middle mouse click
		if (e instanceof MouseEvent && e.button === 1 /* Middle Button */) {
			this.group.closeEditor(this.group.activeEditor);
		}
	}

	openEditor(editor: IEditorInput): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	closeEditor(editor: IEditorInput): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	closeEditors(editors: IEditorInput[]): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	closeAllEditors(): void {
		this.redraw();
	}

	moveEditor(editor: IEditorInput, fromIndex: number, targetIndex: number): void {
		this.ifActiveEditorChanged(() => this.redraw());
	}

	pinEditor(editor: IEditorInput): void {
		this.ifEditorIsActive(editor, () => this.redraw());
	}

	setActive(isActive: boolean): void {
		this.redraw();
	}

	updateEditorLabel(editor: IEditorInput): void {
		this.ifEditorIsActive(editor, () => this.redraw());
	}

	updateEditorDirty(editor: IEditorInput): void {
		this.ifEditorIsActive(editor, () => {
			if (editor.isDirty()) {
				addClass(this.titleContainer, 'dirty');
			} else {
				removeClass(this.titleContainer, 'dirty');
			}
		});
	}

	updateOptions(oldOptions: IEditorPartOptions, newOptions: IEditorPartOptions): void {
		if (oldOptions.labelFormat !== newOptions.labelFormat) {
			this.redraw();
		}
	}

	updateStyles(): void {
		this.redraw();
	}

	private ifActiveEditorChanged(fn: () => void): void {
		if (
			!this.lastRenderedActiveEditor && this.group.activeEditor || 	// active editor changed from null => editor
			this.lastRenderedActiveEditor && !this.group.activeEditor || 	// active editor changed from editor => null
			!this.group.isActive(this.lastRenderedActiveEditor)				// active editor changed from editorA => editorB
		) {
			fn();
		}
	}

	private ifEditorIsActive(editor: IEditorInput, fn: () => void): void {
		if (this.group.isActive(editor)) {
			fn();  // only run if editor is current active
		}
	}

	private redraw(): void {
		const editor = this.group.activeEditor;
		this.lastRenderedActiveEditor = editor;

		// Clear if there is no editor
		if (!editor) {
			removeClass(this.titleContainer, 'dirty');
			this.editorLabel.clear();
			this.clearEditorActionsToolbar();
		}

		// Otherwise render it
		else {
			const isEditorPinned = this.group.isPinned(this.group.activeEditor);
			const isGroupActive = this.accessor.activeGroup === this.group;

			// Dirty state
			this.updateEditorDirty(editor);

			// Editor Label
			const resource = toResource(editor, { supportSideBySide: true });
			const name = editor.getName() || '';

			const { labelFormat } = this.accessor.partOptions;
			let description: string;
			if (labelFormat === 'default' && !isGroupActive) {
				description = ''; // hide description when group is not active and style is 'default'
			} else {
				description = editor.getDescription(this.getVerbosity(labelFormat)) || '';
			}

			let title = editor.getTitle(Verbosity.LONG);
			if (description === title) {
				title = ''; // dont repeat what is already shown
			}

			this.editorLabel.setLabel({ name, description, resource }, { title, italic: !isEditorPinned, extraClasses: ['title-label'] });
			if (isGroupActive) {
				this.editorLabel.element.style.color = this.getColor(TAB_ACTIVE_FOREGROUND);
			} else {
				this.editorLabel.element.style.color = this.getColor(TAB_UNFOCUSED_ACTIVE_FOREGROUND);
			}

			// Update Editor Actions Toolbar
			this.updateEditorActionsToolbar();
		}
	}

	private getVerbosity(style: string): Verbosity {
		switch (style) {
			case 'short': return Verbosity.SHORT;
			case 'long': return Verbosity.LONG;
			default: return Verbosity.MEDIUM;
		}
	}
}

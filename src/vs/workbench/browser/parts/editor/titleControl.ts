/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/titlecontrol';
import { localize } from 'vs/nls';
import { prepareActions } from 'vs/workbench/browser/actions';
import { IAction, Action, IRunEvent } from 'vs/base/common/actions';
import { TPromise } from 'vs/base/common/winjs.base';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import * as arrays from 'vs/base/common/arrays';
import { toResource, IEditorCommandsContext, IEditorInput } from 'vs/workbench/common/editor';
import { IActionItem, ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { ToolBar } from 'vs/base/browser/ui/toolbar/toolbar';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IQuickOpenService } from 'vs/platform/quickOpen/common/quickOpen';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ResolvedKeybinding } from 'vs/base/common/keyCodes';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { createActionItem, fillInContextMenuActions, fillInActionBarActions } from 'vs/platform/actions/browser/menuItemActionItem';
import { IMenuService, MenuId, IMenu, ExecuteCommandAction } from 'vs/platform/actions/common/actions';
import { ResourceContextKey } from 'vs/workbench/common/resources';
import { IThemeService, registerThemingParticipant, ITheme, ICssStyleCollector } from 'vs/platform/theme/common/themeService';
import { Themable } from 'vs/workbench/common/theme';
import { getCodeEditor } from 'vs/editor/browser/editorBrowser';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { Dimension, addDisposableListener, EventType } from 'vs/base/browser/dom';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IEditorGroup } from 'vs/workbench/services/group/common/editorGroupsService';
import { IEditorGroupsAccessor, IEditorPartOptions } from 'vs/workbench/browser/parts/editor/editor';
import { listActiveSelectionBackground, listActiveSelectionForeground } from 'vs/platform/theme/common/colorRegistry';
import { LocalSelectionTransfer, DraggedEditorGroupIdentifier, DraggedEditorIdentifier, fillResourceDataTransfers } from 'vs/workbench/browser/dnd';
import { applyDragImage } from 'vs/base/browser/dnd';

export interface IToolbarActions {
	primary: IAction[];
	secondary: IAction[];
}

export abstract class TitleControl extends Themable {

	protected readonly groupTransfer = LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>();
	protected readonly editorTransfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();

	private currentPrimaryEditorActionIds: string[] = [];
	private currentSecondaryEditorActionIds: string[] = [];
	protected editorActionsToolbar: ToolBar;

	private mapEditorToActions: Map<string, IToolbarActions> = new Map();

	private resourceContext: ResourceContextKey;
	private editorToolBarMenuDisposables: IDisposable[] = [];

	private contextMenu: IMenu;

	constructor(
		parent: HTMLElement,
		protected accessor: IEditorGroupsAccessor,
		protected group: IEditorGroup,
		@IContextMenuService private contextMenuService: IContextMenuService,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@INotificationService private notificationService: INotificationService,
		@IMenuService private menuService: IMenuService,
		@IQuickOpenService protected quickOpenService: IQuickOpenService,
		@IThemeService themeService: IThemeService,
		@IExtensionService private extensionService: IExtensionService
	) {
		super(themeService);

		this.resourceContext = instantiationService.createInstance(ResourceContextKey);
		this.contextMenu = this._register(this.menuService.createMenu(MenuId.EditorTitleContext, this.contextKeyService));

		this.create(parent);
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.extensionService.onDidRegisterExtensions(() => this.updateEditorActionsToolbar()));
	}

	protected abstract create(parent: HTMLElement): void;

	protected createEditorActionsToolBar(container: HTMLElement): void {
		this.editorActionsToolbar = this._register(new ToolBar(container, this.contextMenuService, {
			actionItemProvider: action => this.actionItemProvider(action as Action),
			orientation: ActionsOrientation.HORIZONTAL,
			ariaLabel: localize('araLabelEditorActions', "Editor actions"),
			getKeyBinding: action => this.getKeybinding(action)
		}));

		// Context
		this.editorActionsToolbar.context = { groupId: this.group.id } as IEditorCommandsContext;

		// Action Run Handling
		this._register(this.editorActionsToolbar.actionRunner.onDidRun((e: IRunEvent) => {

			// Notify for Error
			this.notificationService.error(e.error);

			// Log in telemetry
			if (this.telemetryService) {
				/* __GDPR__
					"workbenchActionExecuted" : {
						"id" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
						"from": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
					}
				*/
				this.telemetryService.publicLog('workbenchActionExecuted', { id: e.action.id, from: 'editorPart' });
			}
		}));
	}

	private actionItemProvider(action: Action): IActionItem {
		const activeControl = this.group.activeControl;

		// Check Active Editor
		let actionItem: IActionItem;
		if (activeControl instanceof BaseEditor) {
			actionItem = activeControl.getActionItem(action);
		}

		// Check extensions
		if (!actionItem) {
			actionItem = createActionItem(action, this.keybindingService, this.notificationService, this.contextMenuService);
		}

		return actionItem;
	}

	protected updateEditorActionsToolbar(): void {
		const isGroupActive = this.accessor.activeGroup === this.group;

		// Update Editor Actions Toolbar
		let primaryEditorActions: IAction[] = [];
		let secondaryEditorActions: IAction[] = [];

		const editorActions = this.getEditorActions();

		// Primary actions only for the active group
		if (isGroupActive) {
			primaryEditorActions = prepareActions(editorActions.primary);
		}

		// Secondary actions for all groups
		secondaryEditorActions = prepareActions(editorActions.secondary);

		// Only update if something actually has changed
		const primaryEditorActionIds = primaryEditorActions.map(a => a.id);
		const secondaryEditorActionIds = secondaryEditorActions.map(a => a.id);
		if (
			!arrays.equals(primaryEditorActionIds, this.currentPrimaryEditorActionIds) ||
			!arrays.equals(secondaryEditorActionIds, this.currentSecondaryEditorActionIds) ||
			primaryEditorActions.some(action => action instanceof ExecuteCommandAction) || // execute command actions can have the same ID but different arguments
			secondaryEditorActions.some(action => action instanceof ExecuteCommandAction)  // see also https://github.com/Microsoft/vscode/issues/16298
		) {
			this.editorActionsToolbar.setActions(primaryEditorActions, secondaryEditorActions)();

			this.currentPrimaryEditorActionIds = primaryEditorActionIds;
			this.currentSecondaryEditorActionIds = secondaryEditorActionIds;
		}
	}

	private getEditorActions(): IToolbarActions {
		const primary: IAction[] = [];
		const secondary: IAction[] = [];

		// Dispose previous listeners
		this.editorToolBarMenuDisposables = dispose(this.editorToolBarMenuDisposables);

		// Update the resource context
		this.resourceContext.set(toResource(this.group.activeEditor, { supportSideBySide: true }));

		// Editor actions require the editor control to be there, so we retrieve it via service
		const activeControl = this.group.activeControl;
		if (activeControl instanceof BaseEditor) {

			// Editor Control Actions
			let editorActions = this.mapEditorToActions.get(activeControl.getId());
			if (!editorActions) {
				editorActions = { primary: activeControl.getActions(), secondary: activeControl.getSecondaryActions() };
				this.mapEditorToActions.set(activeControl.getId(), editorActions);
			}
			primary.push(...editorActions.primary);
			secondary.push(...editorActions.secondary);

			// Contributed Actions
			const codeEditor = getCodeEditor(activeControl.getControl());
			const scopedContextKeyService = codeEditor && codeEditor.invokeWithinContext(accessor => accessor.get(IContextKeyService)) || this.contextKeyService;
			const titleBarMenu = this.menuService.createMenu(MenuId.EditorTitle, scopedContextKeyService);
			this.editorToolBarMenuDisposables.push(titleBarMenu);
			this.editorToolBarMenuDisposables.push(titleBarMenu.onDidChange(() => {

				// Update editor toolbar whenever contributed actions change
				this.updateEditorActionsToolbar();
			}));

			fillInActionBarActions(titleBarMenu, { arg: this.resourceContext.get(), shouldForwardArgs: true }, { primary, secondary });
		}

		return { primary, secondary };
	}

	protected clearEditorActionsToolbar(): void {
		this.editorActionsToolbar.setActions([], [])();

		this.currentPrimaryEditorActionIds = [];
		this.currentSecondaryEditorActionIds = [];
	}

	protected enableGroupDragging(element: HTMLElement): void {

		// Drag start
		this._register(addDisposableListener(element, EventType.DRAG_START, (e: DragEvent) => {
			if (e.target !== element) {
				return; // only if originating from tabs container
			}

			// Set editor group as transfer
			this.groupTransfer.setData([new DraggedEditorGroupIdentifier(this.group.id)], DraggedEditorGroupIdentifier.prototype);
			e.dataTransfer.effectAllowed = 'copyMove';

			// If tabs are disabled, treat dragging as if an editor tab was dragged
			if (!this.accessor.partOptions.showTabs) {
				const resource = toResource(this.group.activeEditor, { supportSideBySide: true });
				if (resource) {
					this.instantiationService.invokeFunction(fillResourceDataTransfers, [resource], e);
				}
			}

			// Drag Image
			let label = this.group.activeEditor.getName();
			if (this.accessor.partOptions.showTabs && this.group.count > 1) {
				label = localize('draggedEditorGroup', "{0} (+{1})", label, this.group.count - 1);
			}

			applyDragImage(e, label, 'monaco-editor-group-drag-image');
		}));

		// Drag end
		this._register(addDisposableListener(element, EventType.DRAG_END, () => {
			this.groupTransfer.clearData(DraggedEditorGroupIdentifier.prototype);
		}));
	}

	protected onContextMenu(editor: IEditorInput, e: Event, node: HTMLElement): void {

		// Update the resource context
		const currentContext = this.resourceContext.get();
		this.resourceContext.set(toResource(editor, { supportSideBySide: true }));

		// Find target anchor
		let anchor: HTMLElement | { x: number, y: number } = node;
		if (e instanceof MouseEvent) {
			const event = new StandardMouseEvent(e);
			anchor = { x: event.posx, y: event.posy };
		}

		// Fill in contributed actions
		const actions: IAction[] = [];
		fillInContextMenuActions(this.contextMenu, { shouldForwardArgs: true, arg: this.resourceContext.get() }, actions, this.contextMenuService);

		// Show it
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => TPromise.as(actions),
			getActionsContext: () => ({ groupId: this.group.id, editorIndex: this.group.getIndexOfEditor(editor) } as IEditorCommandsContext),
			getKeyBinding: (action) => this.getKeybinding(action),
			onHide: () => {

				// restore previous context
				this.resourceContext.set(currentContext);

				// restore focus to active group
				this.accessor.activeGroup.focus();
			}
		});
	}

	protected getKeybinding(action: IAction): ResolvedKeybinding {
		return this.keybindingService.lookupKeybinding(action.id);
	}

	protected getKeybindingLabel(action: IAction): string {
		const keybinding = this.getKeybinding(action);

		return keybinding ? keybinding.getLabel() : void 0;
	}

	//#region ITitleAreaControl

	abstract openEditor(editor: IEditorInput): void;

	abstract closeEditor(editor: IEditorInput): void;

	abstract closeEditors(editors: IEditorInput[]): void;

	abstract closeAllEditors(): void;

	abstract moveEditor(editor: IEditorInput, fromIndex: number, targetIndex: number): void;

	abstract pinEditor(editor: IEditorInput): void;

	abstract setActive(isActive: boolean): void;

	abstract updateEditorLabel(editor: IEditorInput): void;

	abstract updateEditorDirty(editor: IEditorInput): void;

	abstract updateOptions(oldOptions: IEditorPartOptions, newOptions: IEditorPartOptions): void;

	abstract updateStyles(): void;

	layout(dimension: Dimension): void {
		// Optionally implemented in subclasses
	}

	dispose(): void {
		this.editorToolBarMenuDisposables = dispose(this.editorToolBarMenuDisposables);

		super.dispose();
	}

	//#endregion
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {

	// Drag Feedback
	const dragImageBackground = theme.getColor(listActiveSelectionBackground);
	const dragImageForeground = theme.getColor(listActiveSelectionForeground);
	collector.addRule(`
		.monaco-editor-group-drag-image {
			background: ${dragImageBackground};
			color: ${dragImageForeground};
		}
	`);
});

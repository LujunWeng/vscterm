/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/tabstitlecontrol';
import { TPromise } from 'vs/base/common/winjs.base';
import { isMacintosh } from 'vs/base/common/platform';
import { shorten } from 'vs/base/common/labels';
import { ActionRunner, IAction } from 'vs/base/common/actions';
import { toResource, GroupIdentifier, IEditorInput, Verbosity } from 'vs/workbench/common/editor';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { EventType as TouchEventType, GestureEvent, Gesture } from 'vs/base/browser/touch';
import { KeyCode } from 'vs/base/common/keyCodes';
import { ResourceLabel } from 'vs/workbench/browser/labels';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IMenuService } from 'vs/platform/actions/common/actions';
import { TitleControl } from 'vs/workbench/browser/parts/editor/titleControl';
import { IQuickOpenService } from 'vs/platform/quickOpen/common/quickOpen';
import { IDisposable, dispose, combinedDisposable } from 'vs/base/common/lifecycle';
import { ScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import { ScrollbarVisibility } from 'vs/base/common/scrollable';
import { getOrSet } from 'vs/base/common/map';
import { IThemeService, registerThemingParticipant, ITheme, ICssStyleCollector } from 'vs/platform/theme/common/themeService';
import { TAB_INACTIVE_BACKGROUND, TAB_ACTIVE_BACKGROUND, TAB_ACTIVE_FOREGROUND, TAB_INACTIVE_FOREGROUND, TAB_BORDER, EDITOR_DRAG_AND_DROP_BACKGROUND, TAB_UNFOCUSED_ACTIVE_FOREGROUND, TAB_UNFOCUSED_INACTIVE_FOREGROUND, TAB_UNFOCUSED_ACTIVE_BORDER, TAB_ACTIVE_BORDER, TAB_HOVER_BACKGROUND, TAB_HOVER_BORDER, TAB_UNFOCUSED_HOVER_BACKGROUND, TAB_UNFOCUSED_HOVER_BORDER, EDITOR_GROUP_HEADER_TABS_BACKGROUND, WORKBENCH_BACKGROUND, TAB_ACTIVE_BORDER_TOP, TAB_UNFOCUSED_ACTIVE_BORDER_TOP, EDITOR_GROUP_HEADER_TABS_BORDER } from 'vs/workbench/common/theme';
import { activeContrastBorder, contrastBorder, editorBackground } from 'vs/platform/theme/common/colorRegistry';
import { ResourcesDropHandler, fillResourceDataTransfers, DraggedEditorIdentifier, DraggedEditorGroupIdentifier, DragAndDropObserver } from 'vs/workbench/browser/dnd';
import { Color } from 'vs/base/common/color';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IEditorGroup } from 'vs/workbench/services/group/common/editorGroupsService';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { addClass, addDisposableListener, hasClass, EventType, EventHelper, removeClass, Dimension, scheduleAtNextAnimationFrame, findParentWithClass, clearNode } from 'vs/base/browser/dom';
import { localize } from 'vs/nls';
import { IEditorGroupsAccessor, IEditorPartOptions } from 'vs/workbench/browser/parts/editor/editor';
import { CloseOneEditorAction } from 'vs/workbench/browser/parts/editor/editorActions';

interface IEditorInputLabel {
	name: string;
	description?: string;
	title?: string;
}

type AugmentedLabel = IEditorInputLabel & { editor: IEditorInput };

export class TabsTitleControl extends TitleControl {

	private titleContainer: HTMLElement;
	private tabsContainer: HTMLElement;
	private editorToolbarContainer: HTMLElement;
	private scrollbar: ScrollableElement;
	private closeOneEditorAction: CloseOneEditorAction;

	private tabLabelWidgets: ResourceLabel[] = [];
	private tabLabels: IEditorInputLabel[] = [];
	private tabDisposeables: IDisposable[] = [];

	private dimension: Dimension;
	private layoutScheduled: IDisposable;
	private blockRevealActiveTab: boolean;

	constructor(
		parent: HTMLElement,
		accessor: IEditorGroupsAccessor,
		group: IEditorGroup,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IUntitledEditorService private untitledEditorService: IUntitledEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotificationService notificationService: INotificationService,
		@IMenuService menuService: IMenuService,
		@IQuickOpenService quickOpenService: IQuickOpenService,
		@IThemeService themeService: IThemeService,
		@IExtensionService extensionService: IExtensionService
	) {
		super(parent, accessor, group, contextMenuService, instantiationService, contextKeyService, keybindingService, telemetryService, notificationService, menuService, quickOpenService, themeService, extensionService);
	}

	protected create(parent: HTMLElement): void {
		this.titleContainer = parent;

		// Tabs Container
		this.tabsContainer = document.createElement('div');
		this.tabsContainer.setAttribute('role', 'tablist');
		this.tabsContainer.draggable = true;
		addClass(this.tabsContainer, 'tabs-container');

		// Tabs Container listeners
		this.registerContainerListeners();

		// Scrollbar
		this.createScrollbar();

		// Editor Toolbar Container
		this.editorToolbarContainer = document.createElement('div');
		addClass(this.editorToolbarContainer, 'editor-actions');
		this.titleContainer.appendChild(this.editorToolbarContainer);

		// Editor Actions Toolbar
		this.createEditorActionsToolBar(this.editorToolbarContainer);

		// Close Action
		this.closeOneEditorAction = this._register(this.instantiationService.createInstance(CloseOneEditorAction, CloseOneEditorAction.ID, CloseOneEditorAction.LABEL));
	}

	private createScrollbar(): void {

		// Custom Scrollbar
		this.scrollbar = new ScrollableElement(this.tabsContainer, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Hidden,
			scrollYToX: true,
			useShadows: false,
			horizontalScrollbarSize: 3
		});

		this.scrollbar.onScroll(e => {
			this.tabsContainer.scrollLeft = e.scrollLeft;
		});

		this.titleContainer.appendChild(this.scrollbar.getDomNode());
	}

	private registerContainerListeners(): void {

		// Group dragging
		this.enableGroupDragging(this.tabsContainer);

		// Forward scrolling inside the container to our custom scrollbar
		this._register(addDisposableListener(this.tabsContainer, EventType.SCROLL, () => {
			if (hasClass(this.tabsContainer, 'scroll')) {
				this.scrollbar.setScrollPosition({
					scrollLeft: this.tabsContainer.scrollLeft // during DND the  container gets scrolled so we need to update the custom scrollbar
				});
			}
		}));

		// New file when double clicking on tabs container (but not tabs)
		this._register(addDisposableListener(this.tabsContainer, EventType.DBLCLICK, e => {
			if (e.target === this.tabsContainer) {
				EventHelper.stop(e);

				this.group.openEditor(this.untitledEditorService.createOrGet(), { pinned: true /* untitled is always pinned */, index: this.group.count /* always at the end */ });
			}
		}));

		// Prevent auto-scrolling (https://github.com/Microsoft/vscode/issues/16690)
		this._register(addDisposableListener(this.tabsContainer, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.button === 1) {
				e.preventDefault();
			}
		}));


		// Drop support
		this._register(new DragAndDropObserver(this.tabsContainer, {
			onDragEnter: e => {

				// Always enable support to scroll while dragging
				addClass(this.tabsContainer, 'scroll');

				// Return if the target is not on the tabs container
				if (e.target !== this.tabsContainer) {
					return;
				}

				// Return if transfer is unsupported
				if (!this.isSupportedDropTransfer(e)) {
					e.dataTransfer.dropEffect = 'none';
					return;
				}

				// Return if dragged editor is last tab because then this is a no-op
				let isLocalDragAndDrop = false;
				if (this.editorTransfer.hasData(DraggedEditorIdentifier.prototype)) {
					isLocalDragAndDrop = true;

					const localDraggedEditor = this.editorTransfer.getData(DraggedEditorIdentifier.prototype)[0].identifier;
					if (this.group.id === localDraggedEditor.groupId && this.group.getIndexOfEditor(localDraggedEditor.editor) === this.group.count - 1) {
						e.dataTransfer.dropEffect = 'none';
						return;
					}
				}

				// Update the dropEffect to "copy" if there is no local data to be dragged because
				// in that case we can only copy the data into and not move it from its source
				if (!isLocalDragAndDrop) {
					e.dataTransfer.dropEffect = 'copy';
				}

				this.updateDropFeedback(this.tabsContainer, true);
			},

			onDragLeave: e => {
				this.updateDropFeedback(this.tabsContainer, false);
				removeClass(this.tabsContainer, 'scroll');
			},

			onDragEnd: e => {
				this.updateDropFeedback(this.tabsContainer, false);
				removeClass(this.tabsContainer, 'scroll');
			},

			onDrop: e => {
				this.updateDropFeedback(this.tabsContainer, false);
				removeClass(this.tabsContainer, 'scroll');

				if (e.target === this.tabsContainer) {
					this.onDrop(e, this.group.count);
				}
			}
		}));
	}

	protected updateEditorActionsToolbar(): void {
		super.updateEditorActionsToolbar();

		// Changing the actions in the toolbar can have an impact on the size of the
		// tab container, so we need to layout the tabs to make sure the active is visible
		this.layout(this.dimension);
	}

	openEditor(editor: IEditorInput): void {

		// Create tabs as needed
		for (let i = this.tabsContainer.children.length; i < this.group.count; i++) {
			this.tabsContainer.appendChild(this.createTab(i));
		}

		// An add of a tab requires to recompute all labels
		this.computeTabLabels();

		// Redraw all tabs
		this.redraw();
	}

	closeEditor(editor: IEditorInput): void {
		this.handleClosedEditors();
	}

	closeEditors(editors: IEditorInput[]): void {
		this.handleClosedEditors();
	}

	closeAllEditors(): void {
		this.handleClosedEditors();
	}

	private handleClosedEditors(): void {

		// There are tabs to show
		if (this.group.activeEditor) {

			// Remove tabs that got closed
			while (this.tabsContainer.children.length > this.group.count) {

				// Remove one tab from container (must be the last to keep indexes in order!)
				(this.tabsContainer.lastChild as HTMLElement).remove();

				// Remove associated tab label and widget
				this.tabLabelWidgets.pop();
				this.tabDisposeables.pop().dispose();
			}

			// A removal of a label requires to recompute all labels
			this.computeTabLabels();

			// Redraw all tabs
			this.redraw();
		}

		// No tabs to show
		else {
			clearNode(this.tabsContainer);

			this.tabDisposeables = dispose(this.tabDisposeables);
			this.tabLabelWidgets = [];
			this.tabLabels = [];

			this.clearEditorActionsToolbar();
		}
	}

	moveEditor(editor: IEditorInput, fromIndex: number, targetIndex: number): void {

		// Swap the editor label
		const editorLabel = this.tabLabels[fromIndex];
		this.tabLabels.splice(fromIndex, 1);
		this.tabLabels.splice(targetIndex, 0, editorLabel);

		// As such we need to redraw each tab
		this.forEachTab((editor, index, tabContainer, tabLabelWidget, tabLabel) => {
			this.redrawTab(editor, index, tabContainer, tabLabelWidget, tabLabel);
		});

		// Moving an editor requires a layout to keep the active editor visible
		this.layout(this.dimension);
	}

	pinEditor(editor: IEditorInput): void {
		this.withTab(editor, (tabContainer, tabLabelWidget, tabLabel) => this.redrawLabel(editor, tabContainer, tabLabelWidget, tabLabel));
	}

	setActive(isGroupActive: boolean): void {

		// Activity has an impact on each tab
		this.forEachTab((editor, index, tabContainer, tabLabelWidget, tabLabel) => {
			this.redrawEditorActive(isGroupActive, editor, tabContainer, tabLabelWidget);
		});

		// Activity has an impact on the toolbar, so we need to update and layout
		this.updateEditorActionsToolbar();
		this.layout(this.dimension);
	}

	updateEditorLabel(editor: IEditorInput): void {

		// A change to a label requires to recompute all labels
		this.computeTabLabels();

		// As such we need to redraw each label
		this.forEachTab((editor, index, tabContainer, tabLabelWidget, tabLabel) => {
			this.redrawLabel(editor, tabContainer, tabLabelWidget, tabLabel);
		});

		// A change to a label requires a layout to keep the active editor visible
		this.layout(this.dimension);
	}

	updateEditorDirty(editor: IEditorInput): void {
		this.withTab(editor, tabContainer => this.redrawEditorDirty(editor, tabContainer));
	}

	updateOptions(oldOptions: IEditorPartOptions, newOptions: IEditorPartOptions): void {

		// A change to a label format options requires to recompute all labels
		if (oldOptions.labelFormat !== newOptions.labelFormat) {
			this.computeTabLabels();
		}

		// Apply new options if something of interest changed
		if (
			oldOptions.labelFormat !== newOptions.labelFormat ||
			oldOptions.tabCloseButton !== newOptions.tabCloseButton ||
			oldOptions.tabSizing !== newOptions.tabSizing ||
			oldOptions.showIcons !== newOptions.showIcons ||
			oldOptions.iconTheme !== newOptions.iconTheme
		) {
			this.redraw();
		}
	}

	updateStyles(): void {
		this.redraw();
	}

	private withTab(editor: IEditorInput, fn: (tabContainer: HTMLElement, tabLabelWidget: ResourceLabel, tabLabel: IEditorInputLabel) => void): void {
		const editorIndex = this.group.getIndexOfEditor(editor);

		const tabContainer = this.tabsContainer.children[editorIndex] as HTMLElement;
		if (tabContainer) {
			fn(tabContainer, this.tabLabelWidgets[editorIndex], this.tabLabels[editorIndex]);
		}
	}

	private createTab(index: number): HTMLElement {

		// Tab Container
		const tabContainer = document.createElement('div');
		tabContainer.draggable = true;
		tabContainer.tabIndex = 0;
		tabContainer.setAttribute('role', 'presentation'); // cannot use role "tab" here due to https://github.com/Microsoft/vscode/issues/8659
		addClass(tabContainer, 'tab');

		// Gesture Support
		Gesture.addTarget(tabContainer);

		// Tab Editor Label
		const editorLabel = this.instantiationService.createInstance(ResourceLabel, tabContainer, void 0);
		this.tabLabelWidgets.push(editorLabel);

		// Tab Close Button
		const tabCloseContainer = document.createElement('div');
		addClass(tabCloseContainer, 'tab-close');
		tabContainer.appendChild(tabCloseContainer);

		const tabActionRunner = new TabActionRunner(() => this.group.id, index);

		const tabActionBar = new ActionBar(tabCloseContainer, { ariaLabel: localize('araLabelTabActions', "Tab actions"), actionRunner: tabActionRunner });
		tabActionBar.push(this.closeOneEditorAction, { icon: true, label: false, keybinding: this.getKeybindingLabel(this.closeOneEditorAction) });
		tabActionBar.onDidBeforeRun(() => this.blockRevealActiveTabOnce());

		// Eventing
		const eventsDisposable = this.registerTabListeners(tabContainer, index);

		this.tabDisposeables.push(combinedDisposable([eventsDisposable, tabActionBar, tabActionRunner, editorLabel]));

		return tabContainer;
	}

	private registerTabListeners(tab: HTMLElement, index: number): IDisposable {
		const disposables: IDisposable[] = [];

		const handleClickOrTouch = (e: MouseEvent | GestureEvent): void => {
			tab.blur();

			if (e instanceof MouseEvent && e.button !== 0) {
				if (e.button === 1) {
					e.preventDefault(); // required to prevent auto-scrolling (https://github.com/Microsoft/vscode/issues/16690)
				}

				return void 0; // only for left mouse click
			}

			if (this.originatesFromTabActionBar(e)) {
				return; // not when clicking on actions
			}

			// Open tabs editor
			this.group.openEditor(this.group.getEditor(index));

			return void 0;
		};

		const showContextMenu = (e: Event) => {
			EventHelper.stop(e);

			this.onContextMenu(this.group.getEditor(index), e, tab);
		};

		// Open on Click / Touch
		disposables.push(addDisposableListener(tab, EventType.MOUSE_DOWN, (e: MouseEvent) => handleClickOrTouch(e)));
		disposables.push(addDisposableListener(tab, TouchEventType.Tap, (e: GestureEvent) => handleClickOrTouch(e)));

		// Touch Scroll Support
		disposables.push(addDisposableListener(tab, TouchEventType.Change, (e: GestureEvent) => {
			this.scrollbar.setScrollPosition({ scrollLeft: this.scrollbar.getScrollPosition().scrollLeft - e.translationX });
		}));

		// Close on mouse middle click
		disposables.push(addDisposableListener(tab, EventType.MOUSE_UP, (e: MouseEvent) => {
			EventHelper.stop(e);

			tab.blur();

			if (e.button === 1 /* Middle Button*/ && !this.originatesFromTabActionBar(e)) {
				this.blockRevealActiveTabOnce();
				this.closeOneEditorAction.run({ groupId: this.group.id, editorIndex: index });
			}
		}));

		// Context menu on Shift+F10
		disposables.push(addDisposableListener(tab, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.shiftKey && event.keyCode === KeyCode.F10) {
				showContextMenu(e);
			}
		}));

		// Context menu on touch context menu gesture
		disposables.push(addDisposableListener(tab, TouchEventType.Contextmenu, (e: GestureEvent) => {
			showContextMenu(e);
		}));

		// Keyboard accessibility
		disposables.push(addDisposableListener(tab, EventType.KEY_UP, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			let handled = false;

			// Run action on Enter/Space
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				handled = true;
				this.group.openEditor(this.group.getEditor(index));
			}

			// Navigate in editors
			else if ([KeyCode.LeftArrow, KeyCode.RightArrow, KeyCode.UpArrow, KeyCode.DownArrow, KeyCode.Home, KeyCode.End].some(kb => event.equals(kb))) {
				let targetIndex: number;
				if (event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.UpArrow)) {
					targetIndex = index - 1;
				} else if (event.equals(KeyCode.RightArrow) || event.equals(KeyCode.DownArrow)) {
					targetIndex = index + 1;
				} else if (event.equals(KeyCode.Home)) {
					targetIndex = 0;
				} else {
					targetIndex = this.group.count - 1;
				}

				const target = this.group.getEditor(targetIndex);
				if (target) {
					handled = true;
					this.group.openEditor(target, { preserveFocus: true });
					(<HTMLElement>this.tabsContainer.childNodes[targetIndex]).focus();
				}
			}

			if (handled) {
				EventHelper.stop(e, true);
			}

			// moving in the tabs container can have an impact on scrolling position, so we need to update the custom scrollbar
			this.scrollbar.setScrollPosition({
				scrollLeft: this.tabsContainer.scrollLeft
			});
		}));

		// Pin on double click
		disposables.push(addDisposableListener(tab, EventType.DBLCLICK, (e: MouseEvent) => {
			EventHelper.stop(e);

			this.group.pinEditor(this.group.getEditor(index));
		}));

		// Context menu
		disposables.push(addDisposableListener(tab, EventType.CONTEXT_MENU, (e: Event) => {
			EventHelper.stop(e, true);

			this.onContextMenu(this.group.getEditor(index), e, tab);
		}, true /* use capture to fix https://github.com/Microsoft/vscode/issues/19145 */));

		// Drag support
		disposables.push(addDisposableListener(tab, EventType.DRAG_START, (e: DragEvent) => {
			const editor = this.group.getEditor(index);
			this.editorTransfer.setData([new DraggedEditorIdentifier({ editor, groupId: this.group.id })], DraggedEditorIdentifier.prototype);

			e.dataTransfer.effectAllowed = 'copyMove';

			// Apply some datatransfer types to allow for dragging the element outside of the application
			const resource = toResource(editor, { supportSideBySide: true });
			if (resource) {
				this.instantiationService.invokeFunction(fillResourceDataTransfers, [resource], e);
			}

			// Fixes https://github.com/Microsoft/vscode/issues/18733
			addClass(tab, 'dragged');
			scheduleAtNextAnimationFrame(() => removeClass(tab, 'dragged'));
		}));

		// Drop support
		disposables.push(new DragAndDropObserver(tab, {
			onDragEnter: e => {

				// Update class to signal drag operation
				addClass(tab, 'dragged-over');

				// Return if transfer is unsupported
				if (!this.isSupportedDropTransfer(e)) {
					e.dataTransfer.dropEffect = 'none';
					return;
				}

				// Return if dragged editor is the current tab dragged over
				let isLocalDragAndDrop = false;
				if (this.editorTransfer.hasData(DraggedEditorIdentifier.prototype)) {
					isLocalDragAndDrop = true;

					const localDraggedEditor = this.editorTransfer.getData(DraggedEditorIdentifier.prototype)[0].identifier;
					if (localDraggedEditor.editor === this.group.getEditor(index) && localDraggedEditor.groupId === this.group.id) {
						e.dataTransfer.dropEffect = 'none';
						return;
					}
				}

				// Update the dropEffect to "copy" if there is no local data to be dragged because
				// in that case we can only copy the data into and not move it from its source
				if (!isLocalDragAndDrop) {
					e.dataTransfer.dropEffect = 'copy';
				}

				this.updateDropFeedback(tab, true, index);
			},

			onDragLeave: e => {
				removeClass(tab, 'dragged-over');
				this.updateDropFeedback(tab, false, index);
			},

			onDragEnd: e => {
				removeClass(tab, 'dragged-over');
				this.updateDropFeedback(tab, false, index);

				this.editorTransfer.clearData(DraggedEditorIdentifier.prototype);
			},

			onDrop: e => {
				removeClass(tab, 'dragged-over');
				this.updateDropFeedback(tab, false, index);

				this.onDrop(e, index);
			}
		}));

		return combinedDisposable(disposables);
	}

	private isSupportedDropTransfer(e: DragEvent): boolean {
		if (this.groupTransfer.hasData(DraggedEditorGroupIdentifier.prototype)) {
			return false; // groups cannot be dropped on title area
		}

		if (this.editorTransfer.hasData(DraggedEditorIdentifier.prototype)) {
			return true; // (local) editors can always be dropped
		}

		if (e.dataTransfer.types.length > 0) {
			return true; // optimistically allow external data (// see https://github.com/Microsoft/vscode/issues/25789)
		}

		return false;
	}

	private updateDropFeedback(element: HTMLElement, isDND: boolean, index?: number): void {
		const isTab = (typeof index === 'number');
		const isActiveTab = isTab && this.group.isActive(this.group.getEditor(index));

		// Background
		const noDNDBackgroundColor = isTab ? this.getColor(isActiveTab ? TAB_ACTIVE_BACKGROUND : TAB_INACTIVE_BACKGROUND) : null;
		element.style.backgroundColor = isDND ? this.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND) : noDNDBackgroundColor;

		// Outline
		const activeContrastBorderColor = this.getColor(activeContrastBorder);
		if (activeContrastBorderColor && isDND) {
			element.style.outlineWidth = '2px';
			element.style.outlineStyle = 'dashed';
			element.style.outlineColor = activeContrastBorderColor;
			element.style.outlineOffset = isTab ? '-5px' : '-3px';
		} else {
			element.style.outlineWidth = null;
			element.style.outlineStyle = null;
			element.style.outlineColor = activeContrastBorderColor;
			element.style.outlineOffset = null;
		}
	}

	private computeTabLabels(): void {
		const { labelFormat } = this.accessor.partOptions;
		const { verbosity, shortenDuplicates } = this.getLabelConfigFlags(labelFormat);

		// Build labels and descriptions for each editor
		const labels = this.group.editors.map(editor => ({
			editor,
			name: editor.getName(),
			description: editor.getDescription(verbosity),
			title: editor.getTitle(Verbosity.LONG)
		}));

		// Shorten labels as needed
		if (shortenDuplicates) {
			this.shortenTabLabels(labels);
		}

		this.tabLabels = labels;
	}

	private shortenTabLabels(labels: AugmentedLabel[]): void {

		// Gather duplicate titles, while filtering out invalid descriptions
		const mapTitleToDuplicates = new Map<string, AugmentedLabel[]>();
		for (const label of labels) {
			if (typeof label.description === 'string') {
				getOrSet(mapTitleToDuplicates, label.name, []).push(label);
			} else {
				label.description = '';
			}
		}

		// Identify duplicate titles and shorten descriptions
		mapTitleToDuplicates.forEach(duplicateTitles => {

			// Remove description if the title isn't duplicated
			if (duplicateTitles.length === 1) {
				duplicateTitles[0].description = '';

				return;
			}

			// Identify duplicate descriptions
			const mapDescriptionToDuplicates = new Map<string, AugmentedLabel[]>();
			for (const label of duplicateTitles) {
				getOrSet(mapDescriptionToDuplicates, label.description, []).push(label);
			}

			// For editors with duplicate descriptions, check whether any long descriptions differ
			let useLongDescriptions = false;
			mapDescriptionToDuplicates.forEach((duplicateDescriptions, name) => {
				if (!useLongDescriptions && duplicateDescriptions.length > 1) {
					const [first, ...rest] = duplicateDescriptions.map(({ editor }) => editor.getDescription(Verbosity.LONG));
					useLongDescriptions = rest.some(description => description !== first);
				}
			});

			// If so, replace all descriptions with long descriptions
			if (useLongDescriptions) {
				mapDescriptionToDuplicates.clear();
				duplicateTitles.forEach(label => {
					label.description = label.editor.getDescription(Verbosity.LONG);
					getOrSet(mapDescriptionToDuplicates, label.description, []).push(label);
				});
			}

			// Obtain final set of descriptions
			const descriptions: string[] = [];
			mapDescriptionToDuplicates.forEach((_, description) => descriptions.push(description));

			// Remove description if all descriptions are identical
			if (descriptions.length === 1) {
				for (const label of mapDescriptionToDuplicates.get(descriptions[0])) {
					label.description = '';
				}

				return;
			}

			// Shorten descriptions
			const shortenedDescriptions = shorten(descriptions);
			descriptions.forEach((description, i) => {
				for (const label of mapDescriptionToDuplicates.get(description)) {
					label.description = shortenedDescriptions[i];
				}
			});
		});
	}

	private getLabelConfigFlags(value: string) {
		switch (value) {
			case 'short':
				return { verbosity: Verbosity.SHORT, shortenDuplicates: false };
			case 'medium':
				return { verbosity: Verbosity.MEDIUM, shortenDuplicates: false };
			case 'long':
				return { verbosity: Verbosity.LONG, shortenDuplicates: false };
			default:
				return { verbosity: Verbosity.MEDIUM, shortenDuplicates: true };
		}
	}

	private redraw(): void {

		// For each tab
		this.forEachTab((editor, index, tabContainer, tabLabelWidget, tabLabel) => {
			this.redrawTab(editor, index, tabContainer, tabLabelWidget, tabLabel);
		});

		// Update Editor Actions Toolbar
		this.updateEditorActionsToolbar();

		// Ensure the active tab is always revealed
		this.layout(this.dimension);
	}

	private forEachTab(fn: (editor: IEditorInput, index: number, tabContainer: HTMLElement, tabLabelWidget: ResourceLabel, tabLabel: IEditorInputLabel) => void): void {
		this.group.editors.forEach((editor, index) => {
			const tabContainer = this.tabsContainer.children[index] as HTMLElement;
			if (tabContainer) {
				fn(editor, index, tabContainer, this.tabLabelWidgets[index], this.tabLabels[index]);
			}
		});
	}

	private redrawTab(editor: IEditorInput, index: number, tabContainer: HTMLElement, tabLabelWidget: ResourceLabel, tabLabel: IEditorInputLabel): void {

		// Label
		this.redrawLabel(editor, tabContainer, tabLabelWidget, tabLabel);

		// Borders / Outline
		const borderLeftColor = (index !== 0) ? (this.getColor(TAB_BORDER) || this.getColor(contrastBorder)) : null;
		const borderRightColor = (index === this.group.count - 1) ? (this.getColor(TAB_BORDER) || this.getColor(contrastBorder)) : null;
		tabContainer.style.borderLeft = borderLeftColor ? `1px solid ${borderLeftColor}` : null;
		tabContainer.style.borderRight = borderRightColor ? `1px solid ${borderRightColor}` : null;
		tabContainer.style.outlineColor = this.getColor(activeContrastBorder);

		// Settings
		const options = this.accessor.partOptions;

		['off', 'left', 'right'].forEach(option => {
			const domAction = options.tabCloseButton === option ? addClass : removeClass;
			domAction(tabContainer, `close-button-${option}`);
		});

		['fit', 'shrink'].forEach(option => {
			const domAction = options.tabSizing === option ? addClass : removeClass;
			domAction(tabContainer, `sizing-${option}`);
		});

		if (options.showIcons && !!options.iconTheme) {
			addClass(tabContainer, 'has-icon-theme');
		} else {
			removeClass(tabContainer, 'has-icon-theme');
		}

		// Active state
		this.redrawEditorActive(this.accessor.activeGroup === this.group, editor, tabContainer, tabLabelWidget);

		// Dirty State
		this.redrawEditorDirty(editor, tabContainer);
	}

	private redrawLabel(editor: IEditorInput, tabContainer: HTMLElement, tabLabelWidget: ResourceLabel, tabLabel: IEditorInputLabel): void {
		const name = tabLabel.name;
		const description = tabLabel.description || '';
		const title = tabLabel.title || '';

		// Container
		tabContainer.setAttribute('aria-label', `${name}, tab`);
		tabContainer.title = title;

		// Label
		tabLabelWidget.setLabel({ name, description, resource: toResource(editor, { supportSideBySide: true }) }, { extraClasses: ['tab-label'], italic: !this.group.isPinned(editor) });
	}

	private redrawEditorActive(isGroupActive: boolean, editor: IEditorInput, tabContainer: HTMLElement, tabLabelWidget: ResourceLabel): void {

		// Tab is active
		if (this.group.isActive(editor)) {

			// Container
			addClass(tabContainer, 'active');
			tabContainer.setAttribute('aria-selected', 'true');
			tabContainer.style.backgroundColor = this.getColor(TAB_ACTIVE_BACKGROUND);

			const activeTabBorderColor = this.getColor(isGroupActive ? TAB_ACTIVE_BORDER : TAB_UNFOCUSED_ACTIVE_BORDER);
			const activeTabBorderColorTop = this.getColor(isGroupActive ? TAB_ACTIVE_BORDER_TOP : TAB_UNFOCUSED_ACTIVE_BORDER_TOP);
			if (activeTabBorderColor) {
				// Use boxShadow for the active tab border because if we also have a editor group header
				// color, the two colors would collide and the tab border never shows up.
				// see https://github.com/Microsoft/vscode/issues/33111
				// In case of tabs container having a border, we need to inset -2px for the border to show up.
				const hasTabsContainerBorder = !!this.getColor(EDITOR_GROUP_HEADER_TABS_BORDER);
				tabContainer.style.boxShadow = `${activeTabBorderColor} 0 ${hasTabsContainerBorder ? -2 : -1}px inset`;
			} else if (activeTabBorderColorTop) {
				tabContainer.style.boxShadow = `${activeTabBorderColorTop} 0 2px inset`;
			} else {
				tabContainer.style.boxShadow = null;
			}

			// Label
			tabLabelWidget.element.style.color = this.getColor(isGroupActive ? TAB_ACTIVE_FOREGROUND : TAB_UNFOCUSED_ACTIVE_FOREGROUND);
		}

		// Tab is inactive
		else {

			// Containr
			removeClass(tabContainer, 'active');
			tabContainer.setAttribute('aria-selected', 'false');
			tabContainer.style.backgroundColor = this.getColor(TAB_INACTIVE_BACKGROUND);
			tabContainer.style.boxShadow = null;

			// Label
			tabLabelWidget.element.style.color = this.getColor(isGroupActive ? TAB_INACTIVE_FOREGROUND : TAB_UNFOCUSED_INACTIVE_FOREGROUND);
		}
	}

	private redrawEditorDirty(editor: IEditorInput, tabContainer: HTMLElement): void {
		if (editor.isDirty()) {
			addClass(tabContainer, 'dirty');
		} else {
			removeClass(tabContainer, 'dirty');
		}
	}

	layout(dimension: Dimension): void {
		const activeTab = this.getTab(this.group.activeEditor);
		if (!activeTab || !dimension) {
			return;
		}

		this.dimension = dimension;

		// The layout of tabs can be an expensive operation because we access DOM properties
		// that can result in the browser doing a full page layout to validate them. To buffer
		// this a little bit we try at least to schedule this work on the next animation frame.
		if (!this.layoutScheduled) {
			this.layoutScheduled = scheduleAtNextAnimationFrame(() => {
				this.doLayout(this.dimension);
				this.layoutScheduled = void 0;
			});
		}
	}

	private doLayout(dimension: Dimension): void {
		const activeTab = this.getTab(this.group.activeEditor);
		if (!activeTab) {
			return;
		}

		const visibleContainerWidth = this.tabsContainer.offsetWidth;
		const totalContainerWidth = this.tabsContainer.scrollWidth;

		let activeTabPosX: number;
		let activeTabWidth: number;

		if (!this.blockRevealActiveTab) {
			activeTabPosX = activeTab.offsetLeft;
			activeTabWidth = activeTab.offsetWidth;
		}

		// Update scrollbar
		this.scrollbar.setScrollDimensions({
			width: visibleContainerWidth,
			scrollWidth: totalContainerWidth
		});

		// Return now if we are blocked to reveal the active tab and clear flag
		if (this.blockRevealActiveTab) {
			this.blockRevealActiveTab = false;
			return;
		}

		// Reveal the active one
		const containerScrollPosX = this.scrollbar.getScrollPosition().scrollLeft;
		const activeTabFits = activeTabWidth <= visibleContainerWidth;

		// Tab is overflowing to the right: Scroll minimally until the element is fully visible to the right
		// Note: only try to do this if we actually have enough width to give to show the tab fully!
		if (activeTabFits && containerScrollPosX + visibleContainerWidth < activeTabPosX + activeTabWidth) {
			this.scrollbar.setScrollPosition({
				scrollLeft: containerScrollPosX + ((activeTabPosX + activeTabWidth) /* right corner of tab */ - (containerScrollPosX + visibleContainerWidth) /* right corner of view port */)
			});
		}

		// Tab is overlflowng to the left or does not fit: Scroll it into view to the left
		else if (containerScrollPosX > activeTabPosX || !activeTabFits) {
			this.scrollbar.setScrollPosition({
				scrollLeft: activeTabPosX
			});
		}
	}

	private getTab(editor: IEditorInput): HTMLElement {
		const editorIndex = this.group.getIndexOfEditor(editor);
		if (editorIndex >= 0) {
			return this.tabsContainer.children[editorIndex] as HTMLElement;
		}

		return void 0;
	}

	private blockRevealActiveTabOnce(): void {

		// When closing tabs through the tab close button or gesture, the user
		// might want to rapidly close tabs in sequence and as such revealing
		// the active tab after each close would be annoying. As such we block
		// the automated revealing of the active tab once after the close is
		// triggered.
		this.blockRevealActiveTab = true;
	}

	private originatesFromTabActionBar(e: MouseEvent | GestureEvent): boolean {
		let element: HTMLElement;
		if (e instanceof MouseEvent) {
			element = (e.target || e.srcElement) as HTMLElement;
		} else {
			element = (e as GestureEvent).initialTarget as HTMLElement;
		}

		return !!findParentWithClass(element, 'monaco-action-bar', 'tab');
	}

	private onDrop(e: DragEvent, targetIndex: number): void {
		EventHelper.stop(e, true);

		this.updateDropFeedback(this.tabsContainer, false);
		removeClass(this.tabsContainer, 'scroll');

		// Local DND
		const draggedEditor = this.editorTransfer.hasData(DraggedEditorIdentifier.prototype) ? this.editorTransfer.getData(DraggedEditorIdentifier.prototype)[0].identifier : void 0;
		if (draggedEditor) {
			const sourceGroup = this.accessor.getGroup(draggedEditor.groupId);

			// Move editor to target position and index
			if (this.isMoveOperation(e, draggedEditor.groupId)) {
				sourceGroup.moveEditor(draggedEditor.editor, this.group, { index: targetIndex });
			}

			// Copy editor to target position and index
			else {
				sourceGroup.copyEditor(draggedEditor.editor, this.group, { index: targetIndex });
			}

			this.group.focus();
			this.editorTransfer.clearData(DraggedEditorIdentifier.prototype);
		}

		// External DND
		else {
			const dropHandler = this.instantiationService.createInstance(ResourcesDropHandler, { allowWorkspaceOpen: false /* open workspace file as file if dropped */ });
			dropHandler.handleDrop(e, () => this.group, () => this.group.focus(), targetIndex);
		}
	}

	private isMoveOperation(e: DragEvent, source: GroupIdentifier) {
		const isCopy = (e.ctrlKey && !isMacintosh) || (e.altKey && isMacintosh);

		return !isCopy || source === this.group.id;
	}

	dispose(): void {
		super.dispose();

		this.layoutScheduled = dispose(this.layoutScheduled);
	}
}

class TabActionRunner extends ActionRunner {

	constructor(
		private groupId: () => GroupIdentifier,
		private index: number
	) {
		super();
	}

	run(action: IAction, context?: any): TPromise<void> {
		const groupId = this.groupId();
		if (typeof groupId !== 'number') {
			return TPromise.as(void 0);
		}

		return super.run(action, { groupId, editorIndex: this.index });
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {

	// Styling with Outline color (e.g. high contrast theme)
	const activeContrastBorderColor = theme.getColor(activeContrastBorder);
	if (activeContrastBorderColor) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active:hover  {
				outline: 1px solid;
				outline-offset: -5px;
			}

			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab:hover  {
				outline: 1px dashed;
				outline-offset: -5px;
			}

			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active > .tab-close .action-label,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active:hover > .tab-close .action-label,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.dirty > .tab-close .action-label,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab:hover > .tab-close .action-label {
				opacity: 1 !important;
			}
		`);
	}

	// Hover Background
	const tabHoverBackground = theme.getColor(TAB_HOVER_BACKGROUND);
	if (tabHoverBackground) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container.active > .title .tabs-container > .tab:hover  {
				background-color: ${tabHoverBackground} !important;
			}
		`);
	}

	const tabUnfocusedHoverBackground = theme.getColor(TAB_UNFOCUSED_HOVER_BACKGROUND);
	if (tabUnfocusedHoverBackground) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab:hover  {
				background-color: ${tabUnfocusedHoverBackground} !important;
			}
		`);
	}

	// Hover Border
	const tabHoverBorder = theme.getColor(TAB_HOVER_BORDER);
	if (tabHoverBorder) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container.active > .title .tabs-container > .tab:hover  {
				box-shadow: ${tabHoverBorder} 0 -1px inset !important;
			}
		`);
	}

	const tabUnfocusedHoverBorder = theme.getColor(TAB_UNFOCUSED_HOVER_BORDER);
	if (tabUnfocusedHoverBorder) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab:hover  {
				box-shadow: ${tabUnfocusedHoverBorder} 0 -1px inset !important;
			}
		`);
	}

	// Fade out styles via linear gradient (when tabs are set to shrink)
	if (theme.type !== 'hc') {
		const workbenchBackground = WORKBENCH_BACKGROUND(theme);
		const editorBackgroundColor = theme.getColor(editorBackground);
		const editorGroupHeaderTabsBackground = theme.getColor(EDITOR_GROUP_HEADER_TABS_BACKGROUND);
		const editorDragAndDropBackground = theme.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND);

		let adjustedTabBackground: Color;
		if (editorGroupHeaderTabsBackground && editorBackgroundColor) {
			adjustedTabBackground = editorGroupHeaderTabsBackground.flatten(editorBackgroundColor, editorBackgroundColor, workbenchBackground);
		}

		let adjustedTabDragBackground: Color;
		if (editorGroupHeaderTabsBackground && editorBackgroundColor && editorDragAndDropBackground && editorBackgroundColor) {
			adjustedTabDragBackground = editorGroupHeaderTabsBackground.flatten(editorBackgroundColor, editorDragAndDropBackground, editorBackgroundColor, workbenchBackground);
		}

		// Adjust gradient for (focused) hover background
		if (tabHoverBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabHoverBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabHoverBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
				.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title.active .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColor}, transparent);
				}


				.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title.active .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
				}
			`);
		}

		// Adjust gradient for unfocused hover background
		if (tabUnfocusedHoverBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabUnfocusedHoverBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabUnfocusedHoverBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
				.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColor}, transparent);
				}

				.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
				}
			`);
		}

		// Adjust gradient for drag and drop background
		if (editorDragAndDropBackground && adjustedTabDragBackground) {
			const adjustedColorDrag = editorDragAndDropBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
			.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container.active > .title .tabs-container > .tab.sizing-shrink.dragged-over:not(.active):not(.dragged) > .tab-label::after,
			.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title .tabs-container > .tab.sizing-shrink.dragged-over:not(.dragged) > .tab-label::after {
				background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
			}
		`);
		}

		// Adjust gradient for active tab background
		const tabActiveBackground = theme.getColor(TAB_ACTIVE_BACKGROUND);
		if (tabActiveBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabActiveBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabActiveBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
				.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title .tabs-container > .tab.sizing-shrink.active:not(.dragged) > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColor}, transparent);
				}

				.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title .tabs-container > .tab.sizing-shrink.active:not(.dragged) > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
				}
			`);
		}

		// Adjust gradient for inactive tab background
		const tabInactiveBackground = theme.getColor(TAB_INACTIVE_BACKGROUND);
		if (tabInactiveBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabInactiveBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabInactiveBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title
			.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title .tabs-container > .tab.sizing-shrink:not(.dragged) > .tab-label::after {
				background: linear-gradient(to left, ${adjustedColor}, transparent);
			}

			.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title .tabs-container > .tab.sizing-shrink:not(.dragged) > .tab-label::after {
				background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
			}
		`);
		}
	}
});

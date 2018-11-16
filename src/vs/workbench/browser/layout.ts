/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import * as errors from 'vs/base/common/errors';
import { QuickOpenController } from 'vs/workbench/browser/parts/quickopen/quickOpenController';
import { QuickInputService } from 'vs/workbench/browser/parts/quickinput/quickInput';
import { Sash, ISashEvent, IVerticalSashLayoutProvider, IHorizontalSashLayoutProvider, Orientation } from 'vs/base/browser/ui/sash/sash';
import { IPartService, Position, ILayoutOptions, Parts } from 'vs/workbench/services/part/common/partService';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { Disposable } from 'vs/base/common/lifecycle';
import { getZoomFactor } from 'vs/base/browser/browser';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { memoize } from 'vs/base/common/decorators';
import { NotificationsCenter } from 'vs/workbench/browser/parts/notifications/notificationsCenter';
import { NotificationsToasts } from 'vs/workbench/browser/parts/notifications/notificationsToasts';
import { Dimension, getClientArea, size, position, hide, show } from 'vs/base/browser/dom';
import { IEditorGroupsService } from 'vs/workbench/services/group/common/editorGroupsService';
import { EditorPart } from 'vs/workbench/browser/parts/editor/editorPart';
import { TitlebarPart } from 'vs/workbench/browser/parts/titlebar/titlebarPart';
import { ActivitybarPart } from 'vs/workbench/browser/parts/activitybar/activitybarPart';
import { SidebarPart } from 'vs/workbench/browser/parts/sidebar/sidebarPart';
import { PanelPart } from 'vs/workbench/browser/parts/panel/panelPart';
import { StatusbarPart } from 'vs/workbench/browser/parts/statusbar/statusbarPart';

const TITLE_BAR_HEIGHT = 22;
const STATUS_BAR_HEIGHT = 22;
const ACTIVITY_BAR_WIDTH = 50;

const MIN_SIDEBAR_PART_WIDTH = 170;
const DEFAULT_SIDEBAR_PART_WIDTH = 300;
const HIDE_SIDEBAR_WIDTH_THRESHOLD = 50;

const MIN_PANEL_PART_HEIGHT = 77;
const MIN_PANEL_PART_WIDTH = 300;
const DEFAULT_PANEL_PART_SIZE = 350;
const DEFAULT_PANEL_SIZE_COEFFICIENT = 0.4;
const PANEL_SIZE_BEFORE_MAXIMIZED_BOUNDARY = 0.7;
const HIDE_PANEL_HEIGHT_THRESHOLD = 50;
const HIDE_PANEL_WIDTH_THRESHOLD = 100;

/**
 * The workbench layout is responsible to lay out all parts that make the Workbench.
 */
export class WorkbenchLayout extends Disposable implements IVerticalSashLayoutProvider, IHorizontalSashLayoutProvider {

	private static readonly sashXOneWidthSettingsKey = 'workbench.sidebar.width';
	private static readonly sashXTwoWidthSettingsKey = 'workbench.panel.width';
	private static readonly sashYHeightSettingsKey = 'workbench.panel.height';
	private static readonly panelSizeBeforeMaximizedKey = 'workbench.panel.sizeBeforeMaximized';

	private workbenchSize: Dimension;

	private sashXOne: Sash;
	private sashXTwo: Sash;
	private sashY: Sash;

	private _sidebarWidth: number;
	private sidebarHeight: number;
	private titlebarHeight: number;
	private statusbarHeight: number;
	private panelSizeBeforeMaximized: number;
	private panelMaximized: boolean;
	private _panelHeight: number;
	private _panelWidth: number;

	// Take parts as an object bag since instatation service does not have typings for constructors with 9+ arguments
	constructor(
		private parent: HTMLElement,
		private workbenchContainer: HTMLElement,
		private parts: {
			titlebar: TitlebarPart,
			activitybar: ActivitybarPart,
			editor: EditorPart,
			sidebar: SidebarPart,
			panel: PanelPart,
			statusbar: StatusbarPart
		},
		private quickopen: QuickOpenController,
		private quickInput: QuickInputService,
		private notificationsCenter: NotificationsCenter,
		private notificationsToasts: NotificationsToasts,
		@IStorageService private storageService: IStorageService,
		@IContextViewService private contextViewService: IContextViewService,
		@IPartService private partService: IPartService,
		@IViewletService private viewletService: IViewletService,
		@IThemeService private themeService: IThemeService,
		@IEditorGroupsService private editorGroupService: IEditorGroupsService
	) {
		super();

		// Restore state
		// this.restorePreviousState();

		// Create layout sashes
		this.sashXOne = new Sash(this.workbenchContainer, this, { baseSize: 5 });
		this.sashXTwo = new Sash(this.workbenchContainer, this, { baseSize: 5 });
		this.sashY = new Sash(this.workbenchContainer, this, { baseSize: 4, orientation: Orientation.HORIZONTAL });

		this.registerListeners();
	}

	private restorePreviousState(): void {
		this._sidebarWidth = Math.max(this.partLayoutInfo.sidebar.minWidth, this.storageService.getInteger(WorkbenchLayout.sashXOneWidthSettingsKey, StorageScope.GLOBAL, DEFAULT_SIDEBAR_PART_WIDTH));

		this._panelWidth = Math.max(this.partLayoutInfo.panel.minWidth, this.storageService.getInteger(WorkbenchLayout.sashXTwoWidthSettingsKey, StorageScope.GLOBAL, DEFAULT_PANEL_PART_SIZE));
		this._panelHeight = Math.max(this.partLayoutInfo.panel.minHeight, this.storageService.getInteger(WorkbenchLayout.sashYHeightSettingsKey, StorageScope.GLOBAL, DEFAULT_PANEL_PART_SIZE));

		this.panelMaximized = false;
		this.panelSizeBeforeMaximized = this.storageService.getInteger(WorkbenchLayout.panelSizeBeforeMaximizedKey, StorageScope.GLOBAL, 0);
	}

	private registerListeners(): void {
		this._register(this.themeService.onThemeChange(_ => this.layout()));
		this._register(this.parts.editor.onDidPreferredSizeChange(() => this.onDidPreferredSizeChange()));

		this.registerSashListeners();
	}

	private onDidPreferredSizeChange(): void {
		if (this.workbenchSize && (this.sidebarWidth || this.panelHeight)) {
			if (this.editorGroupService.count > 1) {
				const preferredEditorPartSize = this.parts.editor.preferredSize;

				const sidebarOverflow = this.workbenchSize.width - this.sidebarWidth < preferredEditorPartSize.width;

				let panelOverflow = false;
				if (this.partService.getPanelPosition() === Position.RIGHT) {
					panelOverflow = this.workbenchSize.width - this.panelWidth - this.sidebarWidth < preferredEditorPartSize.width;
				} else {
					panelOverflow = this.workbenchSize.height - this.panelHeight < preferredEditorPartSize.height;
				}

				// Trigger a layout if we detect that either sidebar or panel overflow
				// as a matter of a new editor group being added to the editor part
				if (sidebarOverflow || panelOverflow) {
					this.layout();
				}
			}
		}
	}

	private get activitybarWidth(): number {
		if (this.partService.isVisible(Parts.ACTIVITYBAR_PART)) {
			return this.partLayoutInfo.activitybar.width;
		}

		return 0;
	}

	private get panelHeight(): number {
		const panelPosition = this.partService.getPanelPosition();
		if (panelPosition === Position.RIGHT) {
			return this.sidebarHeight;
		}

		return this._panelHeight;
	}

	private set panelHeight(value: number) {
		this._panelHeight = Math.min(this.computeMaxPanelHeight(), Math.max(this.partLayoutInfo.panel.minHeight, value));
	}

	private get panelWidth(): number {
		const panelPosition = this.partService.getPanelPosition();
		if (panelPosition === Position.BOTTOM) {
			return this.workbenchSize.width - this.activitybarWidth - this.sidebarWidth;
		}

		return this._panelWidth;
	}

	private set panelWidth(value: number) {
		this._panelWidth = Math.min(this.computeMaxPanelWidth(), Math.max(this.partLayoutInfo.panel.minWidth, value));
	}

	private computeMaxPanelWidth(): number {
		let minSidebarWidth: number;
		if (this.partService.isVisible(Parts.SIDEBAR_PART)) {
			if (this.partService.getSideBarPosition() === Position.LEFT) {
				minSidebarWidth = this.partLayoutInfo.sidebar.minWidth;
			} else {
				minSidebarWidth = this.sidebarWidth;
			}
		} else {
			minSidebarWidth = 0;
		}

		return Math.max(this.partLayoutInfo.panel.minWidth, this.workbenchSize.width - this.parts.editor.preferredSize.width - minSidebarWidth - this.activitybarWidth);
	}

	private computeMaxPanelHeight(): number {
		return Math.max(this.partLayoutInfo.panel.minHeight, this.sidebarHeight /* simplification for: window.height - status.height - title-height */ - this.parts.editor.preferredSize.height);
	}

	private get sidebarWidth(): number {
		if (this.partService.isVisible(Parts.SIDEBAR_PART)) {
			return this._sidebarWidth;
		}

		return 0;
	}

	private set sidebarWidth(value: number) {
		const panelMinWidth = this.partService.getPanelPosition() === Position.RIGHT && this.partService.isVisible(Parts.PANEL_PART) ? this.partLayoutInfo.panel.minWidth : 0;
		const maxSidebarWidth = this.workbenchSize.width - this.activitybarWidth - this.parts.editor.preferredSize.width - panelMinWidth;

		this._sidebarWidth = Math.max(this.partLayoutInfo.sidebar.minWidth, Math.min(maxSidebarWidth, value));
	}

	@memoize
	private get partLayoutInfo() {
		return {
			titlebar: {
				height: TITLE_BAR_HEIGHT
			},
			activitybar: {
				width: ACTIVITY_BAR_WIDTH
			},
			sidebar: {
				minWidth: MIN_SIDEBAR_PART_WIDTH
			},
			panel: {
				minHeight: MIN_PANEL_PART_HEIGHT,
				minWidth: MIN_PANEL_PART_WIDTH
			},
			statusbar: {
				height: STATUS_BAR_HEIGHT
			}
		};
	}

	private registerSashListeners(): void {
		let startX: number = 0;
		let startY: number = 0;
		let startXTwo: number = 0;
		let startSidebarWidth: number;
		let startPanelHeight: number;
		let startPanelWidth: number;

		this._register(this.sashXOne.onDidStart((e: ISashEvent) => {
			startSidebarWidth = this.sidebarWidth;
			startX = e.startX;
		}));

		this._register(this.sashY.onDidStart((e: ISashEvent) => {
			startPanelHeight = this.panelHeight;
			startY = e.startY;
		}));

		this._register(this.sashXTwo.onDidStart((e: ISashEvent) => {
			startPanelWidth = this.panelWidth;
			startXTwo = e.startX;
		}));

		this._register(this.sashXOne.onDidChange((e: ISashEvent) => {
			let doLayout = false;
			let sidebarPosition = this.partService.getSideBarPosition();
			let isSidebarVisible = this.partService.isVisible(Parts.SIDEBAR_PART);
			let newSashWidth = (sidebarPosition === Position.LEFT) ? startSidebarWidth + e.currentX - startX : startSidebarWidth - e.currentX + startX;
			let promise = TPromise.wrap<void>(null);

			// Sidebar visible
			if (isSidebarVisible) {

				// Automatically hide side bar when a certain threshold is met
				if (newSashWidth + HIDE_SIDEBAR_WIDTH_THRESHOLD < this.partLayoutInfo.sidebar.minWidth) {
					let dragCompensation = this.partLayoutInfo.sidebar.minWidth - HIDE_SIDEBAR_WIDTH_THRESHOLD;
					promise = this.partService.setSideBarHidden(true);
					startX = (sidebarPosition === Position.LEFT) ? Math.max(this.activitybarWidth, e.currentX - dragCompensation) : Math.min(e.currentX + dragCompensation, this.workbenchSize.width - this.activitybarWidth);
					this.sidebarWidth = startSidebarWidth; // when restoring sidebar, restore to the sidebar width we started from
				}

				// Otherwise size the sidebar accordingly
				else {
					this.sidebarWidth = Math.max(this.partLayoutInfo.sidebar.minWidth, newSashWidth); // Sidebar can not become smaller than MIN_PART_WIDTH
					doLayout = newSashWidth >= this.partLayoutInfo.sidebar.minWidth;
				}
			}

			// Sidebar hidden
			else {
				if ((sidebarPosition === Position.LEFT && e.currentX - startX >= this.partLayoutInfo.sidebar.minWidth) ||
					(sidebarPosition === Position.RIGHT && startX - e.currentX >= this.partLayoutInfo.sidebar.minWidth)) {
					startSidebarWidth = this.partLayoutInfo.sidebar.minWidth - (sidebarPosition === Position.LEFT ? e.currentX - startX : startX - e.currentX);
					this.sidebarWidth = this.partLayoutInfo.sidebar.minWidth;
					promise = this.partService.setSideBarHidden(false);
				}
			}

			if (doLayout) {
				promise.done(() => this.layout({ source: Parts.SIDEBAR_PART }), errors.onUnexpectedError);
			}
		}));

		this._register(this.sashY.onDidChange((e: ISashEvent) => {
			let doLayout = false;
			let isPanelVisible = this.partService.isVisible(Parts.PANEL_PART);
			let newSashHeight = startPanelHeight - (e.currentY - startY);
			let promise = TPromise.wrap<void>(null);

			// Panel visible
			if (isPanelVisible) {

				// Automatically hide panel when a certain threshold is met
				if (newSashHeight + HIDE_PANEL_HEIGHT_THRESHOLD < this.partLayoutInfo.panel.minHeight) {
					let dragCompensation = this.partLayoutInfo.panel.minHeight - HIDE_PANEL_HEIGHT_THRESHOLD;
					promise = this.partService.setPanelHidden(true);
					startY = Math.min(this.sidebarHeight - this.statusbarHeight - this.titlebarHeight, e.currentY + dragCompensation);
					this.panelHeight = startPanelHeight; // when restoring panel, restore to the panel height we started from
				}

				// Otherwise size the panel accordingly
				else {
					this.panelHeight = Math.max(this.partLayoutInfo.panel.minHeight, newSashHeight); // Panel can not become smaller than MIN_PART_HEIGHT
					doLayout = newSashHeight >= this.partLayoutInfo.panel.minHeight;
				}
			}

			// Panel hidden
			else {
				if (startY - e.currentY >= this.partLayoutInfo.panel.minHeight) {
					startPanelHeight = 0;
					this.panelHeight = this.partLayoutInfo.panel.minHeight;
					promise = this.partService.setPanelHidden(false);
				}
			}

			if (doLayout) {
				promise.done(() => this.layout({ source: Parts.PANEL_PART }), errors.onUnexpectedError);
			}
		}));

		this._register(this.sashXTwo.onDidChange((e: ISashEvent) => {
			let doLayout = false;
			let isPanelVisible = this.partService.isVisible(Parts.PANEL_PART);
			let newSashWidth = startPanelWidth - (e.currentX - startXTwo);
			let promise = TPromise.wrap<void>(null);

			// Panel visible
			if (isPanelVisible) {

				// Automatically hide panel when a certain threshold is met
				if (newSashWidth + HIDE_PANEL_WIDTH_THRESHOLD < this.partLayoutInfo.panel.minWidth) {
					let dragCompensation = this.partLayoutInfo.panel.minWidth - HIDE_PANEL_WIDTH_THRESHOLD;
					promise = this.partService.setPanelHidden(true);
					startXTwo = Math.min(this.workbenchSize.width - this.activitybarWidth, e.currentX + dragCompensation);
					this.panelWidth = startPanelWidth; // when restoring panel, restore to the panel height we started from
				}

				// Otherwise size the panel accordingly
				else {
					this.panelWidth = newSashWidth;
					doLayout = newSashWidth >= this.partLayoutInfo.panel.minWidth;
				}
			}

			// Panel hidden
			else {
				if (startXTwo - e.currentX >= this.partLayoutInfo.panel.minWidth) {
					startPanelWidth = 0;
					this.panelWidth = this.partLayoutInfo.panel.minWidth;
					promise = this.partService.setPanelHidden(false);
				}
			}

			if (doLayout) {
				promise.done(() => this.layout({ source: Parts.PANEL_PART }), errors.onUnexpectedError);
			}
		}));

		this._register(this.sashXOne.onDidEnd(() => {
			this.storageService.store(WorkbenchLayout.sashXOneWidthSettingsKey, this.sidebarWidth, StorageScope.GLOBAL);
		}));

		this._register(this.sashY.onDidEnd(() => {
			this.storageService.store(WorkbenchLayout.sashYHeightSettingsKey, this.panelHeight, StorageScope.GLOBAL);
		}));

		this._register(this.sashXTwo.onDidEnd(() => {
			this.storageService.store(WorkbenchLayout.sashXTwoWidthSettingsKey, this.panelWidth, StorageScope.GLOBAL);
		}));

		this._register(this.sashY.onDidReset(() => {
			this.panelHeight = this.sidebarHeight * DEFAULT_PANEL_SIZE_COEFFICIENT;
			this.storageService.store(WorkbenchLayout.sashYHeightSettingsKey, this.panelHeight, StorageScope.GLOBAL);
			this.layout();
		}));

		this._register(this.sashXOne.onDidReset(() => {
			let activeViewlet = this.viewletService.getActiveViewlet();
			let optimalWidth = activeViewlet && activeViewlet.getOptimalWidth();
			this.sidebarWidth = Math.max(optimalWidth, DEFAULT_SIDEBAR_PART_WIDTH);
			this.storageService.store(WorkbenchLayout.sashXOneWidthSettingsKey, this.sidebarWidth, StorageScope.GLOBAL);
			this.partService.setSideBarHidden(false).done(() => this.layout(), errors.onUnexpectedError);
		}));

		this._register(this.sashXTwo.onDidReset(() => {
			this.panelWidth = (this.workbenchSize.width - this.sidebarWidth - this.activitybarWidth) * DEFAULT_PANEL_SIZE_COEFFICIENT;
			this.storageService.store(WorkbenchLayout.sashXTwoWidthSettingsKey, this.panelWidth, StorageScope.GLOBAL);
			this.layout();
		}));
	}

	/* Compute size and position of parts and render them on DOM on change */
	layout(options?: ILayoutOptions): void {
		this.workbenchSize = getClientArea(this.parent);

		// Deletion of the following two lines will break render process. WHY?
		const isTitlebarHidden = !this.partService.isVisible(Parts.TITLEBAR_PART);
		this.titlebarHeight = isTitlebarHidden ? 0 : this.partLayoutInfo.titlebar.height / getZoomFactor(); // adjust for zoom prevention

		// Workbench
		position(this.workbenchContainer, 0, 0, 0, 0, 'relative');
		size(this.workbenchContainer, this.workbenchSize.width, this.workbenchSize.height);

		// Bug on Chrome: Sometimes Chrome wants to scroll the workbench container on layout changes. The fix is to reset scrolling in this case.
		const workbenchContainer = this.workbenchContainer;
		if (workbenchContainer.scrollTop > 0) {
			workbenchContainer.scrollTop = 0;
		}
		if (workbenchContainer.scrollLeft > 0) {
			workbenchContainer.scrollLeft = 0;
		}

		// Quick open
		this.quickopen.layout(this.workbenchSize);

		// Panel layout
		const panelPosition = this.partService.getPanelPosition();

		// Sashes
		this.sashXOne.layout();
		if (panelPosition === Position.BOTTOM) {
			this.sashXTwo.hide();
			this.sashY.layout();
			this.sashY.show();
		} else {
			this.sashY.hide();
			this.sashXTwo.layout();
			this.sashXTwo.show();
		}

		// Propagate to Context View
		this.contextViewService.layout();

		const panelContainer = this.parts.panel.getContainer();
		const newPanelDimension = new Dimension(this.workbenchSize.width, this.workbenchSize.height + this.titlebarHeight);
		size(panelContainer, newPanelDimension.width, newPanelDimension.height);
		position(panelContainer, 0, 0, 0, 0);
		show(panelContainer);
		this.parts.panel.layout(newPanelDimension);
	}

	getVerticalSashTop(sash: Sash): number {
		return this.titlebarHeight;
	}

	getVerticalSashLeft(sash: Sash): number {
		let sidebarPosition = this.partService.getSideBarPosition();
		if (sash === this.sashXOne) {

			if (sidebarPosition === Position.LEFT) {
				return this.sidebarWidth + this.activitybarWidth;
			}

			return this.workbenchSize.width - this.sidebarWidth - this.activitybarWidth;
		}

		return this.workbenchSize.width - this.panelWidth - (sidebarPosition === Position.RIGHT ? this.sidebarWidth + this.activitybarWidth : 0);
	}

	getVerticalSashHeight(sash: Sash): number {
		if (sash === this.sashXTwo && !this.partService.isVisible(Parts.PANEL_PART)) {
			return 0;
		}

		return this.sidebarHeight;
	}

	getHorizontalSashTop(sash: Sash): number {
		const offset = 2; // Horizontal sash should be a bit lower than the editor area, thus add 2px #5524
		return offset + (this.partService.isVisible(Parts.PANEL_PART) ? this.sidebarHeight - this.panelHeight + this.titlebarHeight : this.sidebarHeight + this.titlebarHeight);
	}

	getHorizontalSashLeft(sash: Sash): number {
		if (this.partService.getSideBarPosition() === Position.RIGHT) {
			return 0;
		}

		return this.sidebarWidth + this.activitybarWidth;
	}

	getHorizontalSashWidth(sash: Sash): number {
		return this.panelWidth;
	}

	isPanelMaximized(): boolean {
		return this.panelMaximized;
	}

	// change part size along the main axis
	resizePart(part: Parts, sizeChange: number): void {
		const panelPosition = this.partService.getPanelPosition();
		const sizeChangePxWidth = this.workbenchSize.width * (sizeChange / 100);
		const sizeChangePxHeight = this.workbenchSize.height * (sizeChange / 100);

		let doLayout = false;
		switch (part) {
			case Parts.SIDEBAR_PART:
				this.sidebarWidth = this.sidebarWidth + sizeChangePxWidth; // Sidebar can not become smaller than MIN_PART_WIDTH

				const preferredEditorPartSize = this.parts.editor.preferredSize;
				if (this.workbenchSize.width - this.sidebarWidth < preferredEditorPartSize.width) {
					this.sidebarWidth = this.workbenchSize.width - preferredEditorPartSize.width;
				}

				doLayout = true;
				break;
			case Parts.PANEL_PART:
				if (panelPosition === Position.BOTTOM) {
					this.panelHeight = this.panelHeight + sizeChangePxHeight;
				} else if (panelPosition === Position.RIGHT) {
					this.panelWidth = this.panelWidth + sizeChangePxWidth;
				}

				doLayout = true;
				break;
			case Parts.EDITOR_PART:
				// If we have one editor we can cheat and resize sidebar with the negative delta
				// If the sidebar is not visible and panel is, resize panel main axis with negative Delta
				if (this.editorGroupService.count === 1) {
					if (this.partService.isVisible(Parts.SIDEBAR_PART)) {
						this.sidebarWidth = this.sidebarWidth - sizeChangePxWidth;
						doLayout = true;
					} else if (this.partService.isVisible(Parts.PANEL_PART)) {
						if (panelPosition === Position.BOTTOM) {
							this.panelHeight = this.panelHeight - sizeChangePxHeight;
						} else if (panelPosition === Position.RIGHT) {
							this.panelWidth = this.panelWidth - sizeChangePxWidth;
						}
						doLayout = true;
					}
				} else {
					const activeGroup = this.editorGroupService.activeGroup;

					const activeGroupSize = this.editorGroupService.getSize(activeGroup);
					this.editorGroupService.setSize(activeGroup, activeGroupSize + sizeChangePxWidth);
				}
		}

		if (doLayout) {
			this.layout();
		}
	}
}

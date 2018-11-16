/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { createDecorator, ServiceIdentifier } from 'vs/platform/instantiation/common/instantiation';
import { Event } from 'vs/base/common/event';

export enum Parts {
	ACTIVITYBAR_PART,
	SIDEBAR_PART,
	PANEL_PART,
	EDITOR_PART,
	STATUSBAR_PART,
	TITLEBAR_PART
}

export enum Position {
	LEFT,
	RIGHT,
	BOTTOM
}

export interface ILayoutOptions {
	toggleMaximizedPanel?: boolean;
	source?: Parts;
}

export interface IDimension {
	readonly width: number;
	readonly height: number;
}

export const IPartService = createDecorator<IPartService>('partService');

export interface IPartService {
	_serviceBrand: ServiceIdentifier<any>;

	/**
	 * Emits when the visibility of the title bar changes.
	 */
	onTitleBarVisibilityChange: Event<void>;

	/**
	 * Emits when the editor part's layout changes.
	 */
	onEditorLayout: Event<IDimension>;

	/**
	 * Asks the part service to layout all parts.
	 */
	layout(options?: ILayoutOptions): void;

	/**
	 * Asks the part service to if all parts have been created.
	 */
	isCreated(): boolean;

	/**
	 * Returns whether the given part has the keyboard focus or not.
	 */
	hasFocus(part: Parts): boolean;

	/**
	 * Returns the parts HTML element, if there is one.
	 */
	getContainer(part: Parts): HTMLElement;

	/**
	 * Returns if the part is visible.
	 */
	isVisible(part: Parts): boolean;

	/**
	 * Set activity bar hidden or not
	 */
	setActivityBarHidden(hidden: boolean): void;

	/**
	 * Number of pixels (adjusted for zooming) that the title bar (if visible) pushes down the workbench contents.
	 */
	getTitleBarOffset(): number;

	/**
	 * Set sidebar hidden or not
	 */
	setSideBarHidden(hidden: boolean): TPromise<void>;

	/**
	 * Set panel part hidden or not
	 */
	setPanelHidden(hidden: boolean): TPromise<void>;

	/**
	 * Maximizes the panel height if the panel is not already maximized.
	 * Shrinks the panel to the default starting size if the panel is maximized.
	 */
	toggleMaximizedPanel(): void;

	/**
	 * Returns true if the panel is maximized.
	 */
	isPanelMaximized(): boolean;

	/**
	 * Gets the current side bar position. Note that the sidebar can be hidden too.
	 */
	getSideBarPosition(): Position;

	/**
	 * Gets the current panel position. Note that the panel can be hidden too.
	 */
	getPanelPosition(): Position;

	/**
	 * Sets the panel position.
	 */
	setPanelPosition(position: Position): TPromise<void>;

	/**
	 * Returns the identifier of the element that contains the workbench.
	 */
	getWorkbenchElementId(): string;

	/**
	 * Toggles the workbench in and out of zen mode - parts get hidden and window goes fullscreen.
	 */
	toggleZenMode(): void;

	/**
	 * Returns whether the centered editor layout is active.
	 */
	isEditorLayoutCentered(): boolean;

	/**
	 * Sets the workbench in and out of centered editor layout.
	 */
	centerEditorLayout(active: boolean): void;

	/**
	 * Resizes currently focused part on main access
	 */
	resizePart(part: Parts, sizeChange: number): void;
}

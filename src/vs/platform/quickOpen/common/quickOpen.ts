/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import uri from 'vs/base/common/uri';
import { Event } from 'vs/base/common/event';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IQuickNavigateConfiguration, IAutoFocus, IEntryRunContext } from 'vs/base/parts/quickopen/common/quickOpen';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IAction } from 'vs/base/common/actions';
import { FileKind } from 'vs/platform/files/common/files';

export interface IFilePickOpenEntry extends IPickOpenEntry {
	resource: uri;
	fileKind?: FileKind;
}

export interface IPickOpenAction extends IAction {
	run(item: IPickOpenItem): TPromise<any>;
}

export interface IPickOpenEntry {
	id?: string;
	label: string;
	description?: string;
	detail?: string;
	tooltip?: string;
	separator?: ISeparator;
	alwaysShow?: boolean;
	run?: (context: IEntryRunContext) => void;
	action?: IAction;
	payload?: any;
}

export interface IPickOpenItem {
	index: number;
	remove: () => void;
	getId: () => string;
	getResource: () => uri;
	getPayload: () => any;
}

export interface ISeparator {
	border?: boolean;
	label?: string;
}

export interface IPickOptions {

	/**
	 * an optional string to show as place holder in the input box to guide the user what she picks on
	 */
	placeHolder?: string;

	/**
	 * optional auto focus settings
	 */
	autoFocus?: IAutoFocus;

	/**
	 * an optional flag to include the description when filtering the picks
	 */
	matchOnDescription?: boolean;

	/**
	 * an optional flag to include the detail when filtering the picks
	 */
	matchOnDetail?: boolean;

	/**
	 * an optional flag to not close the picker on focus lost
	 */
	ignoreFocusLost?: boolean;

	/**
	 * enables quick navigate in the picker to open an element without typing
	 */
	quickNavigateConfiguration?: IQuickNavigateConfiguration;

	/**
	 * a context key to set when this picker is active
	 */
	contextKey?: string;
}

export interface IShowOptions {
	quickNavigateConfiguration?: IQuickNavigateConfiguration;
	inputSelection?: { start: number; end: number; };
	autoFocus?: IAutoFocus;
}

export const IQuickOpenService = createDecorator<IQuickOpenService>('quickOpenService');

export interface IQuickOpenService {

	_serviceBrand: any;

	/**
	 * Asks the container to show the quick open control with the optional prefix set. If the optional parameter
	 * is set for quick navigation mode, the quick open control will quickly navigate when the quick navigate
	 * key is pressed and will run the selection after the ctrl key is released.
	 *
	 * The returned promise completes when quick open is closing.
	 */
	show(prefix?: string, options?: IShowOptions): TPromise<void>;

	/**
	 * A convenient way to bring up quick open as a picker with custom elements. This bypasses the quick open handler
	 * registry and just leverages the quick open widget to select any kind of entries.
	 *
	 * Passing in a promise will allow you to resolve the elements in the background while quick open will show a
	 * progress bar spinning.
	 */
	pick(picks: TPromise<string[]>, options?: IPickOptions, token?: CancellationToken): TPromise<string>;
	pick<T extends IPickOpenEntry>(picks: TPromise<T[]>, options?: IPickOptions, token?: CancellationToken): TPromise<T>;
	pick(picks: string[], options?: IPickOptions, token?: CancellationToken): TPromise<string>;
	pick<T extends IPickOpenEntry>(picks: T[], options?: IPickOptions, token?: CancellationToken): TPromise<T>;

	/**
	 * Allows to navigate from the outside in an opened picker.
	 */
	navigate(next: boolean, quickNavigate?: IQuickNavigateConfiguration): void;

	/**
	 * Accepts the selected value in quick open if visible.
	 */
	accept(): void;

	/**
	 * Focus into the quick open if visible.
	 */
	focus(): void;

	/**
	 * Closes any opened quick open.
	 */
	close(): void;

	/**
	 * Allows to register on the event that quick open is showing
	 */
	onShow: Event<void>;

	/**
	 * Allows to register on the event that quick open is hiding
	 */
	onHide: Event<void>;
}

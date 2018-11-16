/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import product from 'vs/platform/node/product';
import { TPromise } from 'vs/base/common/winjs.base';
import Severity from 'vs/base/common/severity';
import { isLinux, isWindows } from 'vs/base/common/platform';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { mnemonicButtonLabel } from 'vs/base/common/labels';
import { IDialogService, IConfirmation, IConfirmationResult, IDialogOptions } from 'vs/platform/dialogs/common/dialogs';

interface IMassagedMessageBoxOptions {

	/**
	 * OS massaged message box options.
	 */
	options: Electron.MessageBoxOptions;

	/**
	 * Since the massaged result of the message box options potentially
	 * changes the order of buttons, we have to keep a map of these
	 * changes so that we can still return the correct index to the caller.
	 */
	buttonIndexMap: number[];
}

export class DialogService implements IDialogService {

	public _serviceBrand: any;

	constructor(
		@IWindowService private windowService: IWindowService
	) {
	}

	public confirm(confirmation: IConfirmation): TPromise<IConfirmationResult> {
		const { options, buttonIndexMap } = this.massageMessageBoxOptions(this.getConfirmOptions(confirmation));

		return this.windowService.showMessageBox(options).then(result => {
			return {
				confirmed: buttonIndexMap[result.button] === 0 ? true : false,
				checkboxChecked: result.checkboxChecked
			} as IConfirmationResult;
		});
	}

	private getConfirmOptions(confirmation: IConfirmation): Electron.MessageBoxOptions {
		const buttons: string[] = [];
		if (confirmation.primaryButton) {
			buttons.push(confirmation.primaryButton);
		} else {
			buttons.push(nls.localize({ key: 'yesButton', comment: ['&& denotes a mnemonic'] }, "&&Yes"));
		}

		if (confirmation.secondaryButton) {
			buttons.push(confirmation.secondaryButton);
		} else if (typeof confirmation.secondaryButton === 'undefined') {
			buttons.push(nls.localize('cancelButton', "Cancel"));
		}

		const opts: Electron.MessageBoxOptions = {
			title: confirmation.title,
			message: confirmation.message,
			buttons,
			cancelId: 1
		};

		if (confirmation.detail) {
			opts.detail = confirmation.detail;
		}

		if (confirmation.type) {
			opts.type = confirmation.type;
		}

		if (confirmation.checkbox) {
			opts.checkboxLabel = confirmation.checkbox.label;
			opts.checkboxChecked = confirmation.checkbox.checked;
		}

		return opts;
	}

	public show(severity: Severity, message: string, buttons: string[], dialogOptions?: IDialogOptions): TPromise<number> {
		const { options, buttonIndexMap } = this.massageMessageBoxOptions({
			message,
			buttons,
			type: (severity === Severity.Info) ? 'question' : (severity === Severity.Error) ? 'error' : (severity === Severity.Warning) ? 'warning' : 'none',
			cancelId: dialogOptions ? dialogOptions.cancelId : void 0,
			detail: dialogOptions ? dialogOptions.detail : void 0
		});

		return this.windowService.showMessageBox(options).then(result => buttonIndexMap[result.button]);
	}

	private massageMessageBoxOptions(options: Electron.MessageBoxOptions): IMassagedMessageBoxOptions {
		let buttonIndexMap = options.buttons.map((button, index) => index);
		let buttons = options.buttons.map(button => mnemonicButtonLabel(button));
		let cancelId = options.cancelId;

		// Linux: order of buttons is reverse
		// macOS: also reverse, but the OS handles this for us!
		if (isLinux) {
			buttons = buttons.reverse();
			buttonIndexMap = buttonIndexMap.reverse();
		}

		// Default Button (always first one)
		options.defaultId = buttonIndexMap[0];

		// Cancel Button
		if (typeof cancelId === 'number') {

			// Ensure the cancelId is the correct one from our mapping
			cancelId = buttonIndexMap[cancelId];

			// macOS/Linux: the cancel button should always be to the left of the primary action
			// if we see more than 2 buttons, move the cancel one to the left of the primary
			if (!isWindows && buttons.length > 2 && cancelId !== 1) {
				const cancelButton = buttons[cancelId];
				buttons.splice(cancelId, 1);
				buttons.splice(1, 0, cancelButton);

				const cancelButtonIndex = buttonIndexMap[cancelId];
				buttonIndexMap.splice(cancelId, 1);
				buttonIndexMap.splice(1, 0, cancelButtonIndex);

				cancelId = 1;
			}
		}

		options.buttons = buttons;
		options.cancelId = cancelId;
		options.noLink = true;
		options.title = options.title || product.nameLong;

		return { options, buttonIndexMap };
	}
}
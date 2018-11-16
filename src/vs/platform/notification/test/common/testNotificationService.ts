/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { INotificationService, INotificationHandle, NoOpNotification, Severity, INotification, IPromptChoice } from 'vs/platform/notification/common/notification';

export class TestNotificationService implements INotificationService {

	public _serviceBrand: any;

	private static readonly NO_OP: INotificationHandle = new NoOpNotification();

	public info(message: string): INotificationHandle {
		return this.notify({ severity: Severity.Info, message });
	}

	public warn(message: string): INotificationHandle {
		return this.notify({ severity: Severity.Warning, message });
	}

	public error(error: string | Error): INotificationHandle {
		return this.notify({ severity: Severity.Error, message: error });
	}

	public notify(notification: INotification): INotificationHandle {
		return TestNotificationService.NO_OP;
	}

	public prompt(severity: Severity, message: string, choices: IPromptChoice[], onCancel?: () => void): INotificationHandle {
		return TestNotificationService.NO_OP;
	}
}
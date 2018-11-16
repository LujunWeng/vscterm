/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import product from 'vs/platform/node/product';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import URI from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { onUnexpectedError } from 'vs/base/common/errors';
import { IWindowService, IWindowsService } from 'vs/platform/windows/common/windows';

export class TelemetryOptOut implements IWorkbenchContribution {

	private static TELEMETRY_OPT_OUT_SHOWN = 'workbench.telemetryOptOutShown';

	constructor(
		@IStorageService storageService: IStorageService,
		@IOpenerService openerService: IOpenerService,
		@INotificationService notificationService: INotificationService,
		@IWindowService windowService: IWindowService,
		@IWindowsService windowsService: IWindowsService,
		@ITelemetryService telemetryService: ITelemetryService
	) {
		if (!product.telemetryOptOutUrl || storageService.get(TelemetryOptOut.TELEMETRY_OPT_OUT_SHOWN)) {
			return;
		}
		Promise.all([
			windowService.isFocused(),
			windowsService.getWindowCount()
		]).then(([focused, count]) => {
			if (!focused && count > 1) {
				return null;
			}
			storageService.store(TelemetryOptOut.TELEMETRY_OPT_OUT_SHOWN, true);

			const optOutUrl = product.telemetryOptOutUrl;
			const privacyUrl = product.privacyStatementUrl || product.telemetryOptOutUrl;
			const optOutNotice = localize('telemetryOptOut.optOutNotice', "Help improve VS Code by allowing Microsoft to collect usage data. Read our [privacy statement]({0}) and learn how to [opt out]({1}).", privacyUrl, optOutUrl);
			const optInNotice = localize('telemetryOptOut.optInNotice', "Help improve VS Code by allowing Microsoft to collect usage data. Read our [privacy statement]({0}) and learn how to [opt in]({1}).", privacyUrl, optOutUrl);

			notificationService.prompt(
				Severity.Info,
				telemetryService.isOptedIn ? optOutNotice : optInNotice,
				[{
					label: localize('telemetryOptOut.readMore', "Read More"),
					run: () => openerService.open(URI.parse(optOutUrl))
				}]
			);
		})
			.then(null, onUnexpectedError);
	}
}

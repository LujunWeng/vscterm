/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import * as nls from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { Action } from 'vs/base/common/actions';
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import { IWorkbenchActionRegistry, Extensions } from 'vs/workbench/common/actions';
import { IConfigurationService, ConfigurationTarget } from 'vs/platform/configuration/common/configuration';
import { IPartService, Parts } from 'vs/workbench/services/part/common/partService';

export class ToggleActivityBarVisibilityAction extends Action {

	public static readonly ID = 'workbench.action.toggleActivityBarVisibility';
	public static readonly LABEL = nls.localize('toggleActivityBar', "Toggle Activity Bar Visibility");

	private static readonly activityBarVisibleKey = 'workbench.activityBar.visible';

	constructor(
		id: string,
		label: string,
		@IPartService private partService: IPartService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(id, label);

		this.enabled = !!this.partService;
	}

	public run(): TPromise<any> {
		const visibility = this.partService.isVisible(Parts.ACTIVITYBAR_PART);
		const newVisibilityValue = !visibility;

		return this.configurationService.updateValue(ToggleActivityBarVisibilityAction.activityBarVisibleKey, newVisibilityValue, ConfigurationTarget.USER);
	}
}

const registry = Registry.as<IWorkbenchActionRegistry>(Extensions.WorkbenchActions);
registry.registerWorkbenchAction(new SyncActionDescriptor(ToggleActivityBarVisibilityAction, ToggleActivityBarVisibilityAction.ID, ToggleActivityBarVisibilityAction.LABEL), 'View: Toggle Activity Bar Visibility', nls.localize('view', "View"));
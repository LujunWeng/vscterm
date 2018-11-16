/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	'id': 'update',
	'order': 15,
	'title': nls.localize('updateConfigurationTitle', "Update"),
	'type': 'object',
	'properties': {
		'update.channel': {
			'type': 'string',
			'enum': ['none', 'default'],
			'default': 'default',
			'scope': ConfigurationScope.APPLICATION,
			'description': nls.localize('updateChannel', "Configure whether you receive automatic updates from an update channel. Requires a restart after change.")
		},
		'update.enableWindowsBackgroundUpdates': {
			'type': 'boolean',
			'default': true,
			'scope': ConfigurationScope.APPLICATION,
			'description': nls.localize('enableWindowsBackgroundUpdates', "Enables Windows background updates.")
		}
	}
});

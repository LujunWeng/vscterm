/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { Client as TelemetryClient } from 'vs/base/parts/ipc/node/ipc.cp';
import * as strings from 'vs/base/common/strings';
import * as objects from 'vs/base/common/objects';
import { TelemetryAppenderClient } from 'vs/platform/telemetry/common/telemetryIpc';
import { IJSONSchema, IJSONSchemaSnippet } from 'vs/base/common/jsonSchema';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IConfig, IDebuggerContribution, IAdapterExecutable, INTERNAL_CONSOLE_OPTIONS_SCHEMA, IConfigurationManager, IDebugAdapter, IDebugConfiguration, ITerminalSettings } from 'vs/workbench/parts/debug/common/debug';
import { IExtensionDescription } from 'vs/workbench/services/extensions/common/extensions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IOutputService } from 'vs/workbench/parts/output/common/output';
import { DebugAdapter, SocketDebugAdapter } from 'vs/workbench/parts/debug/node/debugAdapter';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import uri from 'vs/base/common/uri';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { memoize } from 'vs/base/common/decorators';

export class Debugger {

	private mergedExtensionDescriptions: IExtensionDescription[];

	constructor(private configurationManager: IConfigurationManager, private debuggerContribution: IDebuggerContribution, public extensionDescription: IExtensionDescription,
		@IConfigurationService private configurationService: IConfigurationService,
		@ICommandService private commandService: ICommandService,
		@IConfigurationResolverService private configurationResolverService: IConfigurationResolverService,
		@ITelemetryService private telemetryService: ITelemetryService,
	) {
		this.mergedExtensionDescriptions = [extensionDescription];
	}

	public hasConfigurationProvider = false;

	public createDebugAdapter(root: IWorkspaceFolder, outputService: IOutputService, debugPort?: number): TPromise<IDebugAdapter> {
		return this.getAdapterExecutable(root).then(adapterExecutable => {
			if (this.inEH()) {
				return this.configurationManager.createDebugAdapter(this.type, adapterExecutable, debugPort);
			} else {
				if (debugPort) {
					return new SocketDebugAdapter(debugPort);
				} else {
					return new DebugAdapter(this.type, adapterExecutable, this.mergedExtensionDescriptions, outputService);
				}
			}
		});
	}

	public getAdapterExecutable(root: IWorkspaceFolder): TPromise<IAdapterExecutable | null> {

		// first try to get an executable from DebugConfigurationProvider
		return this.configurationManager.debugAdapterExecutable(root ? root.uri : undefined, this.type).then(adapterExecutable => {

			if (adapterExecutable) {
				return adapterExecutable;
			}

			// try deprecated command based extension API to receive an executable
			if (this.debuggerContribution.adapterExecutableCommand) {
				return this.commandService.executeCommand<IAdapterExecutable>(this.debuggerContribution.adapterExecutableCommand, root ? root.uri.toString() : undefined);
			}

			// give up and let DebugAdapter determine executable based on package.json contribution
			return TPromise.as(null);
		});
	}

	public substituteVariables(folder: IWorkspaceFolder, config: IConfig): TPromise<IConfig> {

		// first resolve command variables (which might have a UI)
		return this.configurationResolverService.executeCommandVariables(config, this.variables).then(commandValueMapping => {

			if (!commandValueMapping) { // cancelled by user
				return null;
			}

			// now substitute all other variables
			return (this.inEH() ? this.configurationManager.substituteVariables(this.type, folder, config) : TPromise.as(config)).then(config => {
				try {
					return TPromise.as(DebugAdapter.substituteVariables(folder, config, this.configurationResolverService, commandValueMapping));
				} catch (e) {
					return TPromise.wrapError(e);
				}
			});
		});
	}

	public runInTerminal(args: DebugProtocol.RunInTerminalRequestArguments): TPromise<void> {
		const config = this.configurationService.getValue<ITerminalSettings>('terminal');
		return this.configurationManager.runInTerminal(this.inEH() ? this.type : '*', args, config);
	}

	private inEH(): boolean {
		const debugConfigs = this.configurationService.getValue<IDebugConfiguration>('debug');
		return debugConfigs.extensionHostDebugAdapter;
	}

	public get label(): string {
		return this.debuggerContribution.label || this.debuggerContribution.type;
	}

	public get type(): string {
		return this.debuggerContribution.type;
	}

	public get variables(): { [key: string]: string } {
		return this.debuggerContribution.variables;
	}

	public get configurationSnippets(): IJSONSchemaSnippet[] {
		return this.debuggerContribution.configurationSnippets;
	}

	public get languages(): string[] {
		return this.debuggerContribution.languages;
	}

	public merge(secondRawAdapter: IDebuggerContribution, extensionDescription: IExtensionDescription): void {

		// remember all ext descriptions that are the source of this debugger
		this.mergedExtensionDescriptions.push(extensionDescription);

		// Give priority to built in debug adapters
		if (extensionDescription.isBuiltin) {
			this.extensionDescription = extensionDescription;
		}
		objects.mixin(this.debuggerContribution, secondRawAdapter, extensionDescription.isBuiltin);
	}

	public hasInitialConfiguration(): boolean {
		return !!this.debuggerContribution.initialConfigurations;
	}

	public getInitialConfigurationContent(initialConfigs?: IConfig[]): TPromise<string> {
		// at this point we got some configs from the package.json and/or from registered DebugConfigurationProviders
		let initialConfigurations = this.debuggerContribution.initialConfigurations || [];
		if (initialConfigs) {
			initialConfigurations = initialConfigurations.concat(initialConfigs);
		}

		const configs = JSON.stringify(initialConfigurations, null, '\t').split('\n').map(line => '\t' + line).join('\n').trim();
		const comment1 = nls.localize('launch.config.comment1', "Use IntelliSense to learn about possible attributes.");
		const comment2 = nls.localize('launch.config.comment2', "Hover to view descriptions of existing attributes.");
		const comment3 = nls.localize('launch.config.comment3', "For more information, visit: {0}", 'https://go.microsoft.com/fwlink/?linkid=830387');

		let content = [
			'{',
			`\t// ${comment1}`,
			`\t// ${comment2}`,
			`\t// ${comment3}`,
			`\t"version": "0.2.0",`,
			`\t"configurations": ${configs}`,
			'}'
		].join('\n');

		// fix formatting
		const editorConfig = this.configurationService.getValue<any>();
		if (editorConfig.editor && editorConfig.editor.insertSpaces) {
			content = content.replace(new RegExp('\t', 'g'), strings.repeat(' ', editorConfig.editor.tabSize));
		}

		return TPromise.as(content);
	}

	@memoize
	public getCustomTelemetryService(): TPromise<TelemetryService> {
		if (!this.debuggerContribution.aiKey) {
			return TPromise.as(undefined);
		}

		return this.telemetryService.getTelemetryInfo().then(info => {
			const telemetryInfo: { [key: string]: string } = Object.create(null);
			telemetryInfo['common.vscodemachineid'] = info.machineId;
			telemetryInfo['common.vscodesessionid'] = info.sessionId;
			return telemetryInfo;
		}).then(data => {
			const client = new TelemetryClient(
				uri.parse(require.toUrl('bootstrap')).fsPath,
				{
					serverName: 'Debug Telemetry',
					timeout: 1000 * 60 * 5,
					args: [`${this.extensionDescription.publisher}.${this.type}`, JSON.stringify(data), this.debuggerContribution.aiKey],
					env: {
						ELECTRON_RUN_AS_NODE: 1,
						PIPE_LOGGING: 'true',
						AMD_ENTRYPOINT: 'vs/workbench/parts/debug/node/telemetryApp'
					}
				}
			);

			const channel = client.getChannel('telemetryAppender');
			const appender = new TelemetryAppenderClient(channel);

			return new TelemetryService({ appender }, this.configurationService);
		});
	}

	public getSchemaAttributes(): IJSONSchema[] {
		if (!this.debuggerContribution.configurationAttributes) {
			return null;
		}
		// fill in the default configuration attributes shared by all adapters.
		return Object.keys(this.debuggerContribution.configurationAttributes).map(request => {
			const attributes: IJSONSchema = this.debuggerContribution.configurationAttributes[request];
			const defaultRequired = ['name', 'type', 'request'];
			attributes.required = attributes.required && attributes.required.length ? defaultRequired.concat(attributes.required) : defaultRequired;
			attributes.additionalProperties = false;
			attributes.type = 'object';
			if (!attributes.properties) {
				attributes.properties = {};
			}
			const properties = attributes.properties;
			properties['type'] = {
				enum: [this.type],
				description: nls.localize('debugType', "Type of configuration."),
				pattern: '^(?!node2)',
				errorMessage: nls.localize('debugTypeNotRecognised', "The debug type is not recognized. Make sure that you have a corresponding debug extension installed and that it is enabled."),
				patternErrorMessage: nls.localize('node2NotSupported', "\"node2\" is no longer supported, use \"node\" instead and set the \"protocol\" attribute to \"inspector\".")
			};
			properties['name'] = {
				type: 'string',
				description: nls.localize('debugName', "Name of configuration; appears in the launch configuration drop down menu."),
				default: 'Launch'
			};
			properties['request'] = {
				enum: [request],
				description: nls.localize('debugRequest', "Request type of configuration. Can be \"launch\" or \"attach\"."),
			};
			properties['debugServer'] = {
				type: 'number',
				description: nls.localize('debugServer', "For debug extension development only: if a port is specified VS Code tries to connect to a debug adapter running in server mode"),
				default: 4711
			};
			properties['preLaunchTask'] = {
				type: ['string', 'null'],
				default: '',
				description: nls.localize('debugPrelaunchTask', "Task to run before debug session starts.")
			};
			properties['postDebugTask'] = {
				type: ['string', 'null'],
				default: '',
				description: nls.localize('debugPostDebugTask', "Task to run after debug session ends.")
			};
			properties['internalConsoleOptions'] = INTERNAL_CONSOLE_OPTIONS_SCHEMA;

			const osProperties = objects.deepClone(properties);
			properties['windows'] = {
				type: 'object',
				description: nls.localize('debugWindowsConfiguration', "Windows specific launch configuration attributes."),
				properties: osProperties
			};
			properties['osx'] = {
				type: 'object',
				description: nls.localize('debugOSXConfiguration', "OS X specific launch configuration attributes."),
				properties: osProperties
			};
			properties['linux'] = {
				type: 'object',
				description: nls.localize('debugLinuxConfiguration', "Linux specific launch configuration attributes."),
				properties: osProperties
			};
			Object.keys(attributes.properties).forEach(name => {
				// Use schema allOf property to get independent error reporting #21113
				attributes.properties[name].pattern = attributes.properties[name].pattern || '^(?!.*\\$\\{(env|config|command)\\.)';
				attributes.properties[name].patternErrorMessage = attributes.properties[name].patternErrorMessage ||
					nls.localize('deprecatedVariables', "'env.', 'config.' and 'command.' are deprecated, use 'env:', 'config:' and 'command:' instead.");
			});

			return attributes;
		});
	}
}

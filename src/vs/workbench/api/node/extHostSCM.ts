/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI, { UriComponents } from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { Event, Emitter, once } from 'vs/base/common/event';
import { debounce } from 'vs/base/common/decorators';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { asWinJsPromise } from 'vs/base/common/async';
import { IExtensionDescription } from 'vs/workbench/services/extensions/common/extensions';
import { ExtHostCommands } from 'vs/workbench/api/node/extHostCommands';
import { MainContext, MainThreadSCMShape, SCMRawResource, SCMRawResourceSplice, SCMRawResourceSplices, IMainContext, ExtHostSCMShape } from './extHost.protocol';
import { sortedDiff } from 'vs/base/common/arrays';
import { comparePaths } from 'vs/base/common/comparers';
import * as vscode from 'vscode';
import { ISplice } from 'vs/base/common/sequence';
import { ILogService } from 'vs/platform/log/common/log';

type ProviderHandle = number;
type GroupHandle = number;
type ResourceStateHandle = number;

function getIconPath(decorations: vscode.SourceControlResourceThemableDecorations) {
	if (!decorations) {
		return undefined;
	} else if (typeof decorations.iconPath === 'string') {
		return URI.file(decorations.iconPath).toString();
	} else if (decorations.iconPath) {
		return `${decorations.iconPath}`;
	}
	return undefined;
}

function compareResourceThemableDecorations(a: vscode.SourceControlResourceThemableDecorations, b: vscode.SourceControlResourceThemableDecorations): number {
	if (!a.iconPath && !b.iconPath) {
		return 0;
	} else if (!a.iconPath) {
		return -1;
	} else if (!b.iconPath) {
		return 1;
	}

	const aPath = typeof a.iconPath === 'string' ? a.iconPath : a.iconPath.fsPath;
	const bPath = typeof b.iconPath === 'string' ? b.iconPath : b.iconPath.fsPath;
	return comparePaths(aPath, bPath);
}

function compareResourceStatesDecorations(a: vscode.SourceControlResourceDecorations, b: vscode.SourceControlResourceDecorations): number {
	let result = 0;

	if (a.strikeThrough !== b.strikeThrough) {
		return a.strikeThrough ? 1 : -1;
	}

	if (a.faded !== b.faded) {
		return a.faded ? 1 : -1;
	}

	if (a.tooltip !== b.tooltip) {
		return (a.tooltip || '').localeCompare(b.tooltip);
	}

	result = compareResourceThemableDecorations(a, b);

	if (result !== 0) {
		return result;
	}

	if (a.light && b.light) {
		result = compareResourceThemableDecorations(a.light, b.light);
	} else if (a.light) {
		return 1;
	} else if (b.light) {
		return -1;
	}

	if (result !== 0) {
		return result;
	}

	if (a.dark && b.dark) {
		result = compareResourceThemableDecorations(a.dark, b.dark);
	} else if (a.dark) {
		return 1;
	} else if (b.dark) {
		return -1;
	}

	return result;
}

function compareResourceStates(a: vscode.SourceControlResourceState, b: vscode.SourceControlResourceState): number {
	let result = comparePaths(a.resourceUri.fsPath, b.resourceUri.fsPath, true);

	if (result !== 0) {
		return result;
	}

	if (a.decorations && b.decorations) {
		result = compareResourceStatesDecorations(a.decorations, b.decorations);
	} else if (a.decorations) {
		return 1;
	} else if (b.decorations) {
		return -1;
	}

	return result;
}

export interface IValidateInput {
	(value: string, cursorPosition: number): vscode.ProviderResult<vscode.SourceControlInputBoxValidation | undefined | null>;
}

export class ExtHostSCMInputBox implements vscode.SourceControlInputBox {

	private _value: string = '';

	get value(): string {
		return this._value;
	}

	set value(value: string) {
		this._proxy.$setInputBoxValue(this._sourceControlHandle, value);
		this.updateValue(value);
	}

	private _onDidChange = new Emitter<string>();

	get onDidChange(): Event<string> {
		return this._onDidChange.event;
	}

	private _placeholder: string = '';

	get placeholder(): string {
		return this._placeholder;
	}

	set placeholder(placeholder: string) {
		this._proxy.$setInputBoxPlaceholder(this._sourceControlHandle, placeholder);
		this._placeholder = placeholder;
	}

	private _validateInput: IValidateInput;

	get validateInput(): IValidateInput {
		if (!this._extension.enableProposedApi) {
			throw new Error(`[${this._extension.id}]: Proposed API is only available when running out of dev or with the following command line switch: --enable-proposed-api ${this._extension.id}`);
		}

		return this._validateInput;
	}

	set validateInput(fn: IValidateInput) {
		if (!this._extension.enableProposedApi) {
			throw new Error(`[${this._extension.id}]: Proposed API is only available when running out of dev or with the following command line switch: --enable-proposed-api ${this._extension.id}`);
		}

		if (fn && typeof fn !== 'function') {
			console.warn('Invalid SCM input box validation function');
			return;
		}

		this._validateInput = fn;
		this._proxy.$setValidationProviderIsEnabled(this._sourceControlHandle, !!fn);
	}

	constructor(private _extension: IExtensionDescription, private _proxy: MainThreadSCMShape, private _sourceControlHandle: number) {
		// noop
	}

	$onInputBoxValueChange(value: string): void {
		this.updateValue(value);
	}

	private updateValue(value: string): void {
		this._value = value;
		this._onDidChange.fire(value);
	}
}

class ExtHostSourceControlResourceGroup implements vscode.SourceControlResourceGroup {

	private static _handlePool: number = 0;
	private _resourceHandlePool: number = 0;
	private _resourceStates: vscode.SourceControlResourceState[] = [];

	private _resourceStatesMap: Map<ResourceStateHandle, vscode.SourceControlResourceState> = new Map<ResourceStateHandle, vscode.SourceControlResourceState>();
	private _resourceStatesCommandsMap: Map<ResourceStateHandle, vscode.Command> = new Map<ResourceStateHandle, vscode.Command>();

	private _onDidUpdateResourceStates = new Emitter<void>();
	readonly onDidUpdateResourceStates = this._onDidUpdateResourceStates.event;
	private _onDidDispose = new Emitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	private _handlesSnapshot: number[] = [];
	private _resourceSnapshot: vscode.SourceControlResourceState[] = [];

	get id(): string { return this._id; }

	get label(): string { return this._label; }
	set label(label: string) {
		this._label = label;
		this._proxy.$updateGroupLabel(this._sourceControlHandle, this.handle, label);
	}

	private _hideWhenEmpty: boolean | undefined = undefined;
	get hideWhenEmpty(): boolean | undefined { return this._hideWhenEmpty; }
	set hideWhenEmpty(hideWhenEmpty: boolean | undefined) {
		this._hideWhenEmpty = hideWhenEmpty;
		this._proxy.$updateGroup(this._sourceControlHandle, this.handle, { hideWhenEmpty });
	}

	get resourceStates(): vscode.SourceControlResourceState[] { return [...this._resourceStates]; }
	set resourceStates(resources: vscode.SourceControlResourceState[]) {
		this._resourceStates = [...resources];
		this._onDidUpdateResourceStates.fire();
	}

	readonly handle = ExtHostSourceControlResourceGroup._handlePool++;
	private _disposables: IDisposable[] = [];

	constructor(
		private _proxy: MainThreadSCMShape,
		private _commands: ExtHostCommands,
		private _sourceControlHandle: number,
		private _id: string,
		private _label: string,
	) {
		this._proxy.$registerGroup(_sourceControlHandle, this.handle, _id, _label);
	}

	getResourceState(handle: number): vscode.SourceControlResourceState | undefined {
		return this._resourceStatesMap.get(handle);
	}

	async $executeResourceCommand(handle: number): TPromise<void> {
		const command = this._resourceStatesCommandsMap.get(handle);

		if (!command) {
			return;
		}

		await this._commands.executeCommand(command.command, ...command.arguments);
	}

	_takeResourceStateSnapshot(): SCMRawResourceSplice[] {
		const snapshot = [...this._resourceStates].sort(compareResourceStates);
		const diffs = sortedDiff(this._resourceSnapshot, snapshot, compareResourceStates);

		const splices = diffs.map<ISplice<{ rawResource: SCMRawResource, handle: number }>>(diff => {
			const toInsert = diff.toInsert.map(r => {
				const handle = this._resourceHandlePool++;
				this._resourceStatesMap.set(handle, r);

				const sourceUri = r.resourceUri;
				const iconPath = getIconPath(r.decorations);
				const lightIconPath = r.decorations && getIconPath(r.decorations.light) || iconPath;
				const darkIconPath = r.decorations && getIconPath(r.decorations.dark) || iconPath;
				const icons: string[] = [];

				if (r.command) {
					this._resourceStatesCommandsMap.set(handle, r.command);
				}

				if (lightIconPath || darkIconPath) {
					icons.push(lightIconPath);
				}

				if (darkIconPath !== lightIconPath) {
					icons.push(darkIconPath);
				}

				const tooltip = (r.decorations && r.decorations.tooltip) || '';
				const strikeThrough = r.decorations && !!r.decorations.strikeThrough;
				const faded = r.decorations && !!r.decorations.faded;

				const source = r.decorations && r.decorations.source || undefined;
				const letter = r.decorations && r.decorations.letter || undefined;
				const color = r.decorations && r.decorations.color || undefined;

				const rawResource = [handle, <UriComponents>sourceUri, icons, tooltip, strikeThrough, faded, source, letter, color] as SCMRawResource;

				return { rawResource, handle };
			});

			return { start: diff.start, deleteCount: diff.deleteCount, toInsert };
		});

		const rawResourceSplices = splices
			.map(({ start, deleteCount, toInsert }) => [start, deleteCount, toInsert.map(i => i.rawResource)] as SCMRawResourceSplice);

		const reverseSplices = splices.reverse();

		for (const { start, deleteCount, toInsert } of reverseSplices) {
			const handles = toInsert.map(i => i.handle);
			const handlesToDelete = this._handlesSnapshot.splice(start, deleteCount, ...handles);

			for (const handle of handlesToDelete) {
				this._resourceStatesMap.delete(handle);
				this._resourceStatesCommandsMap.delete(handle);
			}
		}

		this._resourceSnapshot = snapshot;
		return rawResourceSplices;
	}

	dispose(): void {
		this._proxy.$unregisterGroup(this._sourceControlHandle, this.handle);
		this._disposables = dispose(this._disposables);
		this._onDidDispose.fire();
	}
}

class ExtHostSourceControl implements vscode.SourceControl {

	private static _handlePool: number = 0;
	private _groups: Map<GroupHandle, ExtHostSourceControlResourceGroup> = new Map<GroupHandle, ExtHostSourceControlResourceGroup>();

	get id(): string {
		return this._id;
	}

	get label(): string {
		return this._label;
	}

	get rootUri(): vscode.Uri | undefined {
		return this._rootUri;
	}

	private _inputBox: ExtHostSCMInputBox;
	get inputBox(): ExtHostSCMInputBox { return this._inputBox; }

	private _count: number | undefined = undefined;

	get count(): number | undefined {
		return this._count;
	}

	set count(count: number | undefined) {
		this._count = count;
		this._proxy.$updateSourceControl(this.handle, { count });
	}

	private _quickDiffProvider: vscode.QuickDiffProvider | undefined = undefined;

	get quickDiffProvider(): vscode.QuickDiffProvider | undefined {
		return this._quickDiffProvider;
	}

	set quickDiffProvider(quickDiffProvider: vscode.QuickDiffProvider | undefined) {
		this._quickDiffProvider = quickDiffProvider;
		this._proxy.$updateSourceControl(this.handle, { hasQuickDiffProvider: !!quickDiffProvider });
	}

	private _commitTemplate: string | undefined = undefined;

	get commitTemplate(): string | undefined {
		return this._commitTemplate;
	}

	set commitTemplate(commitTemplate: string | undefined) {
		this._commitTemplate = commitTemplate;
		this._proxy.$updateSourceControl(this.handle, { commitTemplate });
	}

	private _acceptInputCommand: vscode.Command | undefined = undefined;

	get acceptInputCommand(): vscode.Command | undefined {
		return this._acceptInputCommand;
	}

	set acceptInputCommand(acceptInputCommand: vscode.Command | undefined) {
		this._acceptInputCommand = acceptInputCommand;

		const internal = this._commands.converter.toInternal(acceptInputCommand);
		this._proxy.$updateSourceControl(this.handle, { acceptInputCommand: internal });
	}

	private _statusBarCommands: vscode.Command[] | undefined = undefined;

	get statusBarCommands(): vscode.Command[] | undefined {
		return this._statusBarCommands;
	}

	set statusBarCommands(statusBarCommands: vscode.Command[] | undefined) {
		this._statusBarCommands = statusBarCommands;

		const internal = (statusBarCommands || []).map(c => this._commands.converter.toInternal(c));
		this._proxy.$updateSourceControl(this.handle, { statusBarCommands: internal });
	}

	private handle: number = ExtHostSourceControl._handlePool++;

	constructor(
		_extension: IExtensionDescription,
		private _proxy: MainThreadSCMShape,
		private _commands: ExtHostCommands,
		private _id: string,
		private _label: string,
		private _rootUri?: vscode.Uri
	) {
		this._inputBox = new ExtHostSCMInputBox(_extension, this._proxy, this.handle);
		this._proxy.$registerSourceControl(this.handle, _id, _label, _rootUri);
	}

	private updatedResourceGroups = new Set<ExtHostSourceControlResourceGroup>();

	createResourceGroup(id: string, label: string): ExtHostSourceControlResourceGroup {
		const group = new ExtHostSourceControlResourceGroup(this._proxy, this._commands, this.handle, id, label);

		const updateListener = group.onDidUpdateResourceStates(() => {
			this.updatedResourceGroups.add(group);
			this.eventuallyUpdateResourceStates();
		});

		once(group.onDidDispose)(() => {
			this.updatedResourceGroups.delete(group);
			updateListener.dispose();
			this._groups.delete(group.handle);
		});

		this._groups.set(group.handle, group);
		return group;
	}

	@debounce(100)
	eventuallyUpdateResourceStates(): void {
		const splices: SCMRawResourceSplices[] = [];

		this.updatedResourceGroups.forEach(group => {
			const snapshot = group._takeResourceStateSnapshot();

			if (snapshot.length === 0) {
				return;
			}

			splices.push([group.handle, snapshot]);
		});

		if (splices.length > 0) {
			this._proxy.$spliceResourceStates(this.handle, splices);
		}

		this.updatedResourceGroups.clear();
	}

	getResourceGroup(handle: GroupHandle): ExtHostSourceControlResourceGroup | undefined {
		return this._groups.get(handle);
	}

	dispose(): void {
		this._groups.forEach(group => group.dispose());
		this._proxy.$unregisterSourceControl(this.handle);
	}
}

export class ExtHostSCM implements ExtHostSCMShape {

	private static _handlePool: number = 0;

	private _proxy: MainThreadSCMShape;
	private _sourceControls: Map<ProviderHandle, ExtHostSourceControl> = new Map<ProviderHandle, ExtHostSourceControl>();
	private _sourceControlsByExtension: Map<string, ExtHostSourceControl[]> = new Map<string, ExtHostSourceControl[]>();

	private _onDidChangeActiveProvider = new Emitter<vscode.SourceControl>();
	get onDidChangeActiveProvider(): Event<vscode.SourceControl> { return this._onDidChangeActiveProvider.event; }

	constructor(
		mainContext: IMainContext,
		private _commands: ExtHostCommands,
		@ILogService private logService: ILogService
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadSCM);

		_commands.registerArgumentProcessor({
			processArgument: arg => {
				if (arg && arg.$mid === 3) {
					const sourceControl = this._sourceControls.get(arg.sourceControlHandle);

					if (!sourceControl) {
						return arg;
					}

					const group = sourceControl.getResourceGroup(arg.groupHandle);

					if (!group) {
						return arg;
					}

					return group.getResourceState(arg.handle);
				} else if (arg && arg.$mid === 4) {
					const sourceControl = this._sourceControls.get(arg.sourceControlHandle);

					if (!sourceControl) {
						return arg;
					}

					return sourceControl.getResourceGroup(arg.groupHandle);
				} else if (arg && arg.$mid === 5) {
					const sourceControl = this._sourceControls.get(arg.handle);

					if (!sourceControl) {
						return arg;
					}

					return sourceControl;
				}

				return arg;
			}
		});
	}

	createSourceControl(extension: IExtensionDescription, id: string, label: string, rootUri: vscode.Uri | undefined): vscode.SourceControl {
		this.logService.trace('ExtHostSCM#createSourceControl', extension.id, id, label, rootUri);

		const handle = ExtHostSCM._handlePool++;
		const sourceControl = new ExtHostSourceControl(extension, this._proxy, this._commands, id, label, rootUri);
		this._sourceControls.set(handle, sourceControl);

		const sourceControls = this._sourceControlsByExtension.get(extension.id) || [];
		sourceControls.push(sourceControl);
		this._sourceControlsByExtension.set(extension.id, sourceControls);

		return sourceControl;
	}

	// Deprecated
	getLastInputBox(extension: IExtensionDescription): ExtHostSCMInputBox {
		this.logService.trace('ExtHostSCM#getLastInputBox', extension.id);

		const sourceControls = this._sourceControlsByExtension.get(extension.id);
		const sourceControl = sourceControls && sourceControls[sourceControls.length - 1];
		const inputBox = sourceControl && sourceControl.inputBox;

		return inputBox;
	}

	$provideOriginalResource(sourceControlHandle: number, uriComponents: UriComponents): TPromise<UriComponents> {
		const uri = URI.revive(uriComponents);
		this.logService.trace('ExtHostSCM#$provideOriginalResource', sourceControlHandle, uri.toString());

		const sourceControl = this._sourceControls.get(sourceControlHandle);

		if (!sourceControl || !sourceControl.quickDiffProvider) {
			return TPromise.as(null);
		}

		return asWinJsPromise(token => sourceControl.quickDiffProvider.provideOriginalResource(uri, token));
	}

	$onInputBoxValueChange(sourceControlHandle: number, value: string): TPromise<void> {
		this.logService.trace('ExtHostSCM#$onInputBoxValueChange', sourceControlHandle);

		const sourceControl = this._sourceControls.get(sourceControlHandle);

		if (!sourceControl) {
			return TPromise.as(null);
		}

		sourceControl.inputBox.$onInputBoxValueChange(value);
		return TPromise.as(null);
	}

	async $executeResourceCommand(sourceControlHandle: number, groupHandle: number, handle: number): TPromise<void> {
		this.logService.trace('ExtHostSCM#$executeResourceCommand', sourceControlHandle, groupHandle, handle);

		const sourceControl = this._sourceControls.get(sourceControlHandle);

		if (!sourceControl) {
			return;
		}

		const group = sourceControl.getResourceGroup(groupHandle);

		if (!group) {
			return;
		}

		await group.$executeResourceCommand(handle);
	}

	async $validateInput(sourceControlHandle: number, value: string, cursorPosition: number): TPromise<[string, number] | undefined> {
		this.logService.trace('ExtHostSCM#$validateInput', sourceControlHandle);

		const sourceControl = this._sourceControls.get(sourceControlHandle);

		if (!sourceControl) {
			return TPromise.as(undefined);
		}

		if (!sourceControl.inputBox.validateInput) {
			return TPromise.as(undefined);
		}

		const result = await sourceControl.inputBox.validateInput(value, cursorPosition);

		if (!result) {
			return TPromise.as(undefined);
		}

		return [result.message, result.type];
	}
}

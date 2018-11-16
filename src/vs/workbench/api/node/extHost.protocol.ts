/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { createMainContextProxyIdentifier as createMainId, createExtHostContextProxyIdentifier as createExtId, ProxyIdentifier, IRPCProtocol } from 'vs/workbench/services/extensions/node/proxyIdentifier';

import * as vscode from 'vscode';

import URI, { UriComponents } from 'vs/base/common/uri';
import Severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';

import { IMarkerData } from 'vs/platform/markers/common/markers';
import { EditorViewColumn } from 'vs/workbench/api/shared/editor';
import { IExtensionDescription } from 'vs/workbench/services/extensions/common/extensions';
import { StatusbarAlignment as MainThreadStatusBarAlignment } from 'vs/platform/statusbar/common/statusbar';
import { ITelemetryInfo } from 'vs/platform/telemetry/common/telemetry';
import { ICommandHandlerDescription } from 'vs/platform/commands/common/commands';
import { IProgressOptions, IProgressStep } from 'vs/platform/progress/common/progress';

import * as editorCommon from 'vs/editor/common/editorCommon';
import * as modes from 'vs/editor/common/modes';

import { IConfigurationData, ConfigurationTarget, IConfigurationModel } from 'vs/platform/configuration/common/configuration';
import { IConfig, IAdapterExecutable, ITerminalSettings } from 'vs/workbench/parts/debug/common/debug';

import { IPickOpenEntry, IPickOptions } from 'vs/platform/quickinput/common/quickInput';
import { SaveReason } from 'vs/workbench/services/textfile/common/textfiles';
import { TextEditorCursorStyle } from 'vs/editor/common/config/editorOptions';
import { EndOfLine, TextEditorLineNumbersStyle } from 'vs/workbench/api/node/extHostTypes';


import { TaskSet } from 'vs/workbench/parts/tasks/common/tasks';
import { IModelChangedEvent } from 'vs/editor/common/model/mirrorTextModel';
import { IPosition } from 'vs/editor/common/core/position';
import { IRange } from 'vs/editor/common/core/range';
import { ISelection, Selection } from 'vs/editor/common/core/selection';

import { ITreeItem } from 'vs/workbench/common/views';
import { ThemeColor } from 'vs/platform/theme/common/themeService';
import { IDisposable } from 'vs/base/common/lifecycle';
import { SerializedError } from 'vs/base/common/errors';
import { IStat, FileChangeType, IWatchOptions, FileSystemProviderCapabilities, FileWriteOptions, FileType, FileOverwriteOptions } from 'vs/platform/files/common/files';
import { ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { CommentRule, CharacterPair, EnterAction } from 'vs/editor/common/modes/languageConfiguration';
import { ISingleEditOperation } from 'vs/editor/common/model';
import { IPatternInfo, IRawSearchQuery, IRawFileMatch2, ISearchCompleteStats } from 'vs/platform/search/common/search';
import { LogLevel } from 'vs/platform/log/common/log';
import { TaskExecutionDTO, TaskDTO, TaskHandleDTO, TaskFilterDTO, TaskProcessStartedDTO, TaskProcessEndedDTO, TaskSystemInfoDTO } from 'vs/workbench/api/shared/tasks';

export interface IEnvironment {
	isExtensionDevelopmentDebug: boolean;
	appRoot: string;
	appSettingsHome: string;
	disableExtensions: boolean;
	extensionDevelopmentPath: string;
	extensionTestsPath: string;
}

export interface IWorkspaceData {
	id: string;
	name: string;
	folders: { uri: UriComponents, name: string, index: number }[];
	configuration?: UriComponents;
}

export interface IInitData {
	parentPid: number;
	environment: IEnvironment;
	workspace: IWorkspaceData;
	extensions: IExtensionDescription[];
	configuration: IConfigurationInitData;
	telemetryInfo: ITelemetryInfo;
	windowId: number;
	logLevel: LogLevel;
	logsPath: string;
}

export interface IConfigurationInitData extends IConfigurationData {
	configurationScopes: { [key: string]: ConfigurationScope };
}

export interface IWorkspaceConfigurationChangeEventData {
	changedConfiguration: IConfigurationModel;
	changedConfigurationByResource: { [folder: string]: IConfigurationModel };
}

export interface IExtHostContext extends IRPCProtocol {
}

export interface IMainContext extends IRPCProtocol {
}

// --- main thread

export interface MainThreadCommandsShape extends IDisposable {
	$registerCommand(id: string): void;
	$unregisterCommand(id: string): void;
	$executeCommand<T>(id: string, args: any[]): Thenable<T>;
	$getCommands(): Thenable<string[]>;
}

export interface MainThreadConfigurationShape extends IDisposable {
	$updateConfigurationOption(target: ConfigurationTarget, key: string, value: any, resource: UriComponents): TPromise<void>;
	$removeConfigurationOption(target: ConfigurationTarget, key: string, resource: UriComponents): TPromise<void>;
}

export interface MainThreadDiagnosticsShape extends IDisposable {
	$changeMany(owner: string, entries: [UriComponents, IMarkerData[]][]): void;
	$clear(owner: string): void;
}

export interface MainThreadDialogOpenOptions {
	defaultUri?: UriComponents;
	openLabel?: string;
	canSelectFiles?: boolean;
	canSelectFolders?: boolean;
	canSelectMany?: boolean;
	filters?: { [name: string]: string[] };
}

export interface MainThreadDialogSaveOptions {
	defaultUri?: UriComponents;
	saveLabel?: string;
	filters?: { [name: string]: string[] };
}

export interface MainThreadDiaglogsShape extends IDisposable {
	$showOpenDialog(options: MainThreadDialogOpenOptions): Thenable<string[]>;
	$showSaveDialog(options: MainThreadDialogSaveOptions): Thenable<string>;
}

export interface MainThreadDecorationsShape extends IDisposable {
	$registerDecorationProvider(handle: number, label: string): void;
	$unregisterDecorationProvider(handle: number): void;
	$onDidChange(handle: number, resources: UriComponents[]): void;
}

export interface MainThreadDocumentContentProvidersShape extends IDisposable {
	$registerTextContentProvider(handle: number, scheme: string): void;
	$unregisterTextContentProvider(handle: number): void;
	$onVirtualDocumentChange(uri: UriComponents, value: string): void;
}

export interface MainThreadDocumentsShape extends IDisposable {
	$tryCreateDocument(options?: { language?: string; content?: string; }): TPromise<UriComponents>;
	$tryOpenDocument(uri: UriComponents): TPromise<void>;
	$trySaveDocument(uri: UriComponents): TPromise<boolean>;
}

export interface ITextEditorConfigurationUpdate {
	tabSize?: number | 'auto';
	insertSpaces?: boolean | 'auto';
	cursorStyle?: TextEditorCursorStyle;
	lineNumbers?: TextEditorLineNumbersStyle;
}

export interface IResolvedTextEditorConfiguration {
	tabSize: number;
	insertSpaces: boolean;
	cursorStyle: TextEditorCursorStyle;
	lineNumbers: TextEditorLineNumbersStyle;
}

export enum TextEditorRevealType {
	Default = 0,
	InCenter = 1,
	InCenterIfOutsideViewport = 2,
	AtTop = 3
}

export interface IUndoStopOptions {
	undoStopBefore: boolean;
	undoStopAfter: boolean;
}

export interface IApplyEditsOptions extends IUndoStopOptions {
	setEndOfLine: EndOfLine;
}

export interface ITextDocumentShowOptions {
	position?: EditorViewColumn;
	preserveFocus?: boolean;
	pinned?: boolean;
	selection?: IRange;
}

export interface MainThreadTextEditorsShape extends IDisposable {
	$tryShowTextDocument(resource: UriComponents, options: ITextDocumentShowOptions): TPromise<string>;
	$registerTextEditorDecorationType(key: string, options: editorCommon.IDecorationRenderOptions): void;
	$removeTextEditorDecorationType(key: string): void;
	$tryShowEditor(id: string, position: EditorViewColumn): TPromise<void>;
	$tryHideEditor(id: string): TPromise<void>;
	$trySetOptions(id: string, options: ITextEditorConfigurationUpdate): TPromise<void>;
	$trySetDecorations(id: string, key: string, ranges: editorCommon.IDecorationOptions[]): TPromise<void>;
	$trySetDecorationsFast(id: string, key: string, ranges: number[]): TPromise<void>;
	$tryRevealRange(id: string, range: IRange, revealType: TextEditorRevealType): TPromise<void>;
	$trySetSelections(id: string, selections: ISelection[]): TPromise<void>;
	$tryApplyEdits(id: string, modelVersionId: number, edits: ISingleEditOperation[], opts: IApplyEditsOptions): TPromise<boolean>;
	$tryApplyWorkspaceEdit(workspaceEditDto: WorkspaceEditDto): TPromise<boolean>;
	$tryInsertSnippet(id: string, template: string, selections: IRange[], opts: IUndoStopOptions): TPromise<boolean>;
	$getDiffInformation(id: string): TPromise<editorCommon.ILineChange[]>;
}

export interface MainThreadTreeViewsShape extends IDisposable {
	$registerTreeViewDataProvider(treeViewId: string): void;
	$refresh(treeViewId: string, itemsToRefresh?: { [treeItemHandle: string]: ITreeItem }): TPromise<void>;
	$reveal(treeViewId: string, treeItem: ITreeItem, parentChain: ITreeItem[], options?: { select?: boolean }): TPromise<void>;
}

export interface MainThreadErrorsShape extends IDisposable {
	$onUnexpectedError(err: any | SerializedError): void;
}

export interface ISerializedRegExp {
	pattern: string;
	flags?: string;
}
export interface ISerializedIndentationRule {
	decreaseIndentPattern: ISerializedRegExp;
	increaseIndentPattern: ISerializedRegExp;
	indentNextLinePattern?: ISerializedRegExp;
	unIndentedLinePattern?: ISerializedRegExp;
}
export interface ISerializedOnEnterRule {
	beforeText: ISerializedRegExp;
	afterText?: ISerializedRegExp;
	action: EnterAction;
}
export interface ISerializedLanguageConfiguration {
	comments?: CommentRule;
	brackets?: CharacterPair[];
	wordPattern?: ISerializedRegExp;
	indentationRules?: ISerializedIndentationRule;
	onEnterRules?: ISerializedOnEnterRule[];
	__electricCharacterSupport?: {
		brackets?: any;
		docComment?: {
			scope: string;
			open: string;
			lineStart: string;
			close?: string;
		};
	};
	__characterPairSupport?: {
		autoClosingPairs: {
			open: string;
			close: string;
			notIn?: string[];
		}[];
	};
}

export interface ISerializedDocumentFilter {
	$serialized: true;
	language?: string;
	scheme?: string;
	pattern?: vscode.GlobPattern;
	exclusive?: boolean;
}

export interface MainThreadLanguageFeaturesShape extends IDisposable {
	$unregister(handle: number): void;
	$registerOutlineSupport(handle: number, selector: ISerializedDocumentFilter[], extensionId: string): void;
	$registerCodeLensSupport(handle: number, selector: ISerializedDocumentFilter[], eventHandle: number): void;
	$emitCodeLensEvent(eventHandle: number, event?: any): void;
	$registerDeclaractionSupport(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerImplementationSupport(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerTypeDefinitionSupport(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerHoverProvider(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerDocumentHighlightProvider(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerReferenceSupport(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerQuickFixSupport(handle: number, selector: ISerializedDocumentFilter[], supportedKinds?: string[]): void;
	$registerDocumentFormattingSupport(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerRangeFormattingSupport(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerOnTypeFormattingSupport(handle: number, selector: ISerializedDocumentFilter[], autoFormatTriggerCharacters: string[]): void;
	$registerNavigateTypeSupport(handle: number): void;
	$registerRenameSupport(handle: number, selector: ISerializedDocumentFilter[], supportsResolveInitialValues: boolean): void;
	$registerSuggestSupport(handle: number, selector: ISerializedDocumentFilter[], triggerCharacters: string[], supportsResolveDetails: boolean): void;
	$registerSignatureHelpProvider(handle: number, selector: ISerializedDocumentFilter[], triggerCharacter: string[]): void;
	$registerDocumentLinkProvider(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerDocumentColorProvider(handle: number, selector: ISerializedDocumentFilter[]): void;
	$registerFoldingRangeProvider(handle: number, selector: ISerializedDocumentFilter[]): void;
	$setLanguageConfiguration(handle: number, languageId: string, configuration: ISerializedLanguageConfiguration): void;
}

export interface MainThreadLanguagesShape extends IDisposable {
	$getLanguages(): TPromise<string[]>;
}

export interface MainThreadMessageOptions {
	extension?: IExtensionDescription;
	modal?: boolean;
}

export interface MainThreadMessageServiceShape extends IDisposable {
	$showMessage(severity: Severity, message: string, options: MainThreadMessageOptions, commands: { title: string; isCloseAffordance: boolean; handle: number; }[]): Thenable<number>;
}

export interface MainThreadOutputServiceShape extends IDisposable {
	$append(channelId: string, label: string, value: string): TPromise<void>;
	$clear(channelId: string, label: string): TPromise<void>;
	$dispose(channelId: string, label: string): TPromise<void>;
	$reveal(channelId: string, label: string, preserveFocus: boolean): TPromise<void>;
	$close(channelId: string): TPromise<void>;
}

export interface MainThreadProgressShape extends IDisposable {

	$startProgress(handle: number, options: IProgressOptions): void;
	$progressReport(handle: number, message: IProgressStep): void;
	$progressEnd(handle: number): void;
}

export interface MainThreadTerminalServiceShape extends IDisposable {
	$createTerminal(name?: string, shellPath?: string, shellArgs?: string[], cwd?: string, env?: { [key: string]: string }, waitOnExit?: boolean): TPromise<number>;
	$dispose(terminalId: number): void;
	$hide(terminalId: number): void;
	$sendText(terminalId: number, text: string, addNewLine: boolean): void;
	$show(terminalId: number, preserveFocus: boolean): void;
	$registerOnDataListener(terminalId: number): void;

	$sendProcessTitle(terminalId: number, title: string): void;
	$sendProcessData(terminalId: number, data: string): void;
	$sendProcessPid(terminalId: number, pid: number): void;
	$sendProcessExit(terminalId: number, exitCode: number): void;
}

export interface MyQuickPickItems extends IPickOpenEntry {
	handle: number;
}
export interface MainThreadQuickOpenShape extends IDisposable {
	$show(multiStepHandle: number | undefined, options: IPickOptions): TPromise<number | number[]>;
	$setItems(items: MyQuickPickItems[]): TPromise<any>;
	$setError(error: Error): TPromise<any>;
	$input(multiStepHandle: number | undefined, options: vscode.InputBoxOptions, validateInput: boolean): TPromise<string>;
	$multiStep(handle: number): TPromise<never>;
}

export interface MainThreadStatusBarShape extends IDisposable {
	$setEntry(id: number, extensionId: string, text: string, tooltip: string, command: string, color: string | ThemeColor, alignment: MainThreadStatusBarAlignment, priority: number): void;
	$dispose(id: number): void;
}

export interface MainThreadStorageShape extends IDisposable {
	$getValue<T>(shared: boolean, key: string): TPromise<T>;
	$setValue(shared: boolean, key: string, value: any): TPromise<void>;
}

export interface MainThreadTelemetryShape extends IDisposable {
	$publicLog(eventName: string, data?: any): void;
}

export type WebviewPanelHandle = string;

export interface MainThreadWebviewsShape extends IDisposable {
	$createWebviewPanel(handle: WebviewPanelHandle, viewType: string, title: string, viewOptions: { viewColumn: EditorViewColumn, preserveFocus: boolean }, options: vscode.WebviewPanelOptions & vscode.WebviewOptions, extensionLocation: UriComponents): void;
	$disposeWebview(handle: WebviewPanelHandle): void;
	$reveal(handle: WebviewPanelHandle, viewColumn: EditorViewColumn | null, preserveFocus: boolean): void;
	$setTitle(handle: WebviewPanelHandle, value: string): void;
	$setHtml(handle: WebviewPanelHandle, value: string): void;
	$postMessage(handle: WebviewPanelHandle, value: any): Thenable<boolean>;

	$registerSerializer(viewType: string): void;
	$unregisterSerializer(viewType: string): void;
}

export interface ExtHostWebviewsShape {
	$onMessage(handle: WebviewPanelHandle, message: any): void;
	$onDidChangeWebviewPanelViewState(handle: WebviewPanelHandle, active: boolean, position: EditorViewColumn): void;
	$onDidDisposeWebviewPanel(handle: WebviewPanelHandle): Thenable<void>;
	$deserializeWebviewPanel(newWebviewHandle: WebviewPanelHandle, viewType: string, title: string, state: any, position: EditorViewColumn, options: vscode.WebviewOptions): Thenable<void>;
}

export interface MainThreadUrlsShape extends IDisposable {
	$registerProtocolHandler(handle: number, extensionId: string): TPromise<void>;
	$unregisterProtocolHandler(handle: number): TPromise<void>;
}

export interface ExtHostUrlsShape {
	$handleExternalUri(handle: number, uri: UriComponents): TPromise<void>;
}

export interface MainThreadWorkspaceShape extends IDisposable {
	$startSearch(includePattern: string, includeFolder: string, excludePatternOrDisregardExcludes: string | false, maxResults: number, requestId: number): Thenable<UriComponents[]>;
	$cancelSearch(requestId: number): Thenable<boolean>;
	$saveAll(includeUntitled?: boolean): Thenable<boolean>;
	$updateWorkspaceFolders(extensionName: string, index: number, deleteCount: number, workspaceFoldersToAdd: { uri: UriComponents, name?: string }[]): Thenable<void>;
}

export interface IFileChangeDto {
	resource: UriComponents;
	type: FileChangeType;
}

export interface MainThreadFileSystemShape extends IDisposable {
	$registerFileSystemProvider(handle: number, scheme: string, capabilities: FileSystemProviderCapabilities): void;
	$unregisterProvider(handle: number): void;
	$onFileSystemChange(handle: number, resource: IFileChangeDto[]): void;
}

export interface MainThreadSearchShape extends IDisposable {
	$registerSearchProvider(handle: number, scheme: string): void;
	$unregisterProvider(handle: number): void;
	$handleFindMatch(handle: number, session: number, data: UriComponents | IRawFileMatch2[]): void;
	$handleTelemetry(eventName: string, data: any): void;
}

export interface MainThreadTaskShape extends IDisposable {
	$registerTaskProvider(handle: number): TPromise<void>;
	$unregisterTaskProvider(handle: number): TPromise<void>;
	$fetchTasks(filter?: TaskFilterDTO): TPromise<TaskDTO[]>;
	$executeTask(task: TaskHandleDTO | TaskDTO): TPromise<TaskExecutionDTO>;
	$terminateTask(id: string): TPromise<void>;
	$registerTaskSystem(scheme: string, info: TaskSystemInfoDTO): void;
}

export interface MainThreadExtensionServiceShape extends IDisposable {
	$localShowMessage(severity: Severity, msg: string): void;
	$onExtensionActivated(extensionId: string, startup: boolean, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationEvent: string): void;
	$onExtensionActivationFailed(extensionId: string): void;
	$onExtensionRuntimeError(extensionId: string, error: SerializedError): void;
	$addMessage(extensionId: string, severity: Severity, message: string): void;
}

export interface SCMProviderFeatures {
	hasQuickDiffProvider?: boolean;
	count?: number;
	commitTemplate?: string;
	acceptInputCommand?: modes.Command;
	statusBarCommands?: modes.Command[];
}

export interface SCMGroupFeatures {
	hideWhenEmpty?: boolean;
}

export type SCMRawResource = [
	number /*handle*/,
	UriComponents /*resourceUri*/,
	string[] /*icons: light, dark*/,
	string /*tooltip*/,
	boolean /*strike through*/,
	boolean /*faded*/,

	string | undefined /*source*/,
	string | undefined /*letter*/,
	ThemeColor | null /*color*/
];

export type SCMRawResourceSplice = [
	number /* start */,
	number /* delete count */,
	SCMRawResource[]
];

export type SCMRawResourceSplices = [
	number, /*handle*/
	SCMRawResourceSplice[]
];

export interface MainThreadSCMShape extends IDisposable {
	$registerSourceControl(handle: number, id: string, label: string, rootUri: UriComponents | undefined): void;
	$updateSourceControl(handle: number, features: SCMProviderFeatures): void;
	$unregisterSourceControl(handle: number): void;

	$registerGroup(sourceControlHandle: number, handle: number, id: string, label: string): void;
	$updateGroup(sourceControlHandle: number, handle: number, features: SCMGroupFeatures): void;
	$updateGroupLabel(sourceControlHandle: number, handle: number, label: string): void;
	$unregisterGroup(sourceControlHandle: number, handle: number): void;

	$spliceResourceStates(sourceControlHandle: number, splices: SCMRawResourceSplices[]): void;

	$setInputBoxValue(sourceControlHandle: number, value: string): void;
	$setInputBoxPlaceholder(sourceControlHandle: number, placeholder: string): void;
	$setValidationProviderIsEnabled(sourceControlHandle: number, enabled: boolean): void;
}

export type DebugSessionUUID = string;

export interface MainThreadDebugServiceShape extends IDisposable {
	$registerDebugTypes(debugTypes: string[]): void;
	$acceptDAMessage(handle: number, message: DebugProtocol.ProtocolMessage): void;
	$acceptDAError(handle: number, name: string, message: string, stack: string): void;
	$acceptDAExit(handle: number, code: number, signal: string): void;
	$registerDebugConfigurationProvider(type: string, hasProvideMethod: boolean, hasResolveMethod: boolean, hasDebugAdapterExecutable: boolean, handle: number): TPromise<any>;
	$unregisterDebugConfigurationProvider(handle: number): TPromise<any>;
	$startDebugging(folder: UriComponents | undefined, nameOrConfig: string | vscode.DebugConfiguration): TPromise<boolean>;
	$customDebugAdapterRequest(id: DebugSessionUUID, command: string, args: any): TPromise<any>;
	$appendDebugConsole(value: string): TPromise<any>;
	$startBreakpointEvents(): TPromise<any>;
	$registerBreakpoints(breakpoints: (ISourceMultiBreakpointDto | IFunctionBreakpointDto)[]): TPromise<void>;
	$unregisterBreakpoints(breakpointIds: string[], functionBreakpointIds: string[]): TPromise<void>;
}

export interface MainThreadWindowShape extends IDisposable {
	$getWindowVisibility(): TPromise<boolean>;
}

// -- extension host

export interface ExtHostCommandsShape {
	$executeContributedCommand<T>(id: string, ...args: any[]): Thenable<T>;
	$getContributedCommandHandlerDescriptions(): Thenable<{ [id: string]: string | ICommandHandlerDescription }>;
}

export interface ExtHostConfigurationShape {
	$acceptConfigurationChanged(data: IConfigurationData, eventData: IWorkspaceConfigurationChangeEventData): void;
}

export interface ExtHostDiagnosticsShape {

}

export interface ExtHostDocumentContentProvidersShape {
	$provideTextDocumentContent(handle: number, uri: UriComponents): TPromise<string>;
}

export interface IModelAddedData {
	uri: UriComponents;
	versionId: number;
	lines: string[];
	EOL: string;
	modeId: string;
	isDirty: boolean;
}
export interface ExtHostDocumentsShape {
	$acceptModelModeChanged(strURL: UriComponents, oldModeId: string, newModeId: string): void;
	$acceptModelSaved(strURL: UriComponents): void;
	$acceptDirtyStateChanged(strURL: UriComponents, isDirty: boolean): void;
	$acceptModelChanged(strURL: UriComponents, e: IModelChangedEvent, isDirty: boolean): void;
	$onDidRename(oldURL: UriComponents, newURL: UriComponents): void;
}

export interface ExtHostDocumentSaveParticipantShape {
	$participateInSave(resource: UriComponents, reason: SaveReason): Thenable<boolean[]>;
}

export interface ITextEditorAddData {
	id: string;
	documentUri: UriComponents;
	options: IResolvedTextEditorConfiguration;
	selections: ISelection[];
	visibleRanges: IRange[];
	editorPosition: EditorViewColumn;
}
export interface ITextEditorPositionData {
	[id: string]: EditorViewColumn;
}
export interface IEditorPropertiesChangeData {
	options: IResolvedTextEditorConfiguration | null;
	selections: ISelectionChangeEvent | null;
	visibleRanges: IRange[] | null;
}
export interface ISelectionChangeEvent {
	selections: Selection[];
	source?: string;
}

export interface ExtHostEditorsShape {
	$acceptEditorPropertiesChanged(id: string, props: IEditorPropertiesChangeData): void;
	$acceptEditorPositionData(data: ITextEditorPositionData): void;
}

export interface IDocumentsAndEditorsDelta {
	removedDocuments?: UriComponents[];
	addedDocuments?: IModelAddedData[];
	removedEditors?: string[];
	addedEditors?: ITextEditorAddData[];
	newActiveEditor?: string;
}

export interface ExtHostDocumentsAndEditorsShape {
	$acceptDocumentsAndEditorsDelta(delta: IDocumentsAndEditorsDelta): void;
}

export interface ExtHostTreeViewsShape {
	$getChildren(treeViewId: string, treeItemHandle?: string): TPromise<ITreeItem[]>;
	$setExpanded(treeViewId: string, treeItemHandle: string, expanded: boolean): void;
	$setSelection(treeViewId: string, treeItemHandles: string[]): void;
}

export interface ExtHostWorkspaceShape {
	$acceptWorkspaceData(workspace: IWorkspaceData): void;
}

export interface ExtHostFileSystemShape {
	$stat(handle: number, resource: UriComponents): TPromise<IStat>;
	$readdir(handle: number, resource: UriComponents): TPromise<[string, FileType][]>;
	$readFile(handle: number, resource: UriComponents): TPromise<string>;
	$writeFile(handle: number, resource: UriComponents, base64Encoded: string, opts: FileWriteOptions): TPromise<void>;
	$rename(handle: number, resource: UriComponents, target: UriComponents, opts: FileOverwriteOptions): TPromise<void>;
	$copy(handle: number, resource: UriComponents, target: UriComponents, opts: FileOverwriteOptions): TPromise<void>;
	$mkdir(handle: number, resource: UriComponents): TPromise<void>;
	$delete(handle: number, resource: UriComponents): TPromise<void>;
	$watch(handle: number, session: number, resource: UriComponents, opts: IWatchOptions): void;
	$unwatch(handle: number, session: number): void;
}

export interface ExtHostSearchShape {
	$provideFileSearchResults(handle: number, session: number, query: IRawSearchQuery): TPromise<ISearchCompleteStats>;
	$provideTextSearchResults(handle: number, session: number, pattern: IPatternInfo, query: IRawSearchQuery): TPromise<ISearchCompleteStats>;
}

export interface ExtHostExtensionServiceShape {
	$activateByEvent(activationEvent: string): TPromise<void>;
}

export interface FileSystemEvents {
	created: UriComponents[];
	changed: UriComponents[];
	deleted: UriComponents[];
}
export interface ExtHostFileSystemEventServiceShape {
	$onFileEvent(events: FileSystemEvents): void;
}

export interface ObjectIdentifier {
	$ident: number;
}

export namespace ObjectIdentifier {
	export const name = '$ident';
	export function mixin<T>(obj: T, id: number): T & ObjectIdentifier {
		Object.defineProperty(obj, name, { value: id, enumerable: true });
		return <T & ObjectIdentifier>obj;
	}
	export function of(obj: any): number {
		return obj[name];
	}
}

export interface ExtHostHeapServiceShape {
	$onGarbageCollection(ids: number[]): void;
}
export interface IRawColorInfo {
	color: [number, number, number, number];
	range: IRange;
}

export class IdObject {
	_id?: number;
	private static _n = 0;
	static mixin<T extends object>(object: T): T & IdObject {
		(<any>object)._id = IdObject._n++;
		return <any>object;
	}
}

export interface SuggestionDto extends modes.ISuggestion {
	_id: number;
	_parentId: number;
}

export interface SuggestResultDto extends IdObject {
	suggestions: SuggestionDto[];
	incomplete?: boolean;
}

export interface LocationDto {
	uri: UriComponents;
	range: IRange;
}

export interface SymbolInformationDto extends IdObject {
	name: string;
	containerName?: string;
	kind: modes.SymbolKind;
	location: LocationDto;
	definingRange: IRange;
	children?: SymbolInformationDto[];
}

export interface WorkspaceSymbolsDto extends IdObject {
	symbols: SymbolInformationDto[];
}

export interface ResourceFileEditDto {
	oldUri: UriComponents;
	newUri: UriComponents;
}

export interface ResourceTextEditDto {
	resource: UriComponents;
	modelVersionId?: number;
	edits: modes.TextEdit[];
}

export interface WorkspaceEditDto {
	edits: (ResourceFileEditDto | ResourceTextEditDto)[];

	// todo@joh reject should go into rename
	rejectReason?: string;
}

export function reviveWorkspaceEditDto(data: WorkspaceEditDto): modes.WorkspaceEdit {
	if (data && data.edits) {
		for (const edit of data.edits) {
			if (typeof (<ResourceTextEditDto>edit).resource === 'object') {
				(<ResourceTextEditDto>edit).resource = URI.revive((<ResourceTextEditDto>edit).resource);
			} else {
				(<ResourceFileEditDto>edit).newUri = URI.revive((<ResourceFileEditDto>edit).newUri);
				(<ResourceFileEditDto>edit).oldUri = URI.revive((<ResourceFileEditDto>edit).oldUri);
			}
		}
	}
	return <modes.WorkspaceEdit>data;
}

export interface CodeActionDto {
	title: string;
	edit?: WorkspaceEditDto;
	diagnostics?: IMarkerData[];
	command?: modes.Command;
	kind?: string;
}

export interface ExtHostLanguageFeaturesShape {
	$provideDocumentSymbols(handle: number, resource: UriComponents): TPromise<SymbolInformationDto[]>;
	$provideCodeLenses(handle: number, resource: UriComponents): TPromise<modes.ICodeLensSymbol[]>;
	$resolveCodeLens(handle: number, resource: UriComponents, symbol: modes.ICodeLensSymbol): TPromise<modes.ICodeLensSymbol>;
	$provideDefinition(handle: number, resource: UriComponents, position: IPosition): TPromise<LocationDto | LocationDto[]>;
	$provideImplementation(handle: number, resource: UriComponents, position: IPosition): TPromise<LocationDto | LocationDto[]>;
	$provideTypeDefinition(handle: number, resource: UriComponents, position: IPosition): TPromise<LocationDto | LocationDto[]>;
	$provideHover(handle: number, resource: UriComponents, position: IPosition): TPromise<modes.Hover>;
	$provideDocumentHighlights(handle: number, resource: UriComponents, position: IPosition): TPromise<modes.DocumentHighlight[]>;
	$provideReferences(handle: number, resource: UriComponents, position: IPosition, context: modes.ReferenceContext): TPromise<LocationDto[]>;
	$provideCodeActions(handle: number, resource: UriComponents, rangeOrSelection: IRange | ISelection, context: modes.CodeActionContext): TPromise<CodeActionDto[]>;
	$provideDocumentFormattingEdits(handle: number, resource: UriComponents, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]>;
	$provideDocumentRangeFormattingEdits(handle: number, resource: UriComponents, range: IRange, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]>;
	$provideOnTypeFormattingEdits(handle: number, resource: UriComponents, position: IPosition, ch: string, options: modes.FormattingOptions): TPromise<ISingleEditOperation[]>;
	$provideWorkspaceSymbols(handle: number, search: string): TPromise<WorkspaceSymbolsDto>;
	$resolveWorkspaceSymbol(handle: number, symbol: SymbolInformationDto): TPromise<SymbolInformationDto>;
	$releaseWorkspaceSymbols(handle: number, id: number): void;
	$provideRenameEdits(handle: number, resource: UriComponents, position: IPosition, newName: string): TPromise<WorkspaceEditDto>;
	$resolveRenameLocation(handle: number, resource: UriComponents, position: IPosition): TPromise<modes.RenameLocation>;
	$provideCompletionItems(handle: number, resource: UriComponents, position: IPosition, context: modes.SuggestContext): TPromise<SuggestResultDto>;
	$resolveCompletionItem(handle: number, resource: UriComponents, position: IPosition, suggestion: modes.ISuggestion): TPromise<modes.ISuggestion>;
	$releaseCompletionItems(handle: number, id: number): void;
	$provideSignatureHelp(handle: number, resource: UriComponents, position: IPosition): TPromise<modes.SignatureHelp>;
	$provideDocumentLinks(handle: number, resource: UriComponents): TPromise<modes.ILink[]>;
	$resolveDocumentLink(handle: number, link: modes.ILink): TPromise<modes.ILink>;
	$provideDocumentColors(handle: number, resource: UriComponents): TPromise<IRawColorInfo[]>;
	$provideColorPresentations(handle: number, resource: UriComponents, colorInfo: IRawColorInfo): TPromise<modes.IColorPresentation[]>;
	$provideFoldingRanges(handle: number, resource: UriComponents, context: modes.FoldingContext): TPromise<modes.FoldingRange[]>;
}

export interface ExtHostQuickOpenShape {
	$onItemSelected(handle: number): void;
	$validateInput(input: string): TPromise<string>;
}

export interface ShellLaunchConfigDto {
	name?: string;
	executable?: string;
	args?: string[] | string;
	cwd?: string;
	env?: { [key: string]: string };
}

export interface ExtHostTerminalServiceShape {
	$acceptTerminalClosed(id: number): void;
	$acceptTerminalOpened(id: number, name: string): void;
	$acceptTerminalProcessId(id: number, processId: number): void;
	$acceptTerminalProcessData(id: number, data: string): void;
	$createProcess(id: number, shellLaunchConfig: ShellLaunchConfigDto, cols: number, rows: number): void;
	$acceptProcessInput(id: number, data: string): void;
	$acceptProcessResize(id: number, cols: number, rows: number): void;
	$acceptProcessShutdown(id: number): void;
}

export interface ExtHostSCMShape {
	$provideOriginalResource(sourceControlHandle: number, uri: UriComponents): TPromise<UriComponents>;
	$onInputBoxValueChange(sourceControlHandle: number, value: string): TPromise<void>;
	$executeResourceCommand(sourceControlHandle: number, groupHandle: number, handle: number): TPromise<void>;
	$validateInput(sourceControlHandle: number, value: string, cursorPosition: number): TPromise<[string, number] | undefined>;
}

export interface ExtHostTaskShape {
	$provideTasks(handle: number): TPromise<TaskSet>;
	$onDidStartTask(execution: TaskExecutionDTO): void;
	$onDidStartTaskProcess(value: TaskProcessStartedDTO): void;
	$onDidEndTaskProcess(value: TaskProcessEndedDTO): void;
	$OnDidEndTask(execution: TaskExecutionDTO): void;
	$resolveVariables(workspaceFolder: URI, variables: string[]): TPromise<any>;
}

export interface IBreakpointDto {
	type: string;
	id?: string;
	enabled: boolean;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
}

export interface IFunctionBreakpointDto extends IBreakpointDto {
	type: 'function';
	functionName: string;
}

export interface ISourceBreakpointDto extends IBreakpointDto {
	type: 'source';
	uri: UriComponents;
	line: number;
	character: number;
}

export interface IBreakpointsDeltaDto {
	added?: (ISourceBreakpointDto | IFunctionBreakpointDto)[];
	removed?: string[];
	changed?: (ISourceBreakpointDto | IFunctionBreakpointDto)[];
}

export interface ISourceMultiBreakpointDto {
	type: 'sourceMulti';
	uri: UriComponents;
	lines: {
		id: string;
		enabled: boolean;
		condition?: string;
		hitCondition?: string;
		logMessage?: string;
		line: number;
		character: number;
	}[];
}

export interface ExtHostDebugServiceShape {
	$substituteVariables(folder: UriComponents | undefined, config: IConfig): TPromise<IConfig>;
	$runInTerminal(args: DebugProtocol.RunInTerminalRequestArguments, config: ITerminalSettings): TPromise<void>;
	$isTerminalBusy(processId: number): TPromise<boolean>;
	$prepareCommandForTerminal(args: DebugProtocol.RunInTerminalRequestArguments, config: ITerminalSettings): TPromise<any>;
	$startDASession(handle: number, debugType: string, adapterExecutableInfo: IAdapterExecutable | null, debugPort: number): TPromise<void>;
	$stopDASession(handle: number): TPromise<void>;
	$sendDAMessage(handle: number, message: DebugProtocol.ProtocolMessage): TPromise<void>;
	$resolveDebugConfiguration(handle: number, folder: UriComponents | undefined, debugConfiguration: IConfig): TPromise<IConfig>;
	$provideDebugConfigurations(handle: number, folder: UriComponents | undefined): TPromise<IConfig[]>;
	$debugAdapterExecutable(handle: number, folder: UriComponents | undefined): TPromise<IAdapterExecutable>;
	$acceptDebugSessionStarted(id: DebugSessionUUID, type: string, name: string): void;
	$acceptDebugSessionTerminated(id: DebugSessionUUID, type: string, name: string): void;
	$acceptDebugSessionActiveChanged(id: DebugSessionUUID | undefined, type?: string, name?: string): void;
	$acceptDebugSessionCustomEvent(id: DebugSessionUUID, type: string, name: string, event: any): void;
	$acceptBreakpointsDelta(delat: IBreakpointsDeltaDto): void;
}


export interface DecorationRequest {
	readonly id: number;
	readonly handle: number;
	readonly uri: UriComponents;
}

export type DecorationData = [number, boolean, string, string, ThemeColor, string];
export type DecorationReply = { [id: number]: DecorationData };

export interface ExtHostDecorationsShape {
	$provideDecorations(requests: DecorationRequest[]): TPromise<DecorationReply>;
}

export interface ExtHostWindowShape {
	$onDidChangeWindowFocus(value: boolean): void;
}

export interface ExtHostLogServiceShape {
	$setLevel(level: LogLevel): void;
}

export interface ExtHostProgressShape {
	$acceptProgressCanceled(handle: number): void;
}

// --- proxy identifiers

export const MainContext = {
	MainThreadCommands: <ProxyIdentifier<MainThreadCommandsShape>>createMainId<MainThreadCommandsShape>('MainThreadCommands'),
	MainThreadConfiguration: createMainId<MainThreadConfigurationShape>('MainThreadConfiguration'),
	MainThreadDebugService: createMainId<MainThreadDebugServiceShape>('MainThreadDebugService'),
	MainThreadDecorations: createMainId<MainThreadDecorationsShape>('MainThreadDecorations'),
	MainThreadDiagnostics: createMainId<MainThreadDiagnosticsShape>('MainThreadDiagnostics'),
	MainThreadDialogs: createMainId<MainThreadDiaglogsShape>('MainThreadDiaglogs'),
	MainThreadDocuments: createMainId<MainThreadDocumentsShape>('MainThreadDocuments'),
	MainThreadDocumentContentProviders: createMainId<MainThreadDocumentContentProvidersShape>('MainThreadDocumentContentProviders'),
	MainThreadTextEditors: createMainId<MainThreadTextEditorsShape>('MainThreadTextEditors'),
	MainThreadErrors: createMainId<MainThreadErrorsShape>('MainThreadErrors'),
	MainThreadTreeViews: createMainId<MainThreadTreeViewsShape>('MainThreadTreeViews'),
	MainThreadLanguageFeatures: createMainId<MainThreadLanguageFeaturesShape>('MainThreadLanguageFeatures'),
	MainThreadLanguages: createMainId<MainThreadLanguagesShape>('MainThreadLanguages'),
	MainThreadMessageService: createMainId<MainThreadMessageServiceShape>('MainThreadMessageService'),
	MainThreadOutputService: createMainId<MainThreadOutputServiceShape>('MainThreadOutputService'),
	MainThreadProgress: createMainId<MainThreadProgressShape>('MainThreadProgress'),
	MainThreadQuickOpen: createMainId<MainThreadQuickOpenShape>('MainThreadQuickOpen'),
	MainThreadStatusBar: createMainId<MainThreadStatusBarShape>('MainThreadStatusBar'),
	MainThreadStorage: createMainId<MainThreadStorageShape>('MainThreadStorage'),
	MainThreadTelemetry: createMainId<MainThreadTelemetryShape>('MainThreadTelemetry'),
	MainThreadTerminalService: createMainId<MainThreadTerminalServiceShape>('MainThreadTerminalService'),
	MainThreadWebviews: createMainId<MainThreadWebviewsShape>('MainThreadWebviews'),
	MainThreadUrls: createMainId<MainThreadUrlsShape>('MainThreadUrls'),
	MainThreadWorkspace: createMainId<MainThreadWorkspaceShape>('MainThreadWorkspace'),
	MainThreadFileSystem: createMainId<MainThreadFileSystemShape>('MainThreadFileSystem'),
	MainThreadExtensionService: createMainId<MainThreadExtensionServiceShape>('MainThreadExtensionService'),
	MainThreadSCM: createMainId<MainThreadSCMShape>('MainThreadSCM'),
	MainThreadSearch: createMainId<MainThreadSearchShape>('MainThreadSearch'),
	MainThreadTask: createMainId<MainThreadTaskShape>('MainThreadTask'),
	MainThreadWindow: createMainId<MainThreadWindowShape>('MainThreadWindow'),
};

export const ExtHostContext = {
	ExtHostCommands: createExtId<ExtHostCommandsShape>('ExtHostCommands'),
	ExtHostConfiguration: createExtId<ExtHostConfigurationShape>('ExtHostConfiguration'),
	ExtHostDiagnostics: createExtId<ExtHostDiagnosticsShape>('ExtHostDiagnostics'),
	ExtHostDebugService: createExtId<ExtHostDebugServiceShape>('ExtHostDebugService'),
	ExtHostDecorations: createExtId<ExtHostDecorationsShape>('ExtHostDecorations'),
	ExtHostDocumentsAndEditors: createExtId<ExtHostDocumentsAndEditorsShape>('ExtHostDocumentsAndEditors'),
	ExtHostDocuments: createExtId<ExtHostDocumentsShape>('ExtHostDocuments'),
	ExtHostDocumentContentProviders: createExtId<ExtHostDocumentContentProvidersShape>('ExtHostDocumentContentProviders'),
	ExtHostDocumentSaveParticipant: createExtId<ExtHostDocumentSaveParticipantShape>('ExtHostDocumentSaveParticipant'),
	ExtHostEditors: createExtId<ExtHostEditorsShape>('ExtHostEditors'),
	ExtHostTreeViews: createExtId<ExtHostTreeViewsShape>('ExtHostTreeViews'),
	ExtHostFileSystem: createExtId<ExtHostFileSystemShape>('ExtHostFileSystem'),
	ExtHostFileSystemEventService: createExtId<ExtHostFileSystemEventServiceShape>('ExtHostFileSystemEventService'),
	ExtHostHeapService: createExtId<ExtHostHeapServiceShape>('ExtHostHeapMonitor'),
	ExtHostLanguageFeatures: createExtId<ExtHostLanguageFeaturesShape>('ExtHostLanguageFeatures'),
	ExtHostQuickOpen: createExtId<ExtHostQuickOpenShape>('ExtHostQuickOpen'),
	ExtHostExtensionService: createExtId<ExtHostExtensionServiceShape>('ExtHostExtensionService'),
	ExtHostLogService: createExtId<ExtHostLogServiceShape>('ExtHostLogService'),
	ExtHostTerminalService: createExtId<ExtHostTerminalServiceShape>('ExtHostTerminalService'),
	ExtHostSCM: createExtId<ExtHostSCMShape>('ExtHostSCM'),
	ExtHostSearch: createExtId<ExtHostSearchShape>('ExtHostSearch'),
	ExtHostTask: createExtId<ExtHostTaskShape>('ExtHostTask'),
	ExtHostWorkspace: createExtId<ExtHostWorkspaceShape>('ExtHostWorkspace'),
	ExtHostWindow: createExtId<ExtHostWindowShape>('ExtHostWindow'),
	ExtHostWebviews: createExtId<ExtHostWebviewsShape>('ExtHostWebviews'),
	ExtHostUrls: createExtId<ExtHostUrlsShape>('ExtHostUrls'),
	ExtHostProgress: createMainId<ExtHostProgressShape>('ExtHostProgress')
};

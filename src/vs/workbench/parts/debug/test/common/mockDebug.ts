/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import uri from 'vs/base/common/uri';
import { Event, Emitter } from 'vs/base/common/event';
import { TPromise } from 'vs/base/common/winjs.base';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { ILaunch, IDebugService, State, DebugEvent, ISession, IConfigurationManager, IStackFrame, IBreakpointData, IBreakpointUpdateData, IConfig, IModel, IViewModel, IRawSession, IBreakpoint } from 'vs/workbench/parts/debug/common/debug';

export class MockDebugService implements IDebugService {
	public _serviceBrand: any;

	public get state(): State {
		return null;
	}

	public get onDidCustomEvent(): Event<DebugEvent> {
		return null;
	}

	public get onDidNewSession(): Event<ISession> {
		return null;
	}

	public get onDidEndSession(): Event<ISession> {
		return null;
	}

	public get onDidChangeState(): Event<State> {
		return null;
	}

	public getConfigurationManager(): IConfigurationManager {
		return null;
	}

	public focusStackFrame(focusedStackFrame: IStackFrame): void {
	}

	public addBreakpoints(uri: uri, rawBreakpoints: IBreakpointData[]): TPromise<IBreakpoint[]> {
		return TPromise.as(null);
	}

	public updateBreakpoints(uri: uri, data: { [id: string]: IBreakpointUpdateData }, sendOnResourceSaved: boolean): void { }

	public enableOrDisableBreakpoints(enabled: boolean): TPromise<void> {
		return TPromise.as(null);
	}

	public setBreakpointsActivated(): TPromise<void> {
		return TPromise.as(null);
	}

	public removeBreakpoints(): TPromise<any> {
		return TPromise.as(null);
	}

	public addFunctionBreakpoint(): void { }

	public moveWatchExpression(id: string, position: number): void { }

	public renameFunctionBreakpoint(id: string, newFunctionName: string): TPromise<void> {
		return TPromise.as(null);
	}

	public removeFunctionBreakpoints(id?: string): TPromise<void> {
		return TPromise.as(null);
	}

	public addReplExpression(name: string): TPromise<void> {
		return TPromise.as(null);
	}

	public removeReplExpressions(): void { }

	public addWatchExpression(name?: string): TPromise<void> {
		return TPromise.as(null);
	}

	public renameWatchExpression(id: string, newName: string): TPromise<void> {
		return TPromise.as(null);
	}

	public removeWatchExpressions(id?: string): void { }

	public startDebugging(launch: ILaunch, configOrName?: IConfig | string, noDebug?: boolean): TPromise<any> {
		return TPromise.as(null);
	}

	public restartSession(): TPromise<any> {
		return TPromise.as(null);
	}

	public stopSession(): TPromise<any> {
		return TPromise.as(null);
	}

	public getModel(): IModel {
		return null;
	}

	public getViewModel(): IViewModel {
		return null;
	}

	public logToRepl(value: string): void { }

	public sourceIsNotAvailable(uri: uri): void { }
}

export class MockSession implements IRawSession {

	public readyForBreakpoints = true;
	public emittedStopped = true;

	public getId() {
		return 'mockrawsession';
	}

	public root: IWorkspaceFolder;

	public getLengthInSeconds(): number {
		return 100;
	}

	public stackTrace(args: DebugProtocol.StackTraceArguments): TPromise<DebugProtocol.StackTraceResponse> {
		return TPromise.as({
			seq: 1,
			type: 'response',
			request_seq: 1,
			success: true,
			command: 'stackTrace',
			body: {
				stackFrames: [{
					id: 1,
					name: 'mock',
					line: 5,
					column: 6
				}]
			}
		});
	}

	public exceptionInfo(args: DebugProtocol.ExceptionInfoArguments): TPromise<DebugProtocol.ExceptionInfoResponse> {
		return TPromise.as(null);
	}

	public attach(args: DebugProtocol.AttachRequestArguments): TPromise<DebugProtocol.AttachResponse> {
		return TPromise.as(null);
	}

	public scopes(args: DebugProtocol.ScopesArguments): TPromise<DebugProtocol.ScopesResponse> {
		return TPromise.as(null);
	}

	public variables(args: DebugProtocol.VariablesArguments): TPromise<DebugProtocol.VariablesResponse> {
		return TPromise.as(null);
	}

	evaluate(args: DebugProtocol.EvaluateArguments): TPromise<DebugProtocol.EvaluateResponse> {
		return TPromise.as(null);
	}

	public get capabilities(): DebugProtocol.Capabilities {
		return {};
	}

	public get onDidEvent(): Event<DebugEvent> {
		return null;
	}

	public get onDidInitialize(): Event<DebugProtocol.InitializedEvent> {
		const emitter = new Emitter<DebugProtocol.InitializedEvent>();
		return emitter.event;
	}

	public get onDidExitAdapter(): Event<{ sessionId: string }> {
		const emitter = new Emitter<{ sessionId: string }>();
		return emitter.event;
	}


	public custom(request: string, args: any): TPromise<DebugProtocol.Response> {
		return TPromise.as(null);
	}

	public disconnect(restart?: boolean, force?: boolean): TPromise<DebugProtocol.DisconnectResponse> {
		return TPromise.as(null);
	}

	public threads(): TPromise<DebugProtocol.ThreadsResponse> {
		return TPromise.as(null);
	}

	public stepIn(args: DebugProtocol.StepInArguments): TPromise<DebugProtocol.StepInResponse> {
		return TPromise.as(null);
	}

	public stepOut(args: DebugProtocol.StepOutArguments): TPromise<DebugProtocol.StepOutResponse> {
		return TPromise.as(null);
	}

	public stepBack(args: DebugProtocol.StepBackArguments): TPromise<DebugProtocol.StepBackResponse> {
		return TPromise.as(null);
	}

	public continue(args: DebugProtocol.ContinueArguments): TPromise<DebugProtocol.ContinueResponse> {
		return TPromise.as(null);
	}

	public reverseContinue(args: DebugProtocol.ReverseContinueArguments): TPromise<DebugProtocol.ReverseContinueResponse> {
		return TPromise.as(null);
	}

	public pause(args: DebugProtocol.PauseArguments): TPromise<DebugProtocol.PauseResponse> {
		return TPromise.as(null);
	}

	public terminateThreads(args: DebugProtocol.TerminateThreadsArguments): TPromise<DebugProtocol.TerminateThreadsResponse, any> {
		return TPromise.as(null);
	}

	public setVariable(args: DebugProtocol.SetVariableArguments): TPromise<DebugProtocol.SetVariableResponse> {
		return TPromise.as(null);
	}

	public restartFrame(args: DebugProtocol.RestartFrameArguments): TPromise<DebugProtocol.RestartFrameResponse> {
		return TPromise.as(null);
	}

	public completions(args: DebugProtocol.CompletionsArguments): TPromise<DebugProtocol.CompletionsResponse> {
		return TPromise.as(null);
	}

	public next(args: DebugProtocol.NextArguments): TPromise<DebugProtocol.NextResponse> {
		return TPromise.as(null);
	}

	public source(args: DebugProtocol.SourceArguments): TPromise<DebugProtocol.SourceResponse> {
		return TPromise.as(null);
	}

	public setBreakpoints(args: DebugProtocol.SetBreakpointsArguments): TPromise<DebugProtocol.SetBreakpointsResponse> {
		return TPromise.as(null);
	}

	public setFunctionBreakpoints(args: DebugProtocol.SetFunctionBreakpointsArguments): TPromise<DebugProtocol.SetFunctionBreakpointsResponse> {
		return TPromise.as(null);
	}

	public setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments): TPromise<DebugProtocol.SetExceptionBreakpointsResponse> {
		return TPromise.as(null);
	}

	public readonly onDidStop: Event<DebugProtocol.StoppedEvent> = null;
}

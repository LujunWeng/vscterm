/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Action } from 'vs/base/common/actions';
import * as lifecycle from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IFileService } from 'vs/platform/files/common/files';
import { IDebugService, State, ISession, IThread, IEnablement, IBreakpoint, IStackFrame, REPL_ID, SessionState }
	from 'vs/workbench/parts/debug/common/debug';
import { Variable, Expression, Thread, Breakpoint, Session } from 'vs/workbench/parts/debug/common/debugModel';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { TogglePanelAction } from 'vs/workbench/browser/panel';
import { IQuickOpenService } from 'vs/platform/quickOpen/common/quickOpen';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { CollapseAction } from 'vs/workbench/browser/viewlet';
import { ITree } from 'vs/base/parts/tree/browser/tree';
import { first } from 'vs/base/common/arrays';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { memoize } from 'vs/base/common/decorators';

export abstract class AbstractDebugAction extends Action {

	protected toDispose: lifecycle.IDisposable[];

	constructor(
		id: string, label: string, cssClass: string,
		@IDebugService protected debugService: IDebugService,
		@IKeybindingService protected keybindingService: IKeybindingService,
		public weight?: number
	) {
		super(id, label, cssClass, false);
		this.toDispose = [];
		this.toDispose.push(this.debugService.onDidChangeState(state => this.updateEnablement(state)));

		this.updateLabel(label);
		this.updateEnablement();
	}

	public run(e?: any): TPromise<any> {
		throw new Error('implement me');
	}

	public get tooltip(): string {
		const keybinding = this.keybindingService.lookupKeybinding(this.id);
		const keybindingLabel = keybinding && keybinding.getLabel();

		return keybindingLabel ? `${this.label} (${keybindingLabel})` : this.label;
	}

	protected updateLabel(newLabel: string): void {
		this.label = newLabel;
	}

	protected updateEnablement(state = this.debugService.state): void {
		this.enabled = this.isEnabled(state);
	}

	protected isEnabled(state: State): boolean {
		return true;
	}

	public dispose(): void {
		super.dispose();
		this.toDispose = lifecycle.dispose(this.toDispose);
	}
}

export class ConfigureAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.configure';
	static LABEL = nls.localize('openLaunchJson', "Open {0}", 'launch.json');

	constructor(id: string, label: string,
		@IDebugService debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService private notificationService: INotificationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService
	) {
		super(id, label, 'debug-action configure', debugService, keybindingService);
		this.toDispose.push(debugService.getConfigurationManager().onDidSelectConfiguration(() => this.updateClass()));
		this.updateClass();
	}

	public get tooltip(): string {
		if (this.debugService.getConfigurationManager().selectedConfiguration.name) {
			return ConfigureAction.LABEL;
		}

		return nls.localize('launchJsonNeedsConfigurtion', "Configure or Fix 'launch.json'");
	}

	private updateClass(): void {
		this.class = this.debugService.getConfigurationManager().selectedConfiguration.name ? 'debug-action configure' : 'debug-action configure notification';
	}

	public run(event?: any): TPromise<any> {
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.notificationService.info(nls.localize('noFolderDebugConfig', "Please first open a folder in order to do advanced debug configuration."));
			return TPromise.as(null);
		}

		const sideBySide = !!(event && (event.ctrlKey || event.metaKey));
		const configurationManager = this.debugService.getConfigurationManager();
		if (!configurationManager.selectedConfiguration.launch) {
			configurationManager.selectConfiguration(configurationManager.getLaunches()[0]);
		}

		return configurationManager.selectedConfiguration.launch.openConfigFile(sideBySide);
	}
}

export class StartAction extends AbstractDebugAction {
	static ID = 'workbench.action.debug.start';
	static LABEL = nls.localize('startDebug', "Start Debugging");

	constructor(id: string, label: string,
		@IDebugService debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IHistoryService private historyService: IHistoryService
	) {
		super(id, label, 'debug-action start', debugService, keybindingService);

		this.toDispose.push(this.debugService.getConfigurationManager().onDidSelectConfiguration(() => this.updateEnablement()));
		this.toDispose.push(this.debugService.getModel().onDidChangeCallStack(() => this.updateEnablement()));
		this.toDispose.push(this.contextService.onDidChangeWorkbenchState(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		const configurationManager = this.debugService.getConfigurationManager();
		let launch = configurationManager.selectedConfiguration.launch;
		if (!launch) {
			const rootUri = this.historyService.getLastActiveWorkspaceRoot();
			launch = configurationManager.getLaunch(rootUri);
			if (!launch || launch.getConfigurationNames().length === 0) {
				const launches = configurationManager.getLaunches();
				launch = first(launches, l => !!l.getConfigurationNames().length, launches.length ? launches[0] : launch);
			}

			configurationManager.selectConfiguration(launch);
		}

		return this.debugService.startDebugging(launch, undefined, this.isNoDebug());
	}

	protected isNoDebug(): boolean {
		return false;
	}

	public static isEnabled(debugService: IDebugService, contextService: IWorkspaceContextService, configName: string) {
		const sessions = debugService.getModel().getSessions();
		const launch = debugService.getConfigurationManager().selectedConfiguration.launch;

		if (debugService.state === State.Initializing) {
			return false;
		}
		if (contextService && contextService.getWorkbenchState() === WorkbenchState.EMPTY && sessions.length > 0) {
			return false;
		}
		if (sessions.some(p => p.getName(false) === configName && (!launch || !launch.workspace || !p.raw.root || p.raw.root.uri.toString() === launch.workspace.uri.toString()))) {
			return false;
		}
		const compound = launch && launch.getCompound(configName);
		if (compound && compound.configurations && sessions.some(p => compound.configurations.indexOf(p.getName(false)) !== -1)) {
			return false;
		}

		return true;
	}

	// Disabled if the launch drop down shows the launch config that is already running.
	protected isEnabled(state: State): boolean {
		return StartAction.isEnabled(this.debugService, this.contextService, this.debugService.getConfigurationManager().selectedConfiguration.name);
	}
}

export class RunAction extends StartAction {
	static readonly ID = 'workbench.action.debug.run';
	static LABEL = nls.localize('startWithoutDebugging', "Start Without Debugging");

	protected isNoDebug(): boolean {
		return true;
	}
}

export class SelectAndStartAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.selectandstart';
	static LABEL = nls.localize('selectAndStartDebugging', "Select and Start Debugging");

	constructor(id: string, label: string,
		@IDebugService debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IFileService fileService: IFileService,
		@IQuickOpenService private quickOpenService: IQuickOpenService
	) {
		super(id, label, undefined, debugService, keybindingService);
		this.quickOpenService = quickOpenService;
	}

	public run(): TPromise<any> {
		return this.quickOpenService.show('debug ');
	}
}

export class RestartAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.restart';
	static LABEL = nls.localize('restartDebug', "Restart");
	static RECONNECT_LABEL = nls.localize('reconnectDebug', "Reconnect");

	constructor(id: string, label: string,
		@IDebugService debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IHistoryService private historyService: IHistoryService
	) {
		super(id, label, 'debug-action restart', debugService, keybindingService, 70);
		this.setLabel(this.debugService.getViewModel().focusedSession);
		this.toDispose.push(this.debugService.getViewModel().onDidFocusStackFrame(() => this.setLabel(this.debugService.getViewModel().focusedSession)));
	}

	@memoize
	private get startAction(): StartAction {
		return new StartAction(StartAction.ID, StartAction.LABEL, this.debugService, this.keybindingService, this.contextService, this.historyService);
	}

	private setLabel(session: ISession): void {
		this.updateLabel(session && session.state === SessionState.ATTACH ? RestartAction.RECONNECT_LABEL : RestartAction.LABEL);
	}

	public run(session: ISession): TPromise<any> {
		if (!(session instanceof Session)) {
			session = this.debugService.getViewModel().focusedSession;
		}

		if (!session) {
			return this.startAction.run();
		}

		if (this.debugService.getModel().getSessions().length <= 1) {
			this.debugService.removeReplExpressions();
		}
		return this.debugService.restartSession(session);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && (
			state === State.Running ||
			state === State.Stopped ||
			StartAction.isEnabled(this.debugService, this.contextService, this.debugService.getConfigurationManager().selectedConfiguration.name)
		);
	}
}

export class StepOverAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.stepOver';
	static LABEL = nls.localize('stepOverDebug', "Step Over");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action step-over', debugService, keybindingService, 20);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.next() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && state === State.Stopped;
	}
}

export class StepIntoAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.stepInto';
	static LABEL = nls.localize('stepIntoDebug', "Step Into");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action step-into', debugService, keybindingService, 30);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.stepIn() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && state === State.Stopped;
	}
}

export class StepOutAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.stepOut';
	static LABEL = nls.localize('stepOutDebug', "Step Out");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action step-out', debugService, keybindingService, 40);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.stepOut() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && state === State.Stopped;
	}
}

export class StopAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.stop';
	static LABEL = nls.localize('stopDebug', "Stop");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action stop', debugService, keybindingService, 80);
	}

	public run(session: ISession): TPromise<any> {
		if (!(session instanceof Session)) {
			session = this.debugService.getViewModel().focusedSession;
		}

		return this.debugService.stopSession(session);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && (state !== State.Inactive);
	}
}

export class DisconnectAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.disconnect';
	static LABEL = nls.localize('disconnectDebug', "Disconnect");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action disconnect', debugService, keybindingService, 80);
	}

	public run(): TPromise<any> {
		const session = this.debugService.getViewModel().focusedSession;
		return this.debugService.stopSession(session);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && (state === State.Running || state === State.Stopped);
	}
}

export class ContinueAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.continue';
	static LABEL = nls.localize('continueDebug', "Continue");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action continue', debugService, keybindingService, 10);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.continue() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && state === State.Stopped;
	}
}

export class PauseAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.pause';
	static LABEL = nls.localize('pauseDebug', "Pause");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action pause', debugService, keybindingService, 10);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.pause() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && state === State.Running;
	}
}

export class TerminateThreadAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.terminateThread';
	static LABEL = nls.localize('terminateThread', "Terminate Thread");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, undefined, debugService, keybindingService);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.terminate() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && (state === State.Running || state === State.Stopped);
	}
}

export class RestartFrameAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.restartFrame';
	static LABEL = nls.localize('restartFrame', "Restart Frame");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, undefined, debugService, keybindingService);
	}

	public run(frame: IStackFrame): TPromise<any> {
		if (!frame) {
			frame = this.debugService.getViewModel().focusedStackFrame;
		}

		return frame.restart();
	}
}

export class RemoveBreakpointAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.removeBreakpoint';
	static LABEL = nls.localize('removeBreakpoint', "Remove Breakpoint");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action remove', debugService, keybindingService);
	}

	public run(breakpoint: IBreakpoint): TPromise<any> {
		return breakpoint instanceof Breakpoint ? this.debugService.removeBreakpoints(breakpoint.getId())
			: this.debugService.removeFunctionBreakpoints(breakpoint.getId());
	}
}

export class RemoveAllBreakpointsAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.removeAllBreakpoints';
	static LABEL = nls.localize('removeAllBreakpoints', "Remove All Breakpoints");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action remove-all', debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		return TPromise.join([this.debugService.removeBreakpoints(), this.debugService.removeFunctionBreakpoints()]);
	}

	protected isEnabled(state: State): boolean {
		const model = this.debugService.getModel();
		return super.isEnabled(state) && (model.getBreakpoints().length > 0 || model.getFunctionBreakpoints().length > 0);
	}
}

export class EnableAllBreakpointsAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.enableAllBreakpoints';
	static LABEL = nls.localize('enableAllBreakpoints', "Enable All Breakpoints");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action enable-all-breakpoints', debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		return this.debugService.enableOrDisableBreakpoints(true);
	}

	protected isEnabled(state: State): boolean {
		const model = this.debugService.getModel();
		return super.isEnabled(state) && (<ReadonlyArray<IEnablement>>model.getBreakpoints()).concat(model.getFunctionBreakpoints()).concat(model.getExceptionBreakpoints()).some(bp => !bp.enabled);
	}
}

export class DisableAllBreakpointsAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.disableAllBreakpoints';
	static LABEL = nls.localize('disableAllBreakpoints', "Disable All Breakpoints");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action disable-all-breakpoints', debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		return this.debugService.enableOrDisableBreakpoints(false);
	}

	protected isEnabled(state: State): boolean {
		const model = this.debugService.getModel();
		return super.isEnabled(state) && (<ReadonlyArray<IEnablement>>model.getBreakpoints()).concat(model.getFunctionBreakpoints()).concat(model.getExceptionBreakpoints()).some(bp => bp.enabled);
	}
}

export class ToggleBreakpointsActivatedAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.toggleBreakpointsActivatedAction';
	static ACTIVATE_LABEL = nls.localize('activateBreakpoints', "Activate Breakpoints");
	static DEACTIVATE_LABEL = nls.localize('deactivateBreakpoints', "Deactivate Breakpoints");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action breakpoints-activate', debugService, keybindingService);
		this.updateLabel(this.debugService.getModel().areBreakpointsActivated() ? ToggleBreakpointsActivatedAction.DEACTIVATE_LABEL : ToggleBreakpointsActivatedAction.ACTIVATE_LABEL);

		this.toDispose.push(this.debugService.getModel().onDidChangeBreakpoints(() => {
			this.updateLabel(this.debugService.getModel().areBreakpointsActivated() ? ToggleBreakpointsActivatedAction.DEACTIVATE_LABEL : ToggleBreakpointsActivatedAction.ACTIVATE_LABEL);
			this.updateEnablement();
		}));
	}

	public run(): TPromise<any> {
		return this.debugService.setBreakpointsActivated(!this.debugService.getModel().areBreakpointsActivated());
	}

	protected isEnabled(state: State): boolean {
		return (this.debugService.getModel().getFunctionBreakpoints().length + this.debugService.getModel().getBreakpoints().length) > 0;
	}
}

export class ReapplyBreakpointsAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.reapplyBreakpointsAction';
	static LABEL = nls.localize('reapplyAllBreakpoints', "Reapply All Breakpoints");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, null, debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		return this.debugService.setBreakpointsActivated(true);
	}

	protected isEnabled(state: State): boolean {
		const model = this.debugService.getModel();
		return super.isEnabled(state) && (state === State.Running || state === State.Stopped) &&
			(model.getFunctionBreakpoints().length + model.getBreakpoints().length + model.getExceptionBreakpoints().length > 0);
	}
}

export class AddFunctionBreakpointAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.addFunctionBreakpointAction';
	static LABEL = nls.localize('addFunctionBreakpoint', "Add Function Breakpoint");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action add-function-breakpoint', debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		this.debugService.addFunctionBreakpoint();
		return TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return !this.debugService.getViewModel().getSelectedFunctionBreakpoint()
			&& this.debugService.getModel().getFunctionBreakpoints().every(fbp => !!fbp.name);
	}
}

export class SetValueAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.setValue';
	static LABEL = nls.localize('setValue', "Set Value");

	constructor(id: string, label: string, private variable: Variable, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, null, debugService, keybindingService);
	}

	public run(): TPromise<any> {
		if (this.variable instanceof Variable) {
			this.debugService.getViewModel().setSelectedExpression(this.variable);
		}

		return TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		const session = this.debugService.getViewModel().focusedSession;
		return super.isEnabled(state) && state === State.Stopped && session && session.raw.capabilities.supportsSetVariable;
	}
}


export class AddWatchExpressionAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.addWatchExpression';
	static LABEL = nls.localize('addWatchExpression', "Add Expression");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action add-watch-expression', debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeWatchExpressions(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		this.debugService.addWatchExpression();
		return TPromise.as(undefined);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && this.debugService.getModel().getWatchExpressions().every(we => !!we.name);
	}
}

export class EditWatchExpressionAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.editWatchExpression';
	static LABEL = nls.localize('editWatchExpression', "Edit Expression");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, undefined, debugService, keybindingService);
	}

	public run(expression: Expression): TPromise<any> {
		this.debugService.getViewModel().setSelectedExpression(expression);
		return TPromise.as(null);
	}
}

export class AddToWatchExpressionsAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.addToWatchExpressions';
	static LABEL = nls.localize('addToWatchExpressions', "Add to Watch");

	constructor(id: string, label: string, private variable: Variable, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action add-to-watch', debugService, keybindingService);
		this.updateEnablement();
	}

	public run(): TPromise<any> {
		this.debugService.addWatchExpression(this.variable.evaluateName);
		return TPromise.as(undefined);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && this.variable && !!this.variable.evaluateName;
	}
}

export class RemoveWatchExpressionAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.removeWatchExpression';
	static LABEL = nls.localize('removeWatchExpression', "Remove Expression");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, undefined, debugService, keybindingService);
	}

	public run(expression: Expression): TPromise<any> {
		this.debugService.removeWatchExpressions(expression.getId());
		return TPromise.as(null);
	}
}

export class RemoveAllWatchExpressionsAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.viewlet.action.removeAllWatchExpressions';
	static LABEL = nls.localize('removeAllWatchExpressions', "Remove All Expressions");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action remove-all', debugService, keybindingService);
		this.toDispose.push(this.debugService.getModel().onDidChangeWatchExpressions(() => this.updateEnablement()));
	}

	public run(): TPromise<any> {
		this.debugService.removeWatchExpressions();
		return TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		return super.isEnabled(state) && this.debugService.getModel().getWatchExpressions().length > 0;
	}
}

export class ClearReplAction extends AbstractDebugAction {
	static readonly ID = 'workbench.debug.panel.action.clearReplAction';
	static LABEL = nls.localize('clearRepl', "Clear Console");

	constructor(id: string, label: string,
		@IDebugService debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IPanelService private panelService: IPanelService
	) {
		super(id, label, 'debug-action clear-repl', debugService, keybindingService);
	}

	public run(): TPromise<any> {
		this.debugService.removeReplExpressions();

		// focus back to repl
		return this.panelService.openPanel(REPL_ID, true);
	}
}

export class ToggleReplAction extends TogglePanelAction {
	static readonly ID = 'workbench.debug.action.toggleRepl';
	static LABEL = nls.localize({ comment: ['Debug is a noun in this context, not a verb.'], key: 'debugConsoleAction' }, 'Debug Console');
	private toDispose: lifecycle.IDisposable[];

	constructor(id: string, label: string,
		@IDebugService private debugService: IDebugService,
		@IPartService partService: IPartService,
		@IPanelService panelService: IPanelService
	) {
		super(id, label, REPL_ID, panelService, partService, 'debug-action toggle-repl');
		this.toDispose = [];
		this.registerListeners();
	}

	private registerListeners(): void {
		this.toDispose.push(this.debugService.getModel().onDidChangeReplElements(() => {
			if (!this.isReplVisible()) {
				this.class = 'debug-action toggle-repl notification';
				this.tooltip = nls.localize('unreadOutput', "New Output in Debug Console");
			}
		}));
		this.toDispose.push(this.panelService.onDidPanelOpen(panel => {
			if (panel.getId() === REPL_ID) {
				this.class = 'debug-action toggle-repl';
				this.tooltip = ToggleReplAction.LABEL;
			}
		}));
	}

	private isReplVisible(): boolean {
		const panel = this.panelService.getActivePanel();
		return panel && panel.getId() === REPL_ID;
	}

	public dispose(): void {
		super.dispose();
		this.toDispose = lifecycle.dispose(this.toDispose);
	}
}

export class FocusReplAction extends Action {

	static readonly ID = 'workbench.debug.action.focusRepl';
	static LABEL = nls.localize({ comment: ['Debug is a noun in this context, not a verb.'], key: 'debugFocusConsole' }, 'Focus Debug Console');


	constructor(id: string, label: string,
		@IPanelService private panelService: IPanelService
	) {
		super(id, label);
	}

	public run(): TPromise<any> {
		return this.panelService.openPanel(REPL_ID, true);
	}
}

export class FocusSessionAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.focusProcess';
	static LABEL = nls.localize('focusSession', "Focus Session");

	constructor(id: string, label: string,
		@IDebugService debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IEditorService private editorService: IEditorService
	) {
		super(id, label, null, debugService, keybindingService, 100);
	}

	public run(sessionName: string): TPromise<any> {
		const isMultiRoot = this.debugService.getConfigurationManager().getLaunches().length > 1;
		const session = this.debugService.getModel().getSessions().filter(p => p.getName(isMultiRoot) === sessionName).pop();
		this.debugService.focusStackFrame(undefined, undefined, session, true);
		const stackFrame = this.debugService.getViewModel().focusedStackFrame;
		if (stackFrame) {
			return stackFrame.openInEditor(this.editorService, true);
		}

		return TPromise.as(undefined);
	}
}

// Actions used by the chakra debugger
export class StepBackAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.stepBack';
	static LABEL = nls.localize('stepBackDebug', "Step Back");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action step-back', debugService, keybindingService, 50);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.stepBack() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		const session = this.debugService.getViewModel().focusedSession;
		return super.isEnabled(state) && state === State.Stopped &&
			session && session.raw.capabilities.supportsStepBack;
	}
}

export class ReverseContinueAction extends AbstractDebugAction {
	static readonly ID = 'workbench.action.debug.reverseContinue';
	static LABEL = nls.localize('reverseContinue', "Reverse");

	constructor(id: string, label: string, @IDebugService debugService: IDebugService, @IKeybindingService keybindingService: IKeybindingService) {
		super(id, label, 'debug-action reverse-continue', debugService, keybindingService, 60);
	}

	public run(thread: IThread): TPromise<any> {
		if (!(thread instanceof Thread)) {
			thread = this.debugService.getViewModel().focusedThread;
		}

		return thread ? thread.reverseContinue() : TPromise.as(null);
	}

	protected isEnabled(state: State): boolean {
		const session = this.debugService.getViewModel().focusedSession;
		return super.isEnabled(state) && state === State.Stopped &&
			session && session.raw.capabilities.supportsStepBack;
	}
}

export class ReplCollapseAllAction extends CollapseAction {
	constructor(viewer: ITree, private toFocus: { focus(): void; }) {
		super(viewer, true, undefined);
	}

	public run(event?: any): TPromise<any> {
		return super.run(event).then(() => {
			this.toFocus.focus();
		});
	}
}

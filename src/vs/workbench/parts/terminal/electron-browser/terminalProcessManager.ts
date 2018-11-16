/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as platform from 'vs/base/common/platform';
import * as terminalEnvironment from 'vs/workbench/parts/terminal/node/terminalEnvironment';
import Uri from 'vs/base/common/uri';
import { IDisposable } from 'vs/base/common/lifecycle';
import { ProcessState, ITerminalProcessManager, IShellLaunchConfig, ITerminalConfigHelper } from 'vs/workbench/parts/terminal/common/terminal';
import { TPromise } from 'vs/base/common/winjs.base';
import { ILogService } from 'vs/platform/log/common/log';
import { Emitter, Event } from 'vs/base/common/event';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { ITerminalChildProcess, IMessageFromTerminalProcess } from 'vs/workbench/parts/terminal/node/terminal';
import { TerminalProcessExtHostProxy } from 'vs/workbench/parts/terminal/node/terminalProcessExtHostProxy';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

/** The amount of time to consider terminal errors to be related to the launch */
const LAUNCHING_DURATION = 500;

/**
 * Holds all state related to the creation and management of terminal processes.
 *
 * Internal definitions:
 * - Process: The process launched with the terminalProcess.ts file, or the pty as a whole
 * - Pty Process: The pseudoterminal master process (or the winpty agent process)
 * - Shell Process: The pseudoterminal slave process (ie. the shell)
 */
export class TerminalProcessManager implements ITerminalProcessManager {
	public processState: ProcessState = ProcessState.UNINITIALIZED;
	public ptyProcessReady: TPromise<void>;
	public shellProcessId: number;
	public initialCwd: string;

	private _process: ITerminalChildProcess;
	private _preLaunchInputQueue: string[] = [];
	private _disposables: IDisposable[] = [];

	private readonly _onProcessReady: Emitter<void> = new Emitter<void>();
	public get onProcessReady(): Event<void> { return this._onProcessReady.event; }
	private readonly _onProcessData: Emitter<string> = new Emitter<string>();
	public get onProcessData(): Event<string> { return this._onProcessData.event; }
	private readonly _onProcessTitle: Emitter<string> = new Emitter<string>();
	public get onProcessTitle(): Event<string> { return this._onProcessTitle.event; }
	private readonly _onProcessExit: Emitter<number> = new Emitter<number>();
	public get onProcessExit(): Event<number> { return this._onProcessExit.event; }

	constructor(
		private _terminalId: number,
		private _configHelper: ITerminalConfigHelper,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IHistoryService private readonly _historyService: IHistoryService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private _logService: ILogService
	) {
		this.ptyProcessReady = new TPromise<void>(c => {
			this.onProcessReady(() => {
				this._logService.debug(`Terminal process ready (shellProcessId: ${this.shellProcessId})`);
				c(void 0);
			});
		});
	}

	public dispose(): void {
		if (this._process) {
			if (this._process.connected) {
				// If the process was still connected this dispose came from
				// within VS Code, not the process, so mark the process as
				// killed by the user.
				this.processState = ProcessState.KILLED_BY_USER;
				this._process.send({ event: 'shutdown' });
			}
			this._process = null;
		}
		this._disposables.forEach(d => d.dispose());
		this._disposables.length = 0;
	}

	public addDisposable(disposable: IDisposable) {
		this._disposables.push(disposable);
	}

	public createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cols: number,
		rows: number
	): void {
		const extensionHostOwned = (<any>this._configHelper.config).extHostProcess;
		if (extensionHostOwned) {
			this._process = this._instantiationService.createInstance(TerminalProcessExtHostProxy, this._terminalId, shellLaunchConfig, cols, rows);
		} else {
			const locale = this._configHelper.config.setLocaleVariables ? platform.locale : undefined;
			if (!shellLaunchConfig.executable) {
				this._configHelper.mergeDefaultShellPathAndArgs(shellLaunchConfig);
			}

			const lastActiveWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot('file');
			this.initialCwd = terminalEnvironment.getCwd(shellLaunchConfig, lastActiveWorkspaceRootUri, this._configHelper);

			// Resolve env vars from config and shell
			const lastActiveWorkspaceRoot = this._workspaceContextService.getWorkspaceFolder(lastActiveWorkspaceRootUri);
			const platformKey = platform.isWindows ? 'windows' : (platform.isMacintosh ? 'osx' : 'linux');
			const envFromConfig = terminalEnvironment.resolveConfigurationVariables(this._configurationResolverService, { ...this._configHelper.config.env[platformKey] }, lastActiveWorkspaceRoot);
			const envFromShell = terminalEnvironment.resolveConfigurationVariables(this._configurationResolverService, { ...shellLaunchConfig.env }, lastActiveWorkspaceRoot);
			shellLaunchConfig.env = envFromShell;

			// Merge process env with the env from config
			const parentEnv = { ...process.env };
			terminalEnvironment.mergeEnvironments(parentEnv, envFromConfig);

			// Continue env initialization, merging in the env from the launch
			// config and adding keys that are needed to create the process
			const env = terminalEnvironment.createTerminalEnv(parentEnv, shellLaunchConfig, this.initialCwd, locale, cols, rows);
			const cwd = Uri.parse(require.toUrl('../node')).fsPath;
			const options = { env, cwd };
			this._logService.debug(`Terminal process launching`, options);

			this._process = cp.fork(Uri.parse(require.toUrl('bootstrap')).fsPath, ['--type=terminal'], options);
		}
		this.processState = ProcessState.LAUNCHING;

		this._process.on('message', message => this._onMessage(message));
		this._process.on('exit', exitCode => this._onExit(exitCode));

		setTimeout(() => {
			if (this.processState === ProcessState.LAUNCHING) {
				this.processState = ProcessState.RUNNING;
			}
		}, LAUNCHING_DURATION);
	}

	public setDimensions(cols: number, rows: number): void {
		if (this._process && this._process.connected) {
			// The child process could aready be terminated
			try {
				this._process.send({ event: 'resize', cols, rows });
			} catch (error) {
				// We tried to write to a closed pipe / channel.
				if (error.code !== 'EPIPE' && error.code !== 'ERR_IPC_CHANNEL_CLOSED') {
					throw (error);
				}
			}
		}
	}

	public write(data: string): void {
		if (this.shellProcessId) {
			// Send data if the pty is ready
			this._process.send({
				event: 'input',
				data
			});
		} else {
			// If the pty is not ready, queue the data received to send later
			this._preLaunchInputQueue.push(data);
		}
	}

	private _onMessage(message: IMessageFromTerminalProcess): void {
		this._logService.trace(`terminalProcessManager#_onMessage (shellProcessId: ${this.shellProcessId}`, message);
		switch (message.type) {
			case 'data':
				this._onProcessData.fire(<string>message.content);
				break;
			case 'pid':
				this.shellProcessId = <number>message.content;
				this._onProcessReady.fire();

				// Send any queued data that's waiting
				if (this._preLaunchInputQueue.length > 0) {
					this._process.send({
						event: 'input',
						data: this._preLaunchInputQueue.join('')
					});
					this._preLaunchInputQueue.length = 0;
				}
				break;
			case 'title':
				this._onProcessTitle.fire(<string>message.content);
				break;
		}
	}

	private _onExit(exitCode: number): void {
		this._process = null;

		// If the process is marked as launching then mark the process as killed
		// during launch. This typically means that there is a problem with the
		// shell and args.
		if (this.processState === ProcessState.LAUNCHING) {
			this.processState = ProcessState.KILLED_DURING_LAUNCH;
		}

		// If TerminalInstance did not know about the process exit then it was
		// triggered by the process, not on VS Code's side.
		if (this.processState === ProcessState.RUNNING) {
			this.processState = ProcessState.KILLED_BY_PROCESS;
		}

		this._onProcessExit.fire(exitCode);
	}
}
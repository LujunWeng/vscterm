/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as cp from 'child_process';
import * as stream from 'stream';
import * as nls from 'vs/nls';
import * as net from 'net';
import * as paths from 'vs/base/common/paths';
import * as strings from 'vs/base/common/strings';
import * as objects from 'vs/base/common/objects';
import * as platform from 'vs/base/common/platform';
import * as stdfork from 'vs/base/node/stdFork';
import { Emitter, Event } from 'vs/base/common/event';
import { TPromise } from 'vs/base/common/winjs.base';
import { ExtensionsChannelId } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IExtensionDescription } from 'vs/workbench/services/extensions/common/extensions';
import { IOutputService } from 'vs/workbench/parts/output/common/output';
import { IDebugAdapter, IAdapterExecutable, IDebuggerContribution, IPlatformSpecificAdapterContribution, IConfig } from 'vs/workbench/parts/debug/common/debug';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IStringDictionary } from 'vs/base/common/collections';

/**
 * Abstract implementation of the low level API for a debug adapter.
 * Missing is how this API communicates with the debug adapter.
 */
export abstract class AbstractDebugAdapter implements IDebugAdapter {

	private sequence: number;
	private pendingRequests: Map<number, (e: DebugProtocol.Response) => void>;
	private requestCallback: (request: DebugProtocol.Request) => void;
	private eventCallback: (request: DebugProtocol.Event) => void;

	protected readonly _onError: Emitter<Error>;
	protected readonly _onExit: Emitter<number>;

	constructor() {
		this.sequence = 1;
		this.pendingRequests = new Map<number, (e: DebugProtocol.Response) => void>();

		this._onError = new Emitter<Error>();
		this._onExit = new Emitter<number>();
	}

	abstract startSession(): TPromise<void>;
	abstract stopSession(): TPromise<void>;

	public dispose(): void {
	}

	abstract sendMessage(message: DebugProtocol.ProtocolMessage): void;

	public get onError(): Event<Error> {
		return this._onError.event;
	}

	public get onExit(): Event<number> {
		return this._onExit.event;
	}

	public onEvent(callback: (event: DebugProtocol.Event) => void): void {
		if (this.eventCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Event' callback`));
		}
		this.eventCallback = callback;
	}

	public onRequest(callback: (request: DebugProtocol.Request) => void): void {
		if (this.requestCallback) {
			this._onError.fire(new Error(`attempt to set more than one 'Request' callback`));
		}
		this.requestCallback = callback;
	}

	public sendResponse(response: DebugProtocol.Response): void {
		if (response.seq > 0) {
			this._onError.fire(new Error(`attempt to send more than one response for command ${response.command}`));
		} else {
			this.internalSend('response', response);
		}
	}

	public sendRequest(command: string, args: any, clb: (result: DebugProtocol.Response) => void): void {

		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}

		this.internalSend('request', request);

		if (clb) {
			// store callback for this request
			this.pendingRequests.set(request.seq, clb);
		}
	}

	public acceptMessage(message: DebugProtocol.ProtocolMessage): void {
		switch (message.type) {
			case 'event':
				if (this.eventCallback) {
					this.eventCallback(<DebugProtocol.Event>message);
				}
				break;
			case 'request':
				if (this.requestCallback) {
					this.requestCallback(<DebugProtocol.Request>message);
				}
				break;
			case 'response':
				const response = <DebugProtocol.Response>message;
				const clb = this.pendingRequests.get(response.request_seq);
				if (clb) {
					this.pendingRequests.delete(response.request_seq);
					clb(response);
				}
				break;
		}
	}

	private internalSend(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): void {

		message.type = typ;
		message.seq = this.sequence++;

		this.sendMessage(message);
	}
}

/**
 * An implementation that communicates via two streams with the debug adapter.
 */
export abstract class StreamDebugAdapter extends AbstractDebugAdapter {

	private static readonly TWO_CRLF = '\r\n\r\n';
	private static readonly HEADER_LINESEPARATOR = /\r?\n/;	// allow for non-RFC 2822 conforming line separators
	private static readonly HEADER_FIELDSEPARATOR = /: */;

	private outputStream: stream.Writable;
	private rawData: Buffer;
	private contentLength: number;

	constructor() {
		super();
	}

	public connect(readable: stream.Readable, writable: stream.Writable): void {

		this.outputStream = writable;
		this.rawData = Buffer.allocUnsafe(0);
		this.contentLength = -1;

		readable.on('data', (data: Buffer) => this.handleData(data));

		// readable.on('close', () => {
		// 	this._emitEvent(new Event('close'));
		// });
		// readable.on('error', (error) => {
		// 	this._emitEvent(new Event('error', 'readable error: ' + (error && error.message)));
		// });

		// writable.on('error', (error) => {
		// 	this._emitEvent(new Event('error', 'writable error: ' + (error && error.message)));
		// });
	}

	public sendMessage(message: DebugProtocol.ProtocolMessage): void {

		if (this.outputStream) {
			const json = JSON.stringify(message);
			this.outputStream.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}${StreamDebugAdapter.TWO_CRLF}${json}`, 'utf8');
		}
	}

	private handleData(data: Buffer): void {

		this.rawData = Buffer.concat([this.rawData, data]);

		while (true) {
			if (this.contentLength >= 0) {
				if (this.rawData.length >= this.contentLength) {
					const message = this.rawData.toString('utf8', 0, this.contentLength);
					this.rawData = this.rawData.slice(this.contentLength);
					this.contentLength = -1;
					if (message.length > 0) {
						try {
							this.acceptMessage(<DebugProtocol.ProtocolMessage>JSON.parse(message));
						} catch (e) {
							this._onError.fire(new Error((e.message || e) + '\n' + message));
						}
					}
					continue;	// there may be more complete messages to process
				}
			} else {
				const idx = this.rawData.indexOf(StreamDebugAdapter.TWO_CRLF);
				if (idx !== -1) {
					const header = this.rawData.toString('utf8', 0, idx);
					const lines = header.split(StreamDebugAdapter.HEADER_LINESEPARATOR);
					for (const h of lines) {
						const kvPair = h.split(StreamDebugAdapter.HEADER_FIELDSEPARATOR);
						if (kvPair[0] === 'Content-Length') {
							this.contentLength = Number(kvPair[1]);
						}
					}
					this.rawData = this.rawData.slice(idx + StreamDebugAdapter.TWO_CRLF.length);
					continue;
				}
			}
			break;
		}
	}
}

/**
 * An implementation that connects to a debug adapter via a socket.
*/
export class SocketDebugAdapter extends StreamDebugAdapter {

	private socket: net.Socket;

	constructor(private port: number, private host = '127.0.0.1') {
		super();
	}

	startSession(): TPromise<void> {
		return new TPromise<void>((c, e) => {
			this.socket = net.createConnection(this.port, this.host, () => {
				this.connect(this.socket, <any>this.socket);
				c(null);
			});
			this.socket.on('error', (err: any) => {
				e(err);
			});
			this.socket.on('close', () => this._onExit.fire(0));
		});
	}

	stopSession(): TPromise<void> {
		if (this.socket !== null) {
			this.socket.end();
			this.socket = undefined;
		}
		return void 0;
	}
}

/**
 * An implementation that launches the debug adapter as a separate process and communicates via stdin/stdout.
*/
export class DebugAdapter extends StreamDebugAdapter {

	private serverProcess: cp.ChildProcess;

	constructor(private debugType: string, private adapterExecutable: IAdapterExecutable | null, extensionDescriptions: IExtensionDescription[], private outputService?: IOutputService) {
		super();

		if (!this.adapterExecutable) {
			this.adapterExecutable = DebugAdapter.platformAdapterExecutable(extensionDescriptions, this.debugType);
		}
	}

	startSession(): TPromise<void> {

		return new TPromise<void>((c, e) => {

			// verify executables
			if (this.adapterExecutable.command) {
				if (paths.isAbsolute(this.adapterExecutable.command)) {
					if (!fs.existsSync(this.adapterExecutable.command)) {
						e(new Error(nls.localize('debugAdapterBinNotFound', "Debug adapter executable '{0}' does not exist.", this.adapterExecutable.command)));
					}
				} else {
					// relative path
					if (this.adapterExecutable.command.indexOf('/') < 0 && this.adapterExecutable.command.indexOf('\\') < 0) {
						// no separators: command looks like a runtime name like 'node' or 'mono'
						// TODO: check that the runtime is available on PATH
					}
				}
			} else {
				e(new Error(nls.localize({ key: 'debugAdapterCannotDetermineExecutable', comment: ['Adapter executable file not found'] },
					"Cannot determine executable for debug adapter '{0}'.", this.debugType)));
			}

			if (this.adapterExecutable.command === 'node' && this.outputService) {
				if (Array.isArray(this.adapterExecutable.args) && this.adapterExecutable.args.length > 0) {
					stdfork.fork(this.adapterExecutable.args[0], this.adapterExecutable.args.slice(1), {}, (err, child) => {
						if (err) {
							e(new Error(nls.localize('unableToLaunchDebugAdapter', "Unable to launch debug adapter from '{0}'.", this.adapterExecutable.args[0])));
						}
						this.serverProcess = child;
						c(null);
					});
				} else {
					e(new Error(nls.localize('unableToLaunchDebugAdapterNoArgs', "Unable to launch debug adapter.")));
				}
			} else {
				this.serverProcess = cp.spawn(this.adapterExecutable.command, this.adapterExecutable.args);
				c(null);
			}
		}).then(_ => {
			this.serverProcess.on('error', (err: Error) => this._onError.fire(err));
			this.serverProcess.on('exit', (code: number, signal: string) => this._onExit.fire(code));

			if (this.outputService) {
				const sanitize = (s: string) => s.toString().replace(/\r?\n$/mg, '');
				// this.serverProcess.stdout.on('data', (data: string) => {
				// 	console.log('%c' + sanitize(data), 'background: #ddd; font-style: italic;');
				// });
				this.serverProcess.stderr.on('data', (data: string) => {
					this.outputService.getChannel(ExtensionsChannelId).append(sanitize(data));
				});
			}

			this.connect(this.serverProcess.stdout, this.serverProcess.stdin);
		}, err => {
			this._onError.fire(err);
		});
	}

	stopSession(): TPromise<void> {

		// when killing a process in windows its child
		// processes are *not* killed but become root
		// processes. Therefore we use TASKKILL.EXE
		if (platform.isWindows) {
			return new TPromise<void>((c, e) => {
				const killer = cp.exec(`taskkill /F /T /PID ${this.serverProcess.pid}`, function (err, stdout, stderr) {
					if (err) {
						return e(err);
					}
				});
				killer.on('exit', c);
				killer.on('error', e);
			});
		} else {
			this.serverProcess.kill('SIGTERM');
			return TPromise.as(null);
		}
	}

	private static extract(contribution: IDebuggerContribution, extensionFolderPath: string): IDebuggerContribution {
		if (!contribution) {
			return undefined;
		}

		const result: IDebuggerContribution = Object.create(null);
		if (contribution.runtime) {
			if (contribution.runtime.indexOf('./') === 0) {	// TODO
				result.runtime = paths.join(extensionFolderPath, contribution.runtime);
			} else {
				result.runtime = contribution.runtime;
			}
		}
		if (contribution.runtimeArgs) {
			result.runtimeArgs = contribution.runtimeArgs;
		}
		if (contribution.program) {
			if (!paths.isAbsolute(contribution.program)) {
				result.program = paths.join(extensionFolderPath, contribution.program);
			} else {
				result.program = contribution.program;
			}
		}
		if (contribution.args) {
			result.args = contribution.args;
		}

		if (contribution.win) {
			result.win = DebugAdapter.extract(contribution.win, extensionFolderPath);
		}
		if (contribution.winx86) {
			result.winx86 = DebugAdapter.extract(contribution.winx86, extensionFolderPath);
		}
		if (contribution.windows) {
			result.windows = DebugAdapter.extract(contribution.windows, extensionFolderPath);
		}
		if (contribution.osx) {
			result.osx = DebugAdapter.extract(contribution.osx, extensionFolderPath);
		}
		if (contribution.linux) {
			result.linux = DebugAdapter.extract(contribution.linux, extensionFolderPath);
		}
		return result;
	}

	public static platformAdapterExecutable(extensionDescriptions: IExtensionDescription[], debugType: string): IAdapterExecutable {
		const result: IDebuggerContribution = Object.create(null);
		debugType = debugType.toLowerCase();

		// merge all contributions into one
		for (const ed of extensionDescriptions) {
			if (ed.contributes) {
				const debuggers = <IDebuggerContribution[]>ed.contributes['debuggers'];
				if (debuggers && debuggers.length > 0) {
					debuggers.filter(dbg => strings.equalsIgnoreCase(dbg.type, debugType)).forEach(dbg => {
						// extract relevant attributes and make then absolute where needed
						// TODO@extensionLocation
						const extractedDbg = DebugAdapter.extract(dbg, ed.extensionLocation.fsPath);

						// merge
						objects.mixin(result, extractedDbg, ed.isBuiltin);
					});
				}
			}
		}

		// select the right platform
		let platformInfo: IPlatformSpecificAdapterContribution;
		if (platform.isWindows && !process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432')) {
			platformInfo = result.winx86 || result.win || result.windows;
		} else if (platform.isWindows) {
			platformInfo = result.win || result.windows;
		} else if (platform.isMacintosh) {
			platformInfo = result.osx;
		} else if (platform.isLinux) {
			platformInfo = result.linux;
		}
		platformInfo = platformInfo || result;

		// these are the relevant attributes
		let program = platformInfo.program || result.program;
		const args = platformInfo.args || result.args;
		let runtime = platformInfo.runtime || result.runtime;
		const runtimeArgs = platformInfo.runtimeArgs || result.runtimeArgs;

		if (runtime) {
			return {
				command: runtime,
				args: (runtimeArgs || []).concat([program]).concat(args || [])
			};
		} else {
			return {
				command: program,
				args: args || []
			};
		}
	}

	static substituteVariables(workspaceFolder: IWorkspaceFolder, config: IConfig, resolverService: IConfigurationResolverService, commandValueMapping?: IStringDictionary<string>): IConfig {

		const result = objects.deepClone(config) as IConfig;

		// hoist platform specific attributes to top level
		if (platform.isWindows && result.windows) {
			Object.keys(result.windows).forEach(key => result[key] = result.windows[key]);
		} else if (platform.isMacintosh && result.osx) {
			Object.keys(result.osx).forEach(key => result[key] = result.osx[key]);
		} else if (platform.isLinux && result.linux) {
			Object.keys(result.linux).forEach(key => result[key] = result.linux[key]);
		}

		// delete all platform specific sections
		delete result.windows;
		delete result.osx;
		delete result.linux;

		// substitute all variables in string values
		return resolverService.resolveAny(workspaceFolder, result, commandValueMapping);
	}
}

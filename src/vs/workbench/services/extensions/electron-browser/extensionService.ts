/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import * as errors from 'vs/base/common/errors';
import * as objects from 'vs/base/common/objects';
import { TPromise } from 'vs/base/common/winjs.base';
import pkg from 'vs/platform/node/package';
import * as path from 'path';
import * as os from 'os';
import * as pfs from 'vs/base/node/pfs';
import URI from 'vs/base/common/uri';
import * as platform from 'vs/base/common/platform';
import { ExtensionDescriptionRegistry } from 'vs/workbench/services/extensions/node/extensionDescriptionRegistry';
import { IMessage, IExtensionDescription, IExtensionsStatus, IExtensionService, ExtensionPointContribution, ActivationTimes, ProfileSession } from 'vs/workbench/services/extensions/common/extensions';
import { USER_MANIFEST_CACHE_FILE, BUILTIN_MANIFEST_CACHE_FILE, MANIFEST_CACHE_FOLDER } from 'vs/platform/extensions/common/extensions';
import { IExtensionEnablementService, IExtensionIdentifier, EnablementState, IExtensionManagementService, LocalExtensionType } from 'vs/platform/extensionManagement/common/extensionManagement';
import { areSameExtensions, BetterMergeId, BetterMergeDisabledNowKey, getGalleryExtensionIdFromLocal } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { ExtensionsRegistry, ExtensionPoint, IExtensionPointUser, ExtensionMessageCollector, IExtensionPoint } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ExtensionScanner, ILog, ExtensionScannerInput, IExtensionResolver, IExtensionReference, Translations, IRelaxedExtensionDescription } from 'vs/workbench/services/extensions/node/extensionPoints';
import { ProxyIdentifier } from 'vs/workbench/services/extensions/node/proxyIdentifier';
import { ExtHostContext, ExtHostExtensionServiceShape, IExtHostContext, MainContext } from 'vs/workbench/api/node/extHost.protocol';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ExtensionHostProcessWorker } from 'vs/workbench/services/extensions/electron-browser/extensionHost';
import { IMessagePassingProtocol } from 'vs/base/parts/ipc/common/ipc';
import { ExtHostCustomersRegistry } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { mark } from 'vs/base/common/performance';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { Barrier } from 'vs/base/common/async';
import { Event, Emitter } from 'vs/base/common/event';
import { ExtensionHostProfiler } from 'vs/workbench/services/extensions/electron-browser/extensionHostProfiler';
import product from 'vs/platform/node/product';
import * as strings from 'vs/base/common/strings';
import { RPCProtocol } from 'vs/workbench/services/extensions/node/rpcProtocol';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { isFalsyOrEmpty } from 'vs/base/common/arrays';

let _SystemExtensionsRoot: string = null;
function getSystemExtensionsRoot(): string {
	if (!_SystemExtensionsRoot) {
		_SystemExtensionsRoot = path.normalize(path.join(URI.parse(require.toUrl('')).fsPath, '..', 'extensions'));
	}
	return _SystemExtensionsRoot;
}
let _ExtraDevSystemExtensionsRoot: string = null;
function getExtraDevSystemExtensionsRoot(): string {
	if (!_ExtraDevSystemExtensionsRoot) {
		_ExtraDevSystemExtensionsRoot = path.normalize(path.join(URI.parse(require.toUrl('')).fsPath, '..', '.build', 'builtInExtensions'));
	}
	return _ExtraDevSystemExtensionsRoot;
}

interface IBuiltInExtension {
	name: string;
	version: string;
	repo: string;
}

interface IBuiltInExtensionControl {
	[name: string]: 'marketplace' | 'disabled' | string;
}

class ExtraBuiltInExtensionResolver implements IExtensionResolver {

	constructor(private builtInExtensions: IBuiltInExtension[], private control: IBuiltInExtensionControl) { }

	resolveExtensions(): TPromise<IExtensionReference[]> {
		const result: IExtensionReference[] = [];

		for (const ext of this.builtInExtensions) {
			const controlState = this.control[ext.name] || 'marketplace';

			switch (controlState) {
				case 'disabled':
					break;
				case 'marketplace':
					result.push({ name: ext.name, path: path.join(getExtraDevSystemExtensionsRoot(), ext.name) });
					break;
				default:
					result.push({ name: ext.name, path: controlState });
					break;
			}
		}

		return TPromise.as(result);
	}
}

// Enable to see detailed message communication between window and extension host
const logExtensionHostCommunication = false;

function messageWithSource(source: string, message: string): string {
	if (source) {
		return `[${source}]: ${message}`;
	}
	return message;
}

const hasOwnProperty = Object.hasOwnProperty;
const NO_OP_VOID_PROMISE = TPromise.wrap<void>(void 0);

export class ExtensionHostProcessManager extends Disposable {

	public readonly onDidCrash: Event<[number, string]>;

	/**
	 * A map of already activated events to speed things up if the same activation event is triggered multiple times.
	 */
	private readonly _extensionHostProcessFinishedActivateEvents: { [activationEvent: string]: boolean; };
	private _extensionHostProcessRPCProtocol: RPCProtocol;
	private readonly _extensionHostProcessCustomers: IDisposable[];
	private readonly _extensionHostProcessWorker: ExtensionHostProcessWorker;
	/**
	 * winjs believes a proxy is a promise because it has a `then` method, so wrap the result in an object.
	 */
	private readonly _extensionHostProcessProxy: TPromise<{ value: ExtHostExtensionServiceShape; }>;

	constructor(
		extensionHostProcessWorker: ExtensionHostProcessWorker,
		initialActivationEvents: string[],
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super();
		this._extensionHostProcessFinishedActivateEvents = Object.create(null);
		this._extensionHostProcessRPCProtocol = null;
		this._extensionHostProcessCustomers = [];
		this._extensionHostProcessProxy = null;

		this._extensionHostProcessWorker = extensionHostProcessWorker;
		this.onDidCrash = this._extensionHostProcessWorker.onCrashed;
		this._extensionHostProcessProxy = this._extensionHostProcessWorker.start().then(
			(protocol) => {
				return { value: this._createExtensionHostCustomers(protocol) };
			},
			(err) => {
				console.error('Error received from starting extension host');
				console.error(err);
				return null;
			}
		);
		this._extensionHostProcessProxy.then(() => {
			initialActivationEvents.forEach((activationEvent) => this.activateByEvent(activationEvent));
		});
	}

	public dispose(): void {
		if (this._extensionHostProcessWorker) {
			this._extensionHostProcessWorker.dispose();
		}
		if (this._extensionHostProcessRPCProtocol) {
			this._extensionHostProcessRPCProtocol.dispose();
		}
		for (let i = 0, len = this._extensionHostProcessCustomers.length; i < len; i++) {
			const customer = this._extensionHostProcessCustomers[i];
			try {
				customer.dispose();
			} catch (err) {
				errors.onUnexpectedError(err);
			}
		}

		super.dispose();
	}

	public canProfileExtensionHost(): boolean {
		return this._extensionHostProcessWorker && Boolean(this._extensionHostProcessWorker.getInspectPort());
	}

	private _createExtensionHostCustomers(protocol: IMessagePassingProtocol): ExtHostExtensionServiceShape {

		if (logExtensionHostCommunication || this._environmentService.logExtensionHostCommunication) {
			protocol = asLoggingProtocol(protocol);
		}

		this._extensionHostProcessRPCProtocol = new RPCProtocol(protocol);
		const extHostContext: IExtHostContext = this._extensionHostProcessRPCProtocol;

		// Named customers
		const namedCustomers = ExtHostCustomersRegistry.getNamedCustomers();
		for (let i = 0, len = namedCustomers.length; i < len; i++) {
			const [id, ctor] = namedCustomers[i];
			const instance = this._instantiationService.createInstance(ctor, extHostContext);
			this._extensionHostProcessCustomers.push(instance);
			this._extensionHostProcessRPCProtocol.set(id, instance);
		}

		// Customers
		const customers = ExtHostCustomersRegistry.getCustomers();
		for (let i = 0, len = customers.length; i < len; i++) {
			const ctor = customers[i];
			const instance = this._instantiationService.createInstance(ctor, extHostContext);
			this._extensionHostProcessCustomers.push(instance);
		}

		// Check that no named customers are missing
		const expected: ProxyIdentifier<any>[] = Object.keys(MainContext).map((key) => (<any>MainContext)[key]);
		this._extensionHostProcessRPCProtocol.assertRegistered(expected);

		return this._extensionHostProcessRPCProtocol.getProxy(ExtHostContext.ExtHostExtensionService);
	}

	public activateByEvent(activationEvent: string): TPromise<void> {
		if (this._extensionHostProcessFinishedActivateEvents[activationEvent] || !this._extensionHostProcessProxy) {
			return NO_OP_VOID_PROMISE;
		}
		return this._extensionHostProcessProxy.then((proxy) => {
			return proxy.value.$activateByEvent(activationEvent);
		}).then(() => {
			this._extensionHostProcessFinishedActivateEvents[activationEvent] = true;
		});
	}

	public startExtensionHostProfile(): TPromise<ProfileSession> {
		if (this._extensionHostProcessWorker) {
			let port = this._extensionHostProcessWorker.getInspectPort();
			if (port) {
				return this._instantiationService.createInstance(ExtensionHostProfiler, port).start();
			}
		}
		throw new Error('Extension host not running or no inspect port available');
	}
}

export class ExtensionService extends Disposable implements IExtensionService {
	public _serviceBrand: any;

	private readonly _onDidRegisterExtensions: Emitter<void>;

	private _registry: ExtensionDescriptionRegistry;
	private readonly _installedExtensionsReady: Barrier;
	private readonly _isDev: boolean;
	private readonly _extensionsMessages: { [id: string]: IMessage[] };
	private _allRequestedActivateEvents: { [activationEvent: string]: boolean; };

	private readonly _onDidChangeExtensionsStatus: Emitter<string[]> = this._register(new Emitter<string[]>());
	public readonly onDidChangeExtensionsStatus: Event<string[]> = this._onDidChangeExtensionsStatus.event;

	// --- Members used per extension host process
	private _extensionHostProcessManagers: ExtensionHostProcessManager[];
	private _extensionHostProcessActivationTimes: { [id: string]: ActivationTimes; };
	private _extensionHostExtensionRuntimeErrors: { [id: string]: Error[]; };

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IExtensionEnablementService private readonly _extensionEnablementService: IExtensionEnablementService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWindowService private readonly _windowService: IWindowService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IExtensionManagementService private extensionManagementService: IExtensionManagementService
	) {
		super();
		this._registry = null;
		this._installedExtensionsReady = new Barrier();
		this._isDev = !this._environmentService.isBuilt || this._environmentService.isExtensionDevelopment;
		this._extensionsMessages = {};
		this._allRequestedActivateEvents = Object.create(null);

		this._onDidRegisterExtensions = new Emitter<void>();

		this._extensionHostProcessManagers = [];
		this._extensionHostProcessActivationTimes = Object.create(null);
		this._extensionHostExtensionRuntimeErrors = Object.create(null);

		this.startDelayed(lifecycleService);

		if (this._environmentService.disableExtensions) {
			this._notificationService.info(nls.localize('extensionsDisabled', "All extensions are disabled."));
		}
	}

	private startDelayed(lifecycleService: ILifecycleService): void {
		let started = false;
		const startOnce = () => {
			if (!started) {
				started = true;

				this._startExtensionHostProcess([]);
				this._scanAndHandleExtensions();
			}
		};

		// delay extension host creation and extension scanning
		// until the workbench is restoring. we cannot defer the
		// extension host more (LifecyclePhase.Running) because
		// some editors require the extension host to restore
		// and this would result in a deadlock
		// see https://github.com/Microsoft/vscode/issues/41322
		lifecycleService.when(LifecyclePhase.Restoring).then(() => {
			// we add an additional delay of 800ms because the extension host
			// starting is a potential expensive operation and we do no want
			// to fight with editors, viewlets and panels restoring.
			setTimeout(() => startOnce(), 800);
		});

		// if we are running before the 800ms delay, make sure to start
		// the extension host right away though.
		lifecycleService.when(LifecyclePhase.Running).then(() => startOnce());
	}

	public dispose(): void {
		super.dispose();
	}

	public get onDidRegisterExtensions(): Event<void> {
		return this._onDidRegisterExtensions.event;
	}

	public restartExtensionHost(): void {
		this._stopExtensionHostProcess();
		this._startExtensionHostProcess(Object.keys(this._allRequestedActivateEvents));
	}

	public startExtensionHost(): void {
		this._startExtensionHostProcess(Object.keys(this._allRequestedActivateEvents));
	}

	public stopExtensionHost(): void {
		this._stopExtensionHostProcess();
	}

	private _stopExtensionHostProcess(): void {
		const previouslyActivatedExtensionIds = Object.keys(this._extensionHostProcessActivationTimes);

		for (let i = 0; i < this._extensionHostProcessManagers.length; i++) {
			this._extensionHostProcessManagers[i].dispose();
		}
		this._extensionHostProcessManagers = [];
		this._extensionHostProcessActivationTimes = Object.create(null);
		this._extensionHostExtensionRuntimeErrors = Object.create(null);

		if (previouslyActivatedExtensionIds.length > 0) {
			this._onDidChangeExtensionsStatus.fire(previouslyActivatedExtensionIds);
		}
	}

	private _startExtensionHostProcess(initialActivationEvents: string[]): void {
		this._stopExtensionHostProcess();

		const extHostProcessWorker = this._instantiationService.createInstance(ExtensionHostProcessWorker, this.getExtensions());
		const extHostProcessManager = this._instantiationService.createInstance(ExtensionHostProcessManager, extHostProcessWorker, initialActivationEvents);
		extHostProcessManager.onDidCrash(([code, signal]) => this._onExtensionHostCrashed(code, signal));
		this._extensionHostProcessManagers.push(extHostProcessManager);
	}

	private _onExtensionHostCrashed(code: number, signal: string): void {
		console.error('Extension host terminated unexpectedly. Code: ', code, ' Signal: ', signal);
		this._stopExtensionHostProcess();

		let message = nls.localize('extensionHostProcess.crash', "Extension host terminated unexpectedly.");
		if (code === 87) {
			message = nls.localize('extensionHostProcess.unresponsiveCrash', "Extension host terminated because it was not responsive.");
		}

		this._notificationService.prompt(Severity.Error, message,
			[{
				label: nls.localize('devTools', "Open Developer Tools"),
				run: () => this._windowService.openDevTools()
			},
			{
				label: nls.localize('restart', "Restart Extension Host"),
				run: () => this._startExtensionHostProcess(Object.keys(this._allRequestedActivateEvents))
			}]
		);
	}

	// ---- begin IExtensionService

	public activateByEvent(activationEvent: string): TPromise<void> {
		if (this._installedExtensionsReady.isOpen()) {
			// Extensions have been scanned and interpreted

			if (!this._registry.containsActivationEvent(activationEvent)) {
				// There is no extension that is interested in this activation event
				return NO_OP_VOID_PROMISE;
			}

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._activateByEvent(activationEvent);
		} else {
			// Extensions have not been scanned yet.

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._installedExtensionsReady.wait().then(() => this._activateByEvent(activationEvent));
		}
	}

	private _activateByEvent(activationEvent: string): TPromise<void> {
		return TPromise.join(
			this._extensionHostProcessManagers.map(extHostManager => extHostManager.activateByEvent(activationEvent))
		).then(() => { });
	}

	public whenInstalledExtensionsRegistered(): TPromise<boolean> {
		return this._installedExtensionsReady.wait();
	}

	public getExtensions(): TPromise<IExtensionDescription[]> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getAllExtensionDescriptions();
		});
	}

	public readExtensionPointContributions<T>(extPoint: IExtensionPoint<T>): TPromise<ExtensionPointContribution<T>[]> {
		return this._installedExtensionsReady.wait().then(() => {
			let availableExtensions = this._registry.getAllExtensionDescriptions();

			let result: ExtensionPointContribution<T>[] = [], resultLen = 0;
			for (let i = 0, len = availableExtensions.length; i < len; i++) {
				let desc = availableExtensions[i];

				if (desc.contributes && hasOwnProperty.call(desc.contributes, extPoint.name)) {
					result[resultLen++] = new ExtensionPointContribution<T>(desc, desc.contributes[extPoint.name]);
				}
			}

			return result;
		});
	}

	public getExtensionsStatus(): { [id: string]: IExtensionsStatus; } {
		let result: { [id: string]: IExtensionsStatus; } = Object.create(null);
		if (this._registry) {
			const extensions = this._registry.getAllExtensionDescriptions();
			for (let i = 0, len = extensions.length; i < len; i++) {
				const extension = extensions[i];
				const id = extension.id;
				result[id] = {
					messages: this._extensionsMessages[id],
					activationTimes: this._extensionHostProcessActivationTimes[id],
					runtimeErrors: this._extensionHostExtensionRuntimeErrors[id],
				};
			}
		}
		return result;
	}

	public canProfileExtensionHost(): boolean {
		for (let i = 0, len = this._extensionHostProcessManagers.length; i < len; i++) {
			const extHostProcessManager = this._extensionHostProcessManagers[i];
			if (extHostProcessManager.canProfileExtensionHost()) {
				return true;
			}
		}
		return false;
	}

	public startExtensionHostProfile(): TPromise<ProfileSession> {
		for (let i = 0, len = this._extensionHostProcessManagers.length; i < len; i++) {
			const extHostProcessManager = this._extensionHostProcessManagers[i];
			if (extHostProcessManager.canProfileExtensionHost()) {
				return extHostProcessManager.startExtensionHostProfile();
			}
		}
		throw new Error('Extension host not running or no inspect port available');
	}

	// ---- end IExtensionService

	// --- impl

	private _scanAndHandleExtensions(): void {

		this._getRuntimeExtensions()
			.then(runtimeExtensons => {
				this._registry = new ExtensionDescriptionRegistry(runtimeExtensons);

				let availableExtensions = this._registry.getAllExtensionDescriptions();
				let extensionPoints = ExtensionsRegistry.getExtensionPoints();

				let messageHandler = (msg: IMessage) => this._handleExtensionPointMessage(msg);

				for (let i = 0, len = extensionPoints.length; i < len; i++) {
					ExtensionService._handleExtensionPoint(extensionPoints[i], availableExtensions, messageHandler);
				}

				mark('extensionHostReady');
				this._installedExtensionsReady.open();
				this._onDidRegisterExtensions.fire(void 0);
				this._onDidChangeExtensionsStatus.fire(availableExtensions.map(e => e.id));
			});
	}

	private _getRuntimeExtensions(): TPromise<IExtensionDescription[]> {
		const log = new Logger((severity, source, message) => {
			this._logOrShowMessage(severity, this._isDev ? messageWithSource(source, message) : message);
		});

		return ExtensionService._scanInstalledExtensions(this._windowService, this._notificationService, this._environmentService, log)
			.then(({ system, user, development }) => {
				return this._extensionEnablementService.getDisabledExtensions()
					.then(disabledExtensions => {
						let result: { [extensionId: string]: IExtensionDescription; } = {};
						let extensionsToDisable: IExtensionIdentifier[] = [];
						let userMigratedSystemExtensions: IExtensionIdentifier[] = [{ id: BetterMergeId }];

						system.forEach((systemExtension) => {
							if (disabledExtensions.every(disabled => !areSameExtensions(disabled, systemExtension))) {
								result[systemExtension.id] = systemExtension;
							}
						});

						user.forEach((userExtension) => {
							if (result.hasOwnProperty(userExtension.id)) {
								log.warn(userExtension.extensionLocation.fsPath, nls.localize('overwritingExtension', "Overwriting extension {0} with {1}.", result[userExtension.id].extensionLocation.fsPath, userExtension.extensionLocation.fsPath));
							}
							if (disabledExtensions.every(disabled => !areSameExtensions(disabled, userExtension))) {
								// Check if the extension is changed to system extension
								let userMigratedSystemExtension = userMigratedSystemExtensions.filter(userMigratedSystemExtension => areSameExtensions(userMigratedSystemExtension, { id: userExtension.id }))[0];
								if (userMigratedSystemExtension) {
									extensionsToDisable.push(userMigratedSystemExtension);
								} else {
									result[userExtension.id] = userExtension;
								}
							}
						});

						development.forEach(developedExtension => {
							log.info('', nls.localize('extensionUnderDevelopment', "Loading development extension at {0}", developedExtension.extensionLocation.fsPath));
							if (result.hasOwnProperty(developedExtension.id)) {
								log.warn(developedExtension.extensionLocation.fsPath, nls.localize('overwritingExtension', "Overwriting extension {0} with {1}.", result[developedExtension.id].extensionLocation.fsPath, developedExtension.extensionLocation.fsPath));
							}
							// Do not disable extensions under development
							result[developedExtension.id] = developedExtension;
						});

						const runtimeExtensions = Object.keys(result).map(name => result[name]);

						this._telemetryService.publicLog('extensionsScanned', {
							totalCount: runtimeExtensions.length,
							disabledCount: disabledExtensions.length
						});

						if (extensionsToDisable.length) {
							return this.extensionManagementService.getInstalled(LocalExtensionType.User)
								.then(installed => {
									const toDisable = installed.filter(i => extensionsToDisable.some(e => areSameExtensions({ id: getGalleryExtensionIdFromLocal(i) }, e)));
									return TPromise.join(toDisable.map(e => this._extensionEnablementService.setEnablement(e, EnablementState.Disabled)));
								})
								.then(() => {
									this._storageService.store(BetterMergeDisabledNowKey, true);
									return runtimeExtensions;
								});
						} else {
							return runtimeExtensions;
						}
					});
			}).then(extensions => this._updateEnableProposedApi(extensions));
	}

	private _updateEnableProposedApi(extensions: IExtensionDescription[]): IExtensionDescription[] {
		const enableProposedApiForAll = !this._environmentService.isBuilt || (!!this._environmentService.extensionDevelopmentPath && product.nameLong.indexOf('Insiders') >= 0);
		const enableProposedApiFor = this._environmentService.args['enable-proposed-api'] || [];
		for (const extension of extensions) {
			if (!isFalsyOrEmpty(product.extensionAllowedProposedApi)
				&& product.extensionAllowedProposedApi.indexOf(extension.id) >= 0
			) {
				// fast lane -> proposed api is available to all extensions
				// that are listed in product.json-files
				extension.enableProposedApi = true;

			} else if (extension.enableProposedApi && !extension.isBuiltin) {
				if (
					!enableProposedApiForAll &&
					enableProposedApiFor.indexOf(extension.id) < 0
				) {
					extension.enableProposedApi = false;
					console.error(`Extension '${extension.id} cannot use PROPOSED API (must started out of dev or enabled via --enable-proposed-api)`);

				} else {
					// proposed api is available when developing or when an extension was explicitly
					// spelled out via a command line argument
					console.warn(`Extension '${extension.id}' uses PROPOSED API which is subject to change and removal without notice.`);
				}
			}
		}
		return extensions;
	}

	private _handleExtensionPointMessage(msg: IMessage) {

		if (!this._extensionsMessages[msg.extensionId]) {
			this._extensionsMessages[msg.extensionId] = [];
		}
		this._extensionsMessages[msg.extensionId].push(msg);

		const extension = this._registry.getExtensionDescription(msg.extensionId);
		const strMsg = `[${msg.extensionId}]: ${msg.message}`;
		if (extension && extension.isUnderDevelopment) {
			// This message is about the extension currently being developed
			this._showMessageToUser(msg.type, strMsg);
		} else {
			this._logMessageInConsole(msg.type, strMsg);
		}

		if (!this._isDev && msg.extensionId) {
			const { type, extensionId, extensionPointId, message } = msg;
			/* __GDPR__
				"extensionsMessage" : {
					"type" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
					"extensionId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"extensionPointId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"message": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
				}
			*/
			this._telemetryService.publicLog('extensionsMessage', {
				type, extensionId, extensionPointId, message
			});
		}
	}

	private static async _validateExtensionsCache(windowService: IWindowService, notificationService: INotificationService, environmentService: IEnvironmentService, cacheKey: string, input: ExtensionScannerInput): TPromise<void> {
		const cacheFolder = path.join(environmentService.userDataPath, MANIFEST_CACHE_FOLDER);
		const cacheFile = path.join(cacheFolder, cacheKey);

		const expected = JSON.parse(JSON.stringify(await ExtensionScanner.scanExtensions(input, new NullLogger())));

		const cacheContents = await this._readExtensionCache(environmentService, cacheKey);
		if (!cacheContents) {
			// Cache has been deleted by someone else, which is perfectly fine...
			return;
		}
		const actual = cacheContents.result;

		if (objects.equals(expected, actual)) {
			// Cache is valid and running with it is perfectly fine...
			return;
		}

		try {
			await pfs.del(cacheFile);
		} catch (err) {
			errors.onUnexpectedError(err);
			console.error(err);
		}

		notificationService.prompt(
			Severity.Error,
			nls.localize('extensionCache.invalid', "Extensions have been modified on disk. Please reload the window."),
			[{
				label: nls.localize('reloadWindow', "Reload Window"),
				run: () => windowService.reloadWindow()
			}]
		);
	}

	private static async _readExtensionCache(environmentService: IEnvironmentService, cacheKey: string): TPromise<IExtensionCacheData> {
		const cacheFolder = path.join(environmentService.userDataPath, MANIFEST_CACHE_FOLDER);
		const cacheFile = path.join(cacheFolder, cacheKey);

		try {
			const cacheRawContents = await pfs.readFile(cacheFile, 'utf8');
			return JSON.parse(cacheRawContents);
		} catch (err) {
			// That's ok...
		}

		return null;
	}

	private static async _writeExtensionCache(environmentService: IEnvironmentService, cacheKey: string, cacheContents: IExtensionCacheData): TPromise<void> {
		const cacheFolder = path.join(environmentService.userDataPath, MANIFEST_CACHE_FOLDER);
		const cacheFile = path.join(cacheFolder, cacheKey);

		try {
			await pfs.mkdirp(cacheFolder);
		} catch (err) {
			// That's ok...
		}

		try {
			await pfs.writeFile(cacheFile, JSON.stringify(cacheContents));
		} catch (err) {
			// That's ok...
		}
	}

	private static async _scanExtensionsWithCache(windowService: IWindowService, notificationService: INotificationService, environmentService: IEnvironmentService, cacheKey: string, input: ExtensionScannerInput, log: ILog): TPromise<IExtensionDescription[]> {
		if (input.devMode) {
			// Do not cache when running out of sources...
			return ExtensionScanner.scanExtensions(input, log);
		}

		try {
			const folderStat = await pfs.stat(input.absoluteFolderPath);
			input.mtime = folderStat.mtime.getTime();
		} catch (err) {
			// That's ok...
		}

		const cacheContents = await this._readExtensionCache(environmentService, cacheKey);
		if (cacheContents && cacheContents.input && ExtensionScannerInput.equals(cacheContents.input, input)) {
			// Validate the cache asynchronously after 5s
			setTimeout(async () => {
				try {
					await this._validateExtensionsCache(windowService, notificationService, environmentService, cacheKey, input);
				} catch (err) {
					errors.onUnexpectedError(err);
				}
			}, 5000);
			return cacheContents.result.map((extensionDescription) => {
				// revive URI object
				(<IRelaxedExtensionDescription>extensionDescription).extensionLocation = URI.revive(extensionDescription.extensionLocation);
				return extensionDescription;
			});
		}

		const counterLogger = new CounterLogger(log);
		const result = await ExtensionScanner.scanExtensions(input, counterLogger);
		if (counterLogger.errorCnt === 0) {
			// Nothing bad happened => cache the result
			const cacheContents: IExtensionCacheData = {
				input: input,
				result: result
			};
			await this._writeExtensionCache(environmentService, cacheKey, cacheContents);
		}

		return result;
	}

	private static _scanInstalledExtensions(windowService: IWindowService, notificationService: INotificationService, environmentService: IEnvironmentService, log: ILog): TPromise<{ system: IExtensionDescription[], user: IExtensionDescription[], development: IExtensionDescription[] }> {

		const translationConfig: TPromise<Translations> = platform.translationsConfigFile
			? pfs.readFile(platform.translationsConfigFile, 'utf8').then((content) => {
				try {
					return JSON.parse(content) as Translations;
				} catch (err) {
					return Object.create(null);
				}
			}, (err) => {
				return Object.create(null);
			})
			: TPromise.as(Object.create(null));

		return translationConfig.then((translations) => {
			const version = pkg.version;
			const commit = product.commit;
			const devMode = !!process.env['VSCODE_DEV'];
			const locale = platform.locale;

			const builtinExtensions = this._scanExtensionsWithCache(
				windowService,
				notificationService,
				environmentService,
				BUILTIN_MANIFEST_CACHE_FILE,
				new ExtensionScannerInput(version, commit, locale, devMode, getSystemExtensionsRoot(), true, false, translations),
				log
			);

			let finalBuiltinExtensions: TPromise<IExtensionDescription[]> = builtinExtensions;

			if (devMode) {
				const builtInExtensionsFilePath = path.normalize(path.join(URI.parse(require.toUrl('')).fsPath, '..', 'build', 'builtInExtensions.json'));
				const builtInExtensions = pfs.readFile(builtInExtensionsFilePath, 'utf8')
					.then<IBuiltInExtension[]>(raw => JSON.parse(raw));

				const controlFilePath = path.join(os.homedir(), '.vscode-oss-dev', 'extensions', 'control.json');
				const controlFile = pfs.readFile(controlFilePath, 'utf8')
					.then<IBuiltInExtensionControl>(raw => JSON.parse(raw), () => ({} as any));

				const input = new ExtensionScannerInput(version, commit, locale, devMode, getExtraDevSystemExtensionsRoot(), true, false, translations);
				const extraBuiltinExtensions = TPromise.join([builtInExtensions, controlFile])
					.then(([builtInExtensions, control]) => new ExtraBuiltInExtensionResolver(builtInExtensions, control))
					.then(resolver => ExtensionScanner.scanExtensions(input, log, resolver));

				finalBuiltinExtensions = TPromise.join([builtinExtensions, extraBuiltinExtensions]).then(([builtinExtensions, extraBuiltinExtensions]) => {
					let resultMap: { [id: string]: IExtensionDescription; } = Object.create(null);
					for (let i = 0, len = builtinExtensions.length; i < len; i++) {
						resultMap[builtinExtensions[i].id] = builtinExtensions[i];
					}
					// Overwrite with extensions found in extra
					for (let i = 0, len = extraBuiltinExtensions.length; i < len; i++) {
						resultMap[extraBuiltinExtensions[i].id] = extraBuiltinExtensions[i];
					}

					let resultArr = Object.keys(resultMap).map((id) => resultMap[id]);
					resultArr.sort((a, b) => {
						const aLastSegment = path.basename(a.extensionLocation.fsPath);
						const bLastSegment = path.basename(b.extensionLocation.fsPath);
						if (aLastSegment < bLastSegment) {
							return -1;
						}
						if (aLastSegment > bLastSegment) {
							return 1;
						}
						return 0;
					});
					return resultArr;
				});
			}

			const userExtensions = (
				environmentService.disableExtensions || !environmentService.extensionsPath
					? TPromise.as([])
					: this._scanExtensionsWithCache(
						windowService,
						notificationService,
						environmentService,
						USER_MANIFEST_CACHE_FILE,
						new ExtensionScannerInput(version, commit, locale, devMode, environmentService.extensionsPath, false, false, translations),
						log
					)
			);

			// Always load developed extensions while extensions development
			const developedExtensions = (
				environmentService.isExtensionDevelopment
					? ExtensionScanner.scanOneOrMultipleExtensions(
						new ExtensionScannerInput(version, commit, locale, devMode, environmentService.extensionDevelopmentPath, false, true, translations), log
					)
					: TPromise.as([])
			);

			return TPromise.join([finalBuiltinExtensions, userExtensions, developedExtensions]).then((extensionDescriptions: IExtensionDescription[][]) => {
				const system = extensionDescriptions[0];
				const user = extensionDescriptions[1];
				const development = extensionDescriptions[2];
				return { system, user, development };
			}).then(null, err => {
				log.error('', err);
				return { system: [], user: [], development: [] };
			});
		});

	}

	private static _handleExtensionPoint<T>(extensionPoint: ExtensionPoint<T>, availableExtensions: IExtensionDescription[], messageHandler: (msg: IMessage) => void): void {
		let users: IExtensionPointUser<T>[] = [], usersLen = 0;
		for (let i = 0, len = availableExtensions.length; i < len; i++) {
			let desc = availableExtensions[i];

			if (desc.contributes && hasOwnProperty.call(desc.contributes, extensionPoint.name)) {
				users[usersLen++] = {
					description: desc,
					value: desc.contributes[extensionPoint.name],
					collector: new ExtensionMessageCollector(messageHandler, desc, extensionPoint.name)
				};
			}
		}

		extensionPoint.acceptUsers(users);
	}

	private _showMessageToUser(severity: Severity, msg: string): void {
		if (severity === Severity.Error || severity === Severity.Warning) {
			this._notificationService.notify({ severity, message: msg });
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	private _logMessageInConsole(severity: Severity, msg: string): void {
		if (severity === Severity.Error) {
			console.error(msg);
		} else if (severity === Severity.Warning) {
			console.warn(msg);
		} else {
			console.log(msg);
		}
	}

	// -- called by extension host

	public _logOrShowMessage(severity: Severity, msg: string): void {
		if (this._isDev) {
			this._showMessageToUser(severity, msg);
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	public _onExtensionActivated(extensionId: string, startup: boolean, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationEvent: string): void {
		this._extensionHostProcessActivationTimes[extensionId] = new ActivationTimes(startup, codeLoadingTime, activateCallTime, activateResolvedTime, activationEvent);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _onExtensionRuntimeError(extensionId: string, err: Error): void {
		if (!this._extensionHostExtensionRuntimeErrors[extensionId]) {
			this._extensionHostExtensionRuntimeErrors[extensionId] = [];
		}
		this._extensionHostExtensionRuntimeErrors[extensionId].push(err);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _addMessage(extensionId: string, severity: Severity, message: string): void {
		if (!this._extensionsMessages[extensionId]) {
			this._extensionsMessages[extensionId] = [];
		}
		this._extensionsMessages[extensionId].push({
			type: severity,
			message: message,
			extensionId: null,
			extensionPointId: null
		});
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}
}

function asLoggingProtocol(protocol: IMessagePassingProtocol): IMessagePassingProtocol {

	protocol.onMessage(msg => {
		console.log('%c[Extension \u2192 Window]%c[len: ' + strings.pad(msg.length, 5, ' ') + ']', 'color: darkgreen', 'color: grey', msg);
	});

	return {
		onMessage: protocol.onMessage,

		send(msg: any) {
			protocol.send(msg);
			console.log('%c[Window \u2192 Extension]%c[len: ' + strings.pad(msg.length, 5, ' ') + ']', 'color: darkgreen', 'color: grey', msg);
		}
	};
}

interface IExtensionCacheData {
	input: ExtensionScannerInput;
	result: IExtensionDescription[];
}

export class Logger implements ILog {

	private readonly _messageHandler: (severity: Severity, source: string, message: string) => void;

	constructor(
		messageHandler: (severity: Severity, source: string, message: string) => void
	) {
		this._messageHandler = messageHandler;
	}

	public error(source: string, message: string): void {
		this._messageHandler(Severity.Error, source, message);
	}

	public warn(source: string, message: string): void {
		this._messageHandler(Severity.Warning, source, message);
	}

	public info(source: string, message: string): void {
		this._messageHandler(Severity.Info, source, message);
	}
}

class CounterLogger implements ILog {

	public errorCnt = 0;
	public warnCnt = 0;
	public infoCnt = 0;

	constructor(private readonly _actual: ILog) {
	}

	public error(source: string, message: string): void {
		this._actual.error(source, message);
	}

	public warn(source: string, message: string): void {
		this._actual.warn(source, message);
	}

	public info(source: string, message: string): void {
		this._actual.info(source, message);
	}
}

class NullLogger implements ILog {
	public error(source: string, message: string): void {
	}
	public warn(source: string, message: string): void {
	}
	public info(source: string, message: string): void {
	}
}

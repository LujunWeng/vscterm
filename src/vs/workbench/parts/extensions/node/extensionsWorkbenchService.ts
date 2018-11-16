/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import { readFile } from 'vs/base/node/pfs';
import * as semver from 'semver';
import * as path from 'path';
import { Event, Emitter } from 'vs/base/common/event';
import { index } from 'vs/base/common/arrays';
import { assign } from 'vs/base/common/objects';
import { ThrottledDelayer } from 'vs/base/common/async';
import { isPromiseCanceledError } from 'vs/base/common/errors';
import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IPager, mapPager, singlePagePager } from 'vs/base/common/paging';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import {
	IExtensionManagementService, IExtensionGalleryService, ILocalExtension, IGalleryExtension, IQueryOptions, IExtensionManifest,
	InstallExtensionEvent, DidInstallExtensionEvent, LocalExtensionType, DidUninstallExtensionEvent, IExtensionEnablementService, IExtensionIdentifier, EnablementState, IExtensionTipsService, InstallOperation
} from 'vs/platform/extensionManagement/common/extensionManagement';
import { getGalleryExtensionIdFromLocal, getGalleryExtensionTelemetryData, getLocalExtensionTelemetryData, areSameExtensions, getMaliciousExtensionsSet } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWindowService } from 'vs/platform/windows/common/windows';
import Severity from 'vs/base/common/severity';
import URI from 'vs/base/common/uri';
import { IExtension, IExtensionDependencies, ExtensionState, IExtensionsWorkbenchService, AutoUpdateConfigurationKey } from 'vs/workbench/parts/extensions/common/extensions';
import { IEditorService, SIDE_GROUP, ACTIVE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { IURLService, IURLHandler } from 'vs/platform/url/common/url';
import { ExtensionsInput } from 'vs/workbench/parts/extensions/common/extensionsInput';
import product from 'vs/platform/node/product';
import { ILogService } from 'vs/platform/log/common/log';
import { IProgressService2, ProgressLocation } from 'vs/platform/progress/common/progress';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService } from 'vs/platform/notification/common/notification';

interface IExtensionStateProvider<T> {
	(extension: Extension): T;
}

class Extension implements IExtension {

	public enablementState: EnablementState = EnablementState.Enabled;

	constructor(
		private galleryService: IExtensionGalleryService,
		private stateProvider: IExtensionStateProvider<ExtensionState>,
		public local: ILocalExtension,
		public gallery: IGalleryExtension,
		private telemetryService: ITelemetryService
	) { }

	get type(): LocalExtensionType {
		return this.local ? this.local.type : null;
	}

	get name(): string {
		return this.gallery ? this.gallery.name : this.local.manifest.name;
	}

	get displayName(): string {
		if (this.gallery) {
			return this.gallery.displayName || this.gallery.name;
		}

		return this.local.manifest.displayName || this.local.manifest.name;
	}

	get id(): string {
		if (this.gallery) {
			return this.gallery.identifier.id;
		}
		return getGalleryExtensionIdFromLocal(this.local);
	}

	get uuid(): string {
		return this.gallery ? this.gallery.identifier.uuid : this.local.identifier.uuid;
	}

	get publisher(): string {
		return this.gallery ? this.gallery.publisher : this.local.manifest.publisher;
	}

	get publisherDisplayName(): string {
		if (this.gallery) {
			return this.gallery.publisherDisplayName || this.gallery.publisher;
		}

		if (this.local.metadata && this.local.metadata.publisherDisplayName) {
			return this.local.metadata.publisherDisplayName;
		}

		return this.local.manifest.publisher;
	}

	get version(): string {
		return this.local ? this.local.manifest.version : this.gallery.version;
	}

	get latestVersion(): string {
		return this.gallery ? this.gallery.version : this.local.manifest.version;
	}

	get description(): string {
		return this.gallery ? this.gallery.description : this.local.manifest.description;
	}

	get url(): string {
		if (!product.extensionsGallery || !this.gallery) {
			return null;
		}

		return `${product.extensionsGallery.itemUrl}?itemName=${this.publisher}.${this.name}`;
	}

	get downloadUrl(): string {
		if (!product.extensionsGallery) {
			return null;
		}

		return `${product.extensionsGallery.serviceUrl}/publishers/${this.publisher}/vsextensions/${this.name}/${this.latestVersion}/vspackage`;
	}

	get iconUrl(): string {
		return this.galleryIconUrl || this.localIconUrl || this.defaultIconUrl;
	}

	get iconUrlFallback(): string {
		return this.galleryIconUrlFallback || this.localIconUrl || this.defaultIconUrl;
	}

	private get localIconUrl(): string {
		return this.local && this.local.manifest.icon
			&& URI.file(path.join(this.local.path, this.local.manifest.icon)).toString();
	}

	private get galleryIconUrl(): string {
		return this.gallery && this.gallery.assets.icon.uri;
	}

	private get galleryIconUrlFallback(): string {
		return this.gallery && this.gallery.assets.icon.fallbackUri;
	}

	private get defaultIconUrl(): string {
		if (this.type === LocalExtensionType.System) {
			if (this.local.manifest && this.local.manifest.contributes) {
				if (Array.isArray(this.local.manifest.contributes.themes) && this.local.manifest.contributes.themes.length) {
					return require.toUrl('../browser/media/theme-icon.png');
				}
				if (Array.isArray(this.local.manifest.contributes.languages) && this.local.manifest.contributes.languages.length) {
					return require.toUrl('../browser/media/language-icon.png');
				}
			}
		}
		return require.toUrl('../browser/media/defaultIcon.png');
	}

	get repository(): string {
		return this.gallery && this.gallery.assets.repository.uri;
	}

	get licenseUrl(): string {
		return this.gallery && this.gallery.assets.license && this.gallery.assets.license.uri;
	}

	get state(): ExtensionState {
		return this.stateProvider(this);
	}

	public isMalicious: boolean = false;

	get installCount(): number {
		return this.gallery ? this.gallery.installCount : null;
	}

	get rating(): number {
		return this.gallery ? this.gallery.rating : null;
	}

	get ratingCount(): number {
		return this.gallery ? this.gallery.ratingCount : null;
	}

	get outdated(): boolean {
		return !!this.gallery && this.type === LocalExtensionType.User && semver.gt(this.latestVersion, this.version);
	}

	get telemetryData(): any {
		const { local, gallery } = this;

		if (gallery) {
			return getGalleryExtensionTelemetryData(gallery);
		} else {
			return getLocalExtensionTelemetryData(local);
		}
	}

	get preview(): boolean {
		return this.gallery ? this.gallery.preview : false;
	}

	private isGalleryOutdated(): boolean {
		return this.local && this.gallery && semver.gt(this.local.manifest.version, this.gallery.version);
	}

	getManifest(): TPromise<IExtensionManifest> {
		if (this.gallery && !this.isGalleryOutdated()) {
			if (this.gallery.assets.manifest) {
				return this.galleryService.getManifest(this.gallery);
			}
			this.telemetryService.publicLog('extensions:NotFoundManifest', this.telemetryData);
			return TPromise.wrapError<IExtensionManifest>(new Error('not available'));
		}

		return TPromise.as(this.local.manifest);
	}

	getReadme(): TPromise<string> {
		if (this.gallery && !this.isGalleryOutdated()) {
			if (this.gallery.assets.readme) {
				return this.galleryService.getReadme(this.gallery);
			}
			this.telemetryService.publicLog('extensions:NotFoundReadMe', this.telemetryData);
		}

		if (this.local && this.local.readmeUrl) {
			const uri = URI.parse(this.local.readmeUrl);
			return readFile(uri.fsPath, 'utf8');
		}

		if (this.type === LocalExtensionType.System) {
			return TPromise.as(`# ${this.displayName || this.name}
**Notice** This is a an extension that is bundled with Visual Studio Code.

${this.description}
`);
		}

		return TPromise.wrapError<string>(new Error('not available'));
	}

	getChangelog(): TPromise<string> {
		if (this.gallery && this.gallery.assets.changelog && !this.isGalleryOutdated()) {
			return this.galleryService.getChangelog(this.gallery);
		}

		const changelogUrl = this.local && this.local.changelogUrl;

		if (!changelogUrl) {
			return TPromise.wrapError<string>(new Error('not available'));
		}

		const uri = URI.parse(changelogUrl);

		if (uri.scheme === 'file') {
			return readFile(uri.fsPath, 'utf8');
		}

		return TPromise.wrapError<string>(new Error('not available'));
	}

	get dependencies(): string[] {
		const { local, gallery } = this;
		if (gallery && !this.isGalleryOutdated()) {
			return gallery.properties.dependencies;
		}
		if (local && local.manifest.extensionDependencies) {
			return local.manifest.extensionDependencies;
		}
		return [];
	}
}

class ExtensionDependencies implements IExtensionDependencies {

	private _hasDependencies: boolean = null;

	constructor(private _extension: IExtension, private _identifier: string, private _map: Map<string, IExtension>, private _dependent: IExtensionDependencies = null) { }

	get hasDependencies(): boolean {
		if (this._hasDependencies === null) {
			this._hasDependencies = this.computeHasDependencies();
		}
		return this._hasDependencies;
	}

	get extension(): IExtension {
		return this._extension;
	}

	get identifier(): string {
		return this._identifier;
	}

	get dependent(): IExtensionDependencies {
		return this._dependent;
	}

	get dependencies(): IExtensionDependencies[] {
		if (!this.hasDependencies) {
			return [];
		}
		return this._extension.dependencies.map(d => new ExtensionDependencies(this._map.get(d), d, this._map, this));
	}

	private computeHasDependencies(): boolean {
		if (this._extension && this._extension.dependencies.length > 0) {
			let dependent = this._dependent;
			while (dependent !== null) {
				if (dependent.identifier === this.identifier) {
					return false;
				}
				dependent = dependent.dependent;
			}
			return true;
		}
		return false;
	}
}

export class ExtensionsWorkbenchService implements IExtensionsWorkbenchService, IURLHandler {

	private static readonly SyncPeriod = 1000 * 60 * 60 * 12; // 12 hours

	_serviceBrand: any;
	private stateProvider: IExtensionStateProvider<ExtensionState>;
	private installing: Extension[] = [];
	private uninstalling: Extension[] = [];
	private installed: Extension[] = [];
	private syncDelayer: ThrottledDelayer<void>;
	private autoUpdateDelayer: ThrottledDelayer<void>;
	private disposables: IDisposable[] = [];

	private readonly _onChange: Emitter<void> = new Emitter<void>();
	get onChange(): Event<void> { return this._onChange.event; }

	private _extensionAllowedBadgeProviders: string[];

	constructor(
		@IInstantiationService private instantiationService: IInstantiationService,
		@IEditorService private editorService: IEditorService,
		@IExtensionManagementService private extensionService: IExtensionManagementService,
		@IExtensionGalleryService private galleryService: IExtensionGalleryService,
		@IConfigurationService private configurationService: IConfigurationService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IDialogService private dialogService: IDialogService,
		@INotificationService private notificationService: INotificationService,
		@IURLService urlService: IURLService,
		@IExtensionEnablementService private extensionEnablementService: IExtensionEnablementService,
		@IWindowService private windowService: IWindowService,
		@ILogService private logService: ILogService,
		@IProgressService2 private progressService: IProgressService2,
		@IExtensionTipsService private extensionTipsService: IExtensionTipsService
	) {
		this.stateProvider = ext => this.getExtensionState(ext);

		extensionService.onInstallExtension(this.onInstallExtension, this, this.disposables);
		extensionService.onDidInstallExtension(this.onDidInstallExtension, this, this.disposables);
		extensionService.onUninstallExtension(this.onUninstallExtension, this, this.disposables);
		extensionService.onDidUninstallExtension(this.onDidUninstallExtension, this, this.disposables);
		extensionEnablementService.onEnablementChanged(this.onEnablementChanged, this, this.disposables);

		this.syncDelayer = new ThrottledDelayer<void>(ExtensionsWorkbenchService.SyncPeriod);
		this.autoUpdateDelayer = new ThrottledDelayer<void>(1000);

		urlService.registerHandler(this);

		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AutoUpdateConfigurationKey)) {
				if (this.isAutoUpdateEnabled()) {
					this.checkForUpdates();
				}
			}
		}, this, this.disposables);

		this.queryLocal().done(() => this.eventuallySyncWithGallery(true));
	}

	get local(): IExtension[] {
		const installing = this.installing
			.filter(e => !this.installed.some(installed => installed.id === e.id))
			.map(e => e);

		return [...this.installed, ...installing];
	}

	queryLocal(): TPromise<IExtension[]> {
		return this.extensionService.getInstalled().then(result => {
			const installedById = index(this.installed, e => e.local.identifier.id);
			this.installed = result.map(local => {
				const extension = installedById[local.identifier.id] || new Extension(this.galleryService, this.stateProvider, local, null, this.telemetryService);
				extension.local = local;
				extension.enablementState = this.extensionEnablementService.getEnablementState(local);
				return extension;
			});

			this._onChange.fire();
			return this.local;
		});
	}

	queryGallery(options: IQueryOptions = {}): TPromise<IPager<IExtension>> {
		return this.extensionService.getExtensionsReport().then(report => {
			const maliciousSet = getMaliciousExtensionsSet(report);

			return this.galleryService.query(options)
				.then(result => mapPager(result, gallery => this.fromGallery(gallery, maliciousSet)))
				.then(null, err => {
					if (/No extension gallery service configured/.test(err.message)) {
						return TPromise.as(singlePagePager([]));
					}

					return TPromise.wrapError<IPager<IExtension>>(err);
				});
		});
	}

	loadDependencies(extension: IExtension): TPromise<IExtensionDependencies> {
		if (!extension.dependencies.length) {
			return TPromise.wrap<IExtensionDependencies>(null);
		}

		return this.extensionService.getExtensionsReport().then(report => {
			const maliciousSet = getMaliciousExtensionsSet(report);

			return this.galleryService.loadAllDependencies((<Extension>extension).dependencies.map(id => <IExtensionIdentifier>{ id }))
				.then(galleryExtensions => galleryExtensions.map(galleryExtension => this.fromGallery(galleryExtension, maliciousSet)))
				.then(extensions => [...this.local, ...extensions])
				.then(extensions => {
					const map = new Map<string, IExtension>();
					for (const extension of extensions) {
						map.set(extension.id, extension);
					}
					return new ExtensionDependencies(extension, extension.id, map);
				});
		});
	}

	open(extension: IExtension, sideByside: boolean = false): TPromise<any> {
		return this.editorService.openEditor(this.instantiationService.createInstance(ExtensionsInput, extension), null, sideByside ? SIDE_GROUP : ACTIVE_GROUP);
	}

	private fromGallery(gallery: IGalleryExtension, maliciousExtensionSet: Set<string>): Extension {
		let result = this.getInstalledExtensionMatchingGallery(gallery);

		if (result) {
			// Loading the compatible version only there is an engine property
			// Otherwise falling back to old way so that we will not make many roundtrips
			if (gallery.properties.engine) {
				this.galleryService.loadCompatibleVersion(gallery)
					.then(compatible => compatible ? this.syncLocalWithGalleryExtension(result, compatible) : null);
			} else {
				this.syncLocalWithGalleryExtension(result, gallery);
			}
		} else {
			result = new Extension(this.galleryService, this.stateProvider, null, gallery, this.telemetryService);
		}

		if (maliciousExtensionSet.has(result.id)) {
			result.isMalicious = true;
		}

		return result;
	}

	private getInstalledExtensionMatchingGallery(gallery: IGalleryExtension): Extension {
		for (const installed of this.installed) {
			if (installed.uuid) { // Installed from Gallery
				if (installed.uuid === gallery.identifier.uuid) {
					return installed;
				}
			} else {
				if (installed.id === gallery.identifier.id) { // Installed from other sources
					return installed;
				}
			}
		}
		return null;
	}

	private syncLocalWithGalleryExtension(local: Extension, gallery: IGalleryExtension) {
		// Sync the local extension with gallery extension if local extension doesnot has metadata
		(local.local.metadata ? TPromise.as(local.local) : this.extensionService.updateMetadata(local.local, { id: gallery.identifier.uuid, publisherDisplayName: gallery.publisherDisplayName, publisherId: gallery.publisherId }))
			.then(localExtension => {
				local.local = localExtension;
				local.gallery = gallery;
				this._onChange.fire();
				this.eventuallyAutoUpdateExtensions();
			});
	}

	checkForUpdates(): TPromise<void> {
		return this.syncDelayer.trigger(() => this.syncWithGallery(), 0);
	}

	private isAutoUpdateEnabled(): boolean {
		return this.configurationService.getValue(AutoUpdateConfigurationKey);
	}

	private eventuallySyncWithGallery(immediate = false): void {
		const loop = () => this.syncWithGallery().then(() => this.eventuallySyncWithGallery());
		const delay = immediate ? 0 : ExtensionsWorkbenchService.SyncPeriod;

		this.syncDelayer.trigger(loop, delay)
			.done(null, err => null);
	}

	private syncWithGallery(): TPromise<void> {
		const ids = [], names = [];
		for (const installed of this.installed) {
			if (installed.type === LocalExtensionType.User) {
				if (installed.uuid) {
					ids.push(installed.uuid);
				} else {
					names.push(installed.id);
				}
			}
		}

		const promises = [];
		if (ids.length) {
			promises.push(this.queryGallery({ ids, pageSize: ids.length }));
		}
		if (names.length) {
			promises.push(this.queryGallery({ names, pageSize: names.length }));
		}

		return TPromise.join(promises) as TPromise<any>;
	}

	private eventuallyAutoUpdateExtensions(): void {
		this.autoUpdateDelayer.trigger(() => this.autoUpdateExtensions())
			.done(null, err => null);
	}

	private autoUpdateExtensions(): TPromise<any> {
		if (!this.isAutoUpdateEnabled()) {
			return TPromise.as(null);
		}

		const toUpdate = this.local.filter(e => e.outdated && (e.state !== ExtensionState.Installing));
		return TPromise.join(toUpdate.map(e => this.install(e)));
	}

	canInstall(extension: IExtension): boolean {
		if (!(extension instanceof Extension)) {
			return false;
		}

		if (extension.isMalicious) {
			return false;
		}

		return !!(extension as Extension).gallery;
	}

	install(extension: string | IExtension): TPromise<void> {
		if (typeof extension === 'string') {
			return this.progressService.withProgress({
				location: ProgressLocation.Extensions,
				title: nls.localize('installingVSIXExtension', 'Installing extension from VSIX...'),
				source: `${extension}`
			}, () => this.extensionService.install(extension).then(() => null));
		}

		if (!(extension instanceof Extension)) {
			return undefined;
		}

		if (extension.isMalicious) {
			return TPromise.wrapError<void>(new Error(nls.localize('malicious', "This extension is reported to be problematic.")));
		}

		const ext = extension as Extension;
		const gallery = ext.gallery;

		if (!gallery) {
			return TPromise.wrapError<void>(new Error('Missing gallery'));
		}

		return this.progressService.withProgress({
			location: ProgressLocation.Extensions,
			title: nls.localize('installingMarketPlaceExtension', 'Installing extension from Marketplace....'),
			source: `${extension.id}`
		}, () => this.extensionService.installFromGallery(gallery).then(() => null));
	}

	setEnablement(extensions: IExtension | IExtension[], enablementState: EnablementState): TPromise<void> {
		extensions = Array.isArray(extensions) ? extensions : [extensions];
		return this.promptAndSetEnablement(extensions, enablementState);
	}

	uninstall(extension: IExtension): TPromise<void> {
		if (!(extension instanceof Extension)) {
			return undefined;
		}

		const ext = extension as Extension;
		const local = ext.local || this.installed.filter(e => e.id === extension.id)[0].local;

		if (!local) {
			return TPromise.wrapError<void>(new Error('Missing local'));
		}

		this.logService.info(`Requested uninstalling the extension ${extension.id} from window ${this.windowService.getCurrentWindowId()}`);
		return this.progressService.withProgress({
			location: ProgressLocation.Extensions,
			title: nls.localize('uninstallingExtension', 'Uninstalling extension....'),
			source: `${local.identifier.id}`
		}, () => this.extensionService.uninstall(local));
	}

	reinstall(extension: IExtension): TPromise<void> {
		if (!(extension instanceof Extension)) {
			return undefined;
		}

		const ext = extension as Extension;
		const local = ext.local || this.installed.filter(e => e.id === extension.id)[0].local;

		if (!local) {
			return TPromise.wrapError<void>(new Error('Missing local'));
		}

		return this.progressService.withProgress({
			location: ProgressLocation.Extensions,
			source: `${local.identifier.id}`
		}, () => this.extensionService.reinstallFromGallery(local).then(() => null));
	}

	private promptAndSetEnablement(extensions: IExtension[], enablementState: EnablementState): TPromise<any> {
		const allDependencies = this.getDependenciesRecursively(extensions, this.local, enablementState, []);
		if (allDependencies.length > 0) {
			if (enablementState === EnablementState.Enabled || enablementState === EnablementState.WorkspaceEnabled) {
				return this.promptForDependenciesAndEnable(extensions, allDependencies, enablementState);
			} else {
				return this.promptForDependenciesAndDisable(extensions, allDependencies, enablementState);
			}
		}
		return this.checkAndSetEnablement(extensions, [], enablementState);
	}

	private promptForDependenciesAndEnable(extensions: IExtension[], dependencies: IExtension[], enablementState: EnablementState): TPromise<any> {
		const message = nls.localize('enableDependeciesConfirmation', "Enabling an extension also enables its dependencies. Would you like to continue?");
		const buttons = [
			nls.localize('enable', "Yes"),
			nls.localize('doNotEnable', "No")
		];
		return this.dialogService.show(Severity.Info, message, buttons, { cancelId: 1 })
			.then<void>(value => {
				if (value === 0) {
					return this.checkAndSetEnablement(extensions, dependencies, enablementState);
				}
				return TPromise.as(null);
			});
	}

	private promptForDependenciesAndDisable(extensions: IExtension[], dependencies: IExtension[], enablementState: EnablementState): TPromise<void> {
		const message = nls.localize('disableDependeciesConfirmation', "Would you like to disable the dependencies of the extensions also?");
		const buttons = [
			nls.localize('yes', "Yes"),
			nls.localize('no', "No"),
			nls.localize('cancel', "Cancel")
		];
		return this.dialogService.show(Severity.Info, message, buttons, { cancelId: 2 })
			.then<void>(value => {
				if (value === 0) {
					return this.checkAndSetEnablement(extensions, dependencies, enablementState);
				}
				if (value === 1) {
					return this.checkAndSetEnablement(extensions, [], enablementState);
				}
				return TPromise.as(null);
			});
	}

	private checkAndSetEnablement(extensions: IExtension[], dependencies: IExtension[], enablementState: EnablementState): TPromise<any> {
		const allExtensions = [...extensions, ...dependencies];
		const enable = enablementState === EnablementState.Enabled || enablementState === EnablementState.WorkspaceEnabled;
		if (!enable) {
			for (const extension of extensions) {
				let dependents = this.getDependentsAfterDisablement(extension, allExtensions, this.local, enablementState);
				if (dependents.length) {
					return TPromise.wrapError<void>(new Error(this.getDependentsErrorMessage(extension, dependents)));
				}
			}
		}
		return TPromise.join(allExtensions.map(e => this.doSetEnablement(e, enablementState)));
	}

	private getDependenciesRecursively(extensions: IExtension[], installed: IExtension[], enablementState: EnablementState, checked: IExtension[]): IExtension[] {
		const toCheck = extensions.filter(e => checked.indexOf(e) === -1);
		if (toCheck.length) {
			for (const extension of toCheck) {
				checked.push(extension);
			}
			const dependenciesToDisable = installed.filter(i => {
				if (checked.indexOf(i) !== -1) {
					return false;
				}
				if (i.enablementState === enablementState) {
					return false;
				}
				return i.type === LocalExtensionType.User && extensions.some(extension => extension.dependencies.indexOf(i.id) !== -1);
			});
			if (dependenciesToDisable.length) {
				const depsOfDeps = this.getDependenciesRecursively(dependenciesToDisable, installed, enablementState, checked);
				return [...dependenciesToDisable, ...depsOfDeps];
			}
		}
		return [];
	}

	private getDependentsAfterDisablement(extension: IExtension, extensionsToDisable: IExtension[], installed: IExtension[], enablementState: EnablementState): IExtension[] {
		return installed.filter(i => {
			if (i.dependencies.length === 0) {
				return false;
			}
			if (i === extension) {
				return false;
			}
			if (i.enablementState === EnablementState.WorkspaceDisabled || i.enablementState === EnablementState.Disabled) {
				return false;
			}
			if (extensionsToDisable.indexOf(i) !== -1) {
				return false;
			}
			return i.dependencies.some(dep => {
				if (extension.id === dep) {
					return true;
				}
				return extensionsToDisable.some(d => d.id === dep);
			});
		});
	}

	private getDependentsErrorMessage(extension: IExtension, dependents: IExtension[]): string {
		if (dependents.length === 1) {
			return nls.localize('singleDependentError', "Cannot disable extension '{0}'. Extension '{1}' depends on this.", extension.displayName, dependents[0].displayName);
		}
		if (dependents.length === 2) {
			return nls.localize('twoDependentsError', "Cannot disable extension '{0}'. Extensions '{1}' and '{2}' depend on this.",
				extension.displayName, dependents[0].displayName, dependents[1].displayName);
		}
		return nls.localize('multipleDependentsError', "Cannot disable extension '{0}'. Extensions '{1}', '{2}' and others depend on this.",
			extension.displayName, dependents[0].displayName, dependents[1].displayName);
	}

	private doSetEnablement(extension: IExtension, enablementState: EnablementState): TPromise<boolean> {
		return this.extensionEnablementService.setEnablement(extension.local, enablementState)
			.then(changed => {
				if (changed) {
					/* __GDPR__
					"extension:enable" : {
						"${include}": [
							"${GalleryExtensionTelemetryData}"
						]
					}
					*/
					/* __GDPR__
					"extension:disable" : {
						"${include}": [
							"${GalleryExtensionTelemetryData}"
						]
					}
					*/
					this.telemetryService.publicLog(enablementState === EnablementState.Enabled || enablementState === EnablementState.WorkspaceEnabled ? 'extension:enable' : 'extension:disable', extension.telemetryData);
				}
				return changed;
			});
	}

	get allowedBadgeProviders(): string[] {
		if (!this._extensionAllowedBadgeProviders) {
			this._extensionAllowedBadgeProviders = (product.extensionAllowedBadgeProviders || []).map(s => s.toLowerCase());
		}
		return this._extensionAllowedBadgeProviders;
	}

	private onInstallExtension(event: InstallExtensionEvent): void {
		const { gallery } = event;

		if (!gallery) {
			return;
		}

		let extension = this.installed.filter(e => areSameExtensions(e, gallery.identifier))[0];

		if (!extension) {
			extension = new Extension(this.galleryService, this.stateProvider, null, gallery, this.telemetryService);
		}

		extension.gallery = gallery;

		this.installing.push(extension);

		this._onChange.fire();
	}

	private onDidInstallExtension(event: DidInstallExtensionEvent): void {
		const { local, zipPath, error, gallery } = event;
		const installingExtension = gallery ? this.installing.filter(e => areSameExtensions(e, gallery.identifier))[0] : null;
		const extension: Extension = installingExtension ? installingExtension : zipPath ? new Extension(this.galleryService, this.stateProvider, local, null, this.telemetryService) : null;
		if (extension) {
			this.installing = installingExtension ? this.installing.filter(e => e !== installingExtension) : this.installing;
			if (!error) {
				const installed = this.installed.filter(e => e.id === extension.id)[0];
				extension.local = local;
				if (installed) {
					installed.local = local;
				} else {
					this.installed.push(extension);
				}
			}
			if (extension.gallery && event.operation === InstallOperation.Install) {
				// Report recommendation telemetry only for gallery extensions that are first time installs
				this.reportExtensionRecommendationsTelemetry(installingExtension);
			}
		}
		this._onChange.fire();
	}

	private onUninstallExtension({ id }: IExtensionIdentifier): void {
		this.logService.info(`Uninstalling the extension ${id} from window ${this.windowService.getCurrentWindowId()}`);
		const extension = this.installed.filter(e => e.local.identifier.id === id)[0];
		const newLength = this.installed.filter(e => e.local.identifier.id !== id).length;
		// TODO: Ask @Joao why is this?
		if (newLength === this.installed.length) {
			return;
		}

		const uninstalling = this.uninstalling.filter(e => e.local.identifier.id === id)[0] || extension;
		this.uninstalling = [uninstalling, ...this.uninstalling.filter(e => e.local.identifier.id !== id)];

		this._onChange.fire();
	}

	private onDidUninstallExtension({ identifier, error }: DidUninstallExtensionEvent): void {
		const id = identifier.id;
		if (!error) {
			this.installed = this.installed.filter(e => e.local.identifier.id !== id);
		}

		const uninstalling = this.uninstalling.filter(e => e.local.identifier.id === id)[0];
		this.uninstalling = this.uninstalling.filter(e => e.local.identifier.id !== id);
		if (!uninstalling) {
			return;
		}

		this._onChange.fire();
	}

	private onEnablementChanged(identifier: IExtensionIdentifier) {
		const [extension] = this.local.filter(e => areSameExtensions(e, identifier));
		if (extension) {
			const enablementState = this.extensionEnablementService.getEnablementState(extension.local);
			if (enablementState !== extension.enablementState) {
				extension.enablementState = enablementState;
				this._onChange.fire();
			}
		}
	}

	private getExtensionState(extension: Extension): ExtensionState {
		if (extension.gallery && this.installing.some(e => e.gallery && areSameExtensions(e.gallery.identifier, extension.gallery.identifier))) {
			return ExtensionState.Installing;
		}

		if (this.uninstalling.some(e => e.id === extension.id)) {
			return ExtensionState.Uninstalling;
		}

		const local = this.installed.filter(e => e === extension || (e.gallery && extension.gallery && areSameExtensions(e.gallery.identifier, extension.gallery.identifier)))[0];
		return local ? ExtensionState.Installed : ExtensionState.Uninstalled;
	}

	private reportExtensionRecommendationsTelemetry(extension: Extension): void {
		const extRecommendations = this.extensionTipsService.getAllRecommendationsWithReason() || {};
		const recommendationReason = extRecommendations[extension.id.toLowerCase()];
		if (recommendationReason) {
			const recommendationsData = { recommendationReason: recommendationReason.reasonId };
			const data = extension.telemetryData;
			/* __GDPR__
				"extensionGallery:install:recommendations" : {
					"recommendationReason": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
					"${include}": [
						"${GalleryExtensionTelemetryData}"
					]
				}
			*/
			this.telemetryService.publicLog('extensionGallery:install:recommendations', assign(data, recommendationsData));
		}
	}

	private onError(err: any): void {
		if (isPromiseCanceledError(err)) {
			return;
		}

		const message = err && err.message || '';

		if (/getaddrinfo ENOTFOUND|getaddrinfo ENOENT|connect EACCES|connect ECONNREFUSED/.test(message)) {
			return;
		}

		this.notificationService.error(err);
	}

	async handleURL(uri: URI): TPromise<boolean> {
		if (!/^extension/.test(uri.path)) {
			return false;
		}

		this.onOpenExtensionUrl(uri);
		return true;
	}

	private onOpenExtensionUrl(uri: URI): void {
		const match = /^extension\/([^/]+)$/.exec(uri.path);

		if (!match) {
			return;
		}

		const extensionId = match[1];

		this.queryLocal().then(local => {
			const extension = local.filter(local => areSameExtensions({ id: local.id }, { id: extensionId }))[0];

			if (extension) {
				return this.windowService.show()
					.then(() => this.open(extension));
			}

			return this.queryGallery({ names: [extensionId], source: 'uri' }).then(result => {
				if (result.total < 1) {
					return TPromise.as(null);
				}

				const extension = result.firstPage[0];

				return this.windowService.show().then(() => {
					return this.open(extension).then(() => {
						this.notificationService.prompt(
							Severity.Info,
							nls.localize('installConfirmation', "Would you like to install the '{0}' extension?", extension.displayName, extension.publisher),
							[{
								label: nls.localize('install', "Install"),
								run: () => this.install(extension).done(undefined, error => this.onError(error))
							}]
						);
					});
				});
			});
		}).done(undefined, error => this.onError(error));
	}

	dispose(): void {
		this.syncDelayer.cancel();
		this.disposables = dispose(this.disposables);
	}
}

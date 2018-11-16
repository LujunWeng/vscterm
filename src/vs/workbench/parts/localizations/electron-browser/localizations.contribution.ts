/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { IWorkbenchContribution, Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { IJSONContributionRegistry, Extensions as JSONExtensions } from 'vs/platform/jsonschemas/common/jsonContributionRegistry';
import { IWorkbenchActionRegistry, Extensions } from 'vs/workbench/common/actions';
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import { Disposable } from 'vs/base/common/lifecycle';
import { ConfigureLocaleAction } from 'vs/workbench/parts/localizations/electron-browser/localizationsActions';
import { ExtensionsRegistry } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ILocalizationsService, LanguageType } from 'vs/platform/localizations/common/localizations';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import * as platform from 'vs/base/common/platform';
import { IExtensionManagementService, DidInstallExtensionEvent, LocalExtensionType, IExtensionGalleryService, IGalleryExtension, InstallOperation } from 'vs/platform/extensionManagement/common/extensionManagement';
import { INotificationService } from 'vs/platform/notification/common/notification';
import Severity from 'vs/base/common/severity';
import { IJSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditing';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import URI from 'vs/base/common/uri';
import { join } from 'vs/base/common/paths';
import { IWindowsService } from 'vs/platform/windows/common/windows';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { TPromise } from 'vs/base/common/winjs.base';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { VIEWLET_ID as EXTENSIONS_VIEWLET_ID, IExtensionsViewlet } from 'vs/workbench/parts/extensions/common/extensions';
import { minimumTranslatedStrings } from 'vs/platform/node/minimalTranslations';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

// Register action to configure locale and related settings
const registry = Registry.as<IWorkbenchActionRegistry>(Extensions.WorkbenchActions);
registry.registerWorkbenchAction(new SyncActionDescriptor(ConfigureLocaleAction, ConfigureLocaleAction.ID, ConfigureLocaleAction.LABEL), 'Configure Display Language');

export class LocalizationWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILocalizationsService private localizationService: ILocalizationsService,
		@INotificationService private notificationService: INotificationService,
		@IJSONEditingService private jsonEditingService: IJSONEditingService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IWindowsService private windowsService: IWindowsService,
		@IStorageService private storageService: IStorageService,
		@IExtensionManagementService private extensionManagementService: IExtensionManagementService,
		@IExtensionGalleryService private galleryService: IExtensionGalleryService,
		@IViewletService private viewletService: IViewletService,
		@ITelemetryService private telemetryService: ITelemetryService
	) {
		super();
		this.updateLocaleDefintionSchema();
		this.checkAndInstall();
		this._register(this.localizationService.onDidLanguagesChange(() => this.updateLocaleDefintionSchema()));
		this._register(this.extensionManagementService.onDidInstallExtension(e => this.onDidInstallExtension(e)));
	}

	private updateLocaleDefintionSchema(): void {
		this.localizationService.getLanguageIds()
			.then(languageIds => {
				let lowercaseLanguageIds: string[] = [];
				languageIds.forEach((languageId) => {
					let lowercaseLanguageId = languageId.toLowerCase();
					if (lowercaseLanguageId !== languageId) {
						lowercaseLanguageIds.push(lowercaseLanguageId);
					}
				});
				registerLocaleDefinitionSchema([...languageIds, ...lowercaseLanguageIds]);
			});
	}

	private onDidInstallExtension(e: DidInstallExtensionEvent): void {
		const donotAskUpdateKey = 'langugage.update.donotask';
		if (!this.storageService.getBoolean(donotAskUpdateKey) && e.local && e.operation === InstallOperation.Install && e.local.manifest.contributes && e.local.manifest.contributes.localizations && e.local.manifest.contributes.localizations.length) {
			const locale = e.local.manifest.contributes.localizations[0].languageId;
			if (platform.language !== locale) {
				const updateAndRestart = platform.locale !== locale;
				this.notificationService.prompt(
					Severity.Info,
					updateAndRestart ? localize('updateLocale', "Would you like to change VS Code's UI language to {0} and restart?", e.local.manifest.contributes.localizations[0].languageName || e.local.manifest.contributes.localizations[0].languageId)
						: localize('activateLanguagePack', "Would you like to restart VS Code to activate the language pack that was just installed?"),
					[{
						label: localize('yes', "Yes"),
						run: () => {
							const file = URI.file(join(this.environmentService.appSettingsHome, 'locale.json'));
							const updatePromise = updateAndRestart ? this.jsonEditingService.write(file, { key: 'locale', value: locale }, true) : TPromise.as(null);
							updatePromise.then(() => this.windowsService.relaunch({}), e => this.notificationService.error(e));
						}
					}, {
						label: localize('no', "No"),
						run: () => { }
					}, {
						label: localize('neverAgain', "Don't Show Again"),
						isSecondary: true,
						run: () => this.storageService.store(donotAskUpdateKey, true)
					}]
				);
			}
		}
	}

	private migrateToMarketplaceLanguagePack(language: string): void {
		this.isLanguageInstalled(language)
			.then(installed => {
				if (!installed) {
					this.getLanguagePackExtension(language)
						.then(extension => {
							if (extension) {
								this.notificationService.prompt(Severity.Warning, localize('install language pack', "In the near future, VS Code will only support language packs in the form of Marketplace extensions. Please install the '{0}' extension in order to continue to use the currently configured language. ", extension.displayName || extension.displayName),
									[
										{ label: localize('install', "Install"), run: () => this.installExtension(extension) },
										{ label: localize('more information', "More Information..."), run: () => window.open('https://go.microsoft.com/fwlink/?linkid=872941') }
									]);
							}
						});
				}
			});
	}

	private checkAndInstall(): void {
		const language = platform.language;
		const locale = platform.locale;
		const languagePackSuggestionIgnoreList = <string[]>JSON.parse(this.storageService.get('extensionsAssistant/languagePackSuggestionIgnore', StorageScope.GLOBAL, '[]'));

		if (!this.galleryService.isEnabled()) {
			return;
		}
		if (language !== 'en' && language !== 'en_us') {
			this.migrateToMarketplaceLanguagePack(language);
			return;
		}
		if (locale === 'en' || locale === 'en_us') {
			return;
		}
		if (language === locale || languagePackSuggestionIgnoreList.indexOf(language) > -1) {
			return;
		}

		this.isLanguageInstalled(locale)
			.then(installed => {
				if (installed) {
					return;
				}

				const ceintlExtensionSearch = this.galleryService.query({ names: [`MS-CEINTL.vscode-language-pack-${locale}`], pageSize: 1 });
				const tagSearch = this.galleryService.query({ text: `tag:lp-${locale}`, pageSize: 1 });

				TPromise.join([ceintlExtensionSearch, tagSearch]).then(([ceintlResult, tagResult]) => {
					if (ceintlResult.total === 0 && tagResult.total === 0) {
						return;
					}

					const extensionToInstall = ceintlResult.total === 1 ? ceintlResult.firstPage[0] : tagResult.total === 1 ? tagResult.firstPage[0] : null;
					const extensionToFetchTranslationsFrom = extensionToInstall || tagResult.total > 0 ? tagResult.firstPage[0] : null;

					if (!extensionToFetchTranslationsFrom || !extensionToFetchTranslationsFrom.assets.manifest) {
						return;
					}

					TPromise.join([this.galleryService.getManifest(extensionToFetchTranslationsFrom), this.galleryService.getCoreTranslation(extensionToFetchTranslationsFrom, locale)])
						.then(([manifest, translation]) => {
							const loc = manifest && manifest.contributes && manifest.contributes.localizations && manifest.contributes.localizations.filter(x => x.languageId.toLowerCase() === locale)[0];
							const languageDisplayName = loc ? (loc.localizedLanguageName || loc.languageName || locale) : locale;
							const translations = {
								...minimumTranslatedStrings,
								...(translation && translation.contents ? translation.contents['vs/platform/node/minimalTranslations'] : {})
							};
							const logUserReaction = (userReaction: string) => {
								/* __GDPR__
									"languagePackSuggestion:popup" : {
										"userReaction" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
										"language": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
									}
								*/
								this.telemetryService.publicLog('languagePackSuggestion:popup', { userReaction, language });
							};

							const searchAction = {
								label: translations['searchMarketplace'],
								run: () => {
									logUserReaction('search');
									this.viewletService.openViewlet(EXTENSIONS_VIEWLET_ID, true)
										.then(viewlet => viewlet as IExtensionsViewlet)
										.then(viewlet => {
											viewlet.search(`tag:lp-${locale}`);
											viewlet.focus();
										});
								}
							};

							const installAndRestartAction = {
								label: translations['installAndRestart'],
								run: () => {
									logUserReaction('installAndRestart');
									this.installExtension(extensionToInstall).then(() => this.windowsService.relaunch({}));
								}
							};

							const promptMessage = translations[extensionToInstall ? 'installAndRestartMessage' : 'showLanguagePackExtensions']
								.replace('{0}', languageDisplayName);

							this.notificationService.prompt(
								Severity.Info,
								promptMessage,
								[extensionToInstall ? installAndRestartAction : searchAction,
								{
									label: localize('neverAgain', "Don't Show Again"),
									isSecondary: true,
									run: () => {
										languagePackSuggestionIgnoreList.push(language);
										this.storageService.store(
											'extensionsAssistant/languagePackSuggestionIgnore',
											JSON.stringify(languagePackSuggestionIgnoreList),
											StorageScope.GLOBAL
										);
										logUserReaction('neverShowAgain');
									}
								}],
								() => {
									logUserReaction('cancelled');
								}
							);

						});
				});
			});

	}

	private getLanguagePackExtension(language: string): TPromise<IGalleryExtension> {
		return this.localizationService.getLanguageIds(LanguageType.Core)
			.then(coreLanguages => {
				if (coreLanguages.some(c => c.toLowerCase() === language)) {
					const extensionIdPrefix = language === 'zh-cn' ? 'zh-hans' : language === 'zh-tw' ? 'zh-hant' : language;
					const extensionId = `MS-CEINTL.vscode-language-pack-${extensionIdPrefix}`;
					return this.galleryService.query({ names: [extensionId], pageSize: 1 })
						.then(result => result.total === 1 ? result.firstPage[0] : null);
				}
				return null;
			});
	}

	private isLanguageInstalled(language: string): TPromise<boolean> {
		return this.extensionManagementService.getInstalled(LocalExtensionType.User)
			.then(installed => installed.some(i => i.manifest && i.manifest.contributes && i.manifest.contributes.localizations && i.manifest.contributes.localizations.length && i.manifest.contributes.localizations.some(l => l.languageId.toLowerCase() === language)));
	}

	private installExtension(extension: IGalleryExtension): TPromise<void> {
		return this.viewletService.openViewlet(EXTENSIONS_VIEWLET_ID)
			.then(viewlet => viewlet as IExtensionsViewlet)
			.then(viewlet => viewlet.search(`@id:${extension.identifier.id}`))
			.then(() => this.extensionManagementService.installFromGallery(extension))
			.then(() => null, err => this.notificationService.error(err));
	}
}

function registerLocaleDefinitionSchema(languages: string[]): void {
	const localeDefinitionFileSchemaId = 'vscode://schemas/locale';
	const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
	// Keep en-US since we generated files with that content.
	jsonRegistry.registerSchema(localeDefinitionFileSchemaId, {
		id: localeDefinitionFileSchemaId,
		allowComments: true,
		description: 'Locale Definition file',
		type: 'object',
		default: {
			'locale': 'en'
		},
		required: ['locale'],
		properties: {
			locale: {
				type: 'string',
				enum: languages,
				description: localize('JsonSchema.locale', 'The UI Language to use.')
			}
		}
	});
}

registerLocaleDefinitionSchema([platform.language]);
const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(LocalizationWorkbenchContribution, LifecyclePhase.Eventually);

ExtensionsRegistry.registerExtensionPoint('localizations', [], {
	description: localize('vscode.extension.contributes.localizations', "Contributes localizations to the editor"),
	type: 'array',
	default: [],
	items: {
		type: 'object',
		required: ['languageId', 'translations'],
		defaultSnippets: [{ body: { languageId: '', languageName: '', languageNameLocalized: '', translations: [{ id: 'vscode', path: '' }] } }],
		properties: {
			languageId: {
				description: localize('vscode.extension.contributes.localizations.languageId', 'Id of the language into which the display strings are translated.'),
				type: 'string'
			},
			languageName: {
				description: localize('vscode.extension.contributes.localizations.languageName', 'Name of the language in English.'),
				type: 'string'
			},
			languageNameLocalized: {
				description: localize('vscode.extension.contributes.localizations.languageNameLocalized', 'Name of the language in contributed language.'),
				type: 'string'
			},
			translations: {
				description: localize('vscode.extension.contributes.localizations.translations', 'List of translations associated to the language.'),
				type: 'array',
				default: [{ id: 'vscode', path: '' }],
				items: {
					type: 'object',
					required: ['id', 'path'],
					properties: {
						id: {
							type: 'string',
							description: localize('vscode.extension.contributes.localizations.translations.id', "Id of VS Code or Extension for which this translation is contributed to. Id of VS Code is always `vscode` and of extension should be in format `publisherId.extensionName`."),
							pattern: '^((vscode)|([a-z0-9A-Z][a-z0-9\-A-Z]*)\\.([a-z0-9A-Z][a-z0-9\-A-Z]*))$',
							patternErrorMessage: localize('vscode.extension.contributes.localizations.translations.id.pattern', "Id should be `vscode` or in format `publisherId.extensionName` for translating VS code or an extension respectively.")
						},
						path: {
							type: 'string',
							description: localize('vscode.extension.contributes.localizations.translations.path', "A relative path to a file containing translations for the language.")
						}
					},
					defaultSnippets: [{ body: { id: '', path: '' } }],
				},
			}
		}
	}
});
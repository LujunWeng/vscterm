/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* --------------------------------------------------------------------------------------------
 * Includes code from typescript-sublime-plugin project, obtained from
 * https://github.com/Microsoft/TypeScript-Sublime-Plugin/blob/master/TypeScript%20Indent.tmPreferences
 * ------------------------------------------------------------------------------------------ */

import { workspace, Memento, Diagnostic, Range, Disposable, Uri, DiagnosticSeverity, DiagnosticTag } from 'vscode';

import * as Proto from './protocol';
import * as PConst from './protocol.const';

import TypeScriptServiceClient from './typescriptServiceClient';
import LanguageProvider from './languageProvider';

import TypingsStatus, { AtaProgressReporter } from './utils/typingsStatus';
import VersionStatus from './utils/versionStatus';
import { TypeScriptServerPlugin } from './utils/plugins';
import * as typeConverters from './utils/typeConverters';
import { CommandManager } from './utils/commandManager';
import { LanguageDescription } from './utils/languageDescription';
import LogDirectoryProvider from './utils/logDirectoryProvider';
import { disposeAll } from './utils/dispose';
import { DiagnosticKind } from './features/diagnostics';

// Style check diagnostics that can be reported as warnings
const styleCheckDiagnostics = [
	6133, 	// variable is declared but never used
	6138, 	// property is declared but its value is never read
	7027,	// unreachable code detected
	7028,	// unused label
	7029,	// fall through case in switch
	7030	// not all code paths return a value
];

export default class TypeScriptServiceClientHost {
	private readonly ataProgressReporter: AtaProgressReporter;
	private readonly typingsStatus: TypingsStatus;
	private readonly client: TypeScriptServiceClient;
	private readonly languages: LanguageProvider[] = [];
	private readonly languagePerId = new Map<string, LanguageProvider>();
	private readonly disposables: Disposable[] = [];
	private readonly versionStatus: VersionStatus;
	private reportStyleCheckAsWarnings: boolean = true;

	constructor(
		descriptions: LanguageDescription[],
		workspaceState: Memento,
		plugins: TypeScriptServerPlugin[],
		private readonly commandManager: CommandManager,
		logDirectoryProvider: LogDirectoryProvider
	) {
		const handleProjectCreateOrDelete = () => {
			this.client.execute('reloadProjects', null, false);
			this.triggerAllDiagnostics();
		};
		const handleProjectChange = () => {
			setTimeout(() => {
				this.triggerAllDiagnostics();
			}, 1500);
		};
		const configFileWatcher = workspace.createFileSystemWatcher('**/[tj]sconfig.json');
		this.disposables.push(configFileWatcher);
		configFileWatcher.onDidCreate(handleProjectCreateOrDelete, this, this.disposables);
		configFileWatcher.onDidDelete(handleProjectCreateOrDelete, this, this.disposables);
		configFileWatcher.onDidChange(handleProjectChange, this, this.disposables);

		this.client = new TypeScriptServiceClient(workspaceState, version => this.versionStatus.onDidChangeTypeScriptVersion(version), plugins, logDirectoryProvider);
		this.disposables.push(this.client);

		this.client.onDiagnosticsReceived(({ kind, resource, diagnostics }) => {
			this.diagnosticsReceived(kind, resource, diagnostics);
		}, null, this.disposables);

		this.client.onConfigDiagnosticsReceived(diag => this.configFileDiagnosticsReceived(diag), null, this.disposables);
		this.client.onResendModelsRequested(() => this.populateService(), null, this.disposables);

		this.client.onProjectUpdatedInBackground(files => {
			const resources = files.openFiles.map(Uri.file);
			for (const language of this.languagePerId.values()) {
				language.getErr(resources);
			}
		}, null, this.disposables);

		this.versionStatus = new VersionStatus(resource => this.client.normalizePath(resource));
		this.disposables.push(this.versionStatus);

		this.typingsStatus = new TypingsStatus(this.client);
		this.ataProgressReporter = new AtaProgressReporter(this.client);

		for (const description of descriptions) {
			const manager = new LanguageProvider(this.client, description, this.commandManager, this.client.telemetryReporter, this.typingsStatus);
			this.languages.push(manager);
			this.disposables.push(manager);
			this.languagePerId.set(description.id, manager);
		}

		this.client.ensureServiceStarted();
		this.client.onReady(() => {
			if (!this.client.apiVersion.has230Features()) {
				return;
			}

			const languages = new Set<string>();
			for (const plugin of plugins) {
				for (const language of plugin.languages) {
					languages.add(language);
				}
			}
			if (languages.size) {
				const description: LanguageDescription = {
					id: 'typescript-plugins',
					modeIds: Array.from(languages.values()),
					diagnosticSource: 'ts-plugins',
					diagnosticOwner: 'typescript',
					isExternal: true
				};
				const manager = new LanguageProvider(this.client, description, this.commandManager, this.client.telemetryReporter, this.typingsStatus);
				this.languages.push(manager);
				this.disposables.push(manager);
				this.languagePerId.set(description.id, manager);
			}
		});

		this.client.onTsServerStarted(() => {
			this.triggerAllDiagnostics();
		});

		workspace.onDidChangeConfiguration(this.configurationChanged, this, this.disposables);
		this.configurationChanged();
	}

	public dispose(): void {
		disposeAll(this.disposables);
		this.typingsStatus.dispose();
		this.ataProgressReporter.dispose();
	}

	public get serviceClient(): TypeScriptServiceClient {
		return this.client;
	}

	public reloadProjects(): void {
		this.client.execute('reloadProjects', null, false);
		this.triggerAllDiagnostics();
	}

	public handles(resource: Uri): boolean {
		return !!this.findLanguage(resource);
	}

	private configurationChanged(): void {
		const typescriptConfig = workspace.getConfiguration('typescript');

		this.reportStyleCheckAsWarnings = typescriptConfig.get('reportStyleChecksAsWarnings', true);
	}

	private async findLanguage(resource: Uri): Promise<LanguageProvider | undefined> {
		try {
			const doc = await workspace.openTextDocument(resource);
			return this.languages.find(language => language.handles(resource, doc));
		} catch {
			return undefined;
		}
	}

	private triggerAllDiagnostics() {
		for (const language of this.languagePerId.values()) {
			language.triggerAllDiagnostics();
		}
	}

	private populateService(): void {
		// See https://github.com/Microsoft/TypeScript/issues/5530
		workspace.saveAll(false).then(() => {
			for (const language of this.languagePerId.values()) {
				language.reInitialize();
			}
		});
	}

	private async diagnosticsReceived(
		kind: DiagnosticKind,
		resource: Uri,
		diagnostics: Proto.Diagnostic[]
	): Promise<void> {
		const language = await this.findLanguage(resource);
		if (language) {
			language.diagnosticsReceived(
				kind,
				resource,
				this.createMarkerDatas(diagnostics, language.diagnosticSource));
		}
	}

	private configFileDiagnosticsReceived(event: Proto.ConfigFileDiagnosticEvent): void {
		// See https://github.com/Microsoft/TypeScript/issues/10384
		const body = event.body;
		if (!body || !body.diagnostics || !body.configFile) {
			return;
		}

		(this.findLanguage(this.client.asUrl(body.configFile))).then(language => {
			if (!language) {
				return;
			}
			if (body.diagnostics.length === 0) {
				language.configFileDiagnosticsReceived(this.client.asUrl(body.configFile), []);
			} else if (body.diagnostics.length >= 1) {
				workspace.openTextDocument(Uri.file(body.configFile)).then((document) => {
					let curly: [number, number, number] | undefined = undefined;
					let nonCurly: [number, number, number] | undefined = undefined;
					let diagnostic: Diagnostic;
					for (let index = 0; index < document.lineCount; index++) {
						const line = document.lineAt(index);
						const text = line.text;
						const firstNonWhitespaceCharacterIndex = line.firstNonWhitespaceCharacterIndex;
						if (firstNonWhitespaceCharacterIndex < text.length) {
							if (text.charAt(firstNonWhitespaceCharacterIndex) === '{') {
								curly = [index, firstNonWhitespaceCharacterIndex, firstNonWhitespaceCharacterIndex + 1];
								break;
							} else {
								const matches = /\s*([^\s]*)(?:\s*|$)/.exec(text.substr(firstNonWhitespaceCharacterIndex));
								if (matches && matches.length >= 1) {
									nonCurly = [index, firstNonWhitespaceCharacterIndex, firstNonWhitespaceCharacterIndex + matches[1].length];
								}
							}
						}
					}
					const match = curly || nonCurly;
					if (match) {
						diagnostic = new Diagnostic(new Range(match[0], match[1], match[0], match[2]), body.diagnostics[0].text);
					} else {
						diagnostic = new Diagnostic(new Range(0, 0, 0, 0), body.diagnostics[0].text);
					}
					if (diagnostic) {
						diagnostic.source = language.diagnosticSource;
						language.configFileDiagnosticsReceived(this.client.asUrl(body.configFile), [diagnostic]);
					}
				}, _error => {
					language.configFileDiagnosticsReceived(this.client.asUrl(body.configFile), [new Diagnostic(new Range(0, 0, 0, 0), body.diagnostics[0].text)]);
				});
			}
		});
	}

	private createMarkerDatas(
		diagnostics: Proto.Diagnostic[],
		source: string
	): (Diagnostic & { reportUnnecessary: any })[] {
		return diagnostics.map(tsDiag => this.tsDiagnosticToVsDiagnostic(tsDiag, source));
	}

	private tsDiagnosticToVsDiagnostic(diagnostic: Proto.Diagnostic, source: string): Diagnostic & { reportUnnecessary: any } {
		const { start, end, text } = diagnostic;
		const range = new Range(typeConverters.Position.fromLocation(start), typeConverters.Position.fromLocation(end));
		const converted = new Diagnostic(range, text);
		converted.severity = this.getDiagnosticSeverity(diagnostic);
		converted.source = diagnostic.source || source;
		if (diagnostic.code) {
			converted.code = diagnostic.code;
		}
		if (diagnostic.reportsUnnecessary) {
			converted.customTags = [DiagnosticTag.Unnecessary];
		}
		(converted as Diagnostic & { reportUnnecessary: any }).reportUnnecessary = diagnostic.reportsUnnecessary;
		return converted as Diagnostic & { reportUnnecessary: any };
	}

	private getDiagnosticSeverity(diagnostic: Proto.Diagnostic): DiagnosticSeverity {
		if (this.reportStyleCheckAsWarnings
			&& this.isStyleCheckDiagnostic(diagnostic.code)
			&& diagnostic.category === PConst.DiagnosticCategory.error
		) {
			return DiagnosticSeverity.Warning;
		}

		switch (diagnostic.category) {
			case PConst.DiagnosticCategory.error:
				return DiagnosticSeverity.Error;

			case PConst.DiagnosticCategory.warning:
				return DiagnosticSeverity.Warning;

			case PConst.DiagnosticCategory.suggestion:
				return DiagnosticSeverity.Hint;

			default:
				return DiagnosticSeverity.Error;
		}
	}

	private isStyleCheckDiagnostic(code: number | undefined): boolean {
		return code ? styleCheckDiagnostics.indexOf(code) !== -1 : false;
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
import * as path from 'path';

import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

import { languages, window, commands, ExtensionContext, Range, Position, TextDocument, CompletionItem, CompletionItemKind, TextEdit, SnippetString, FoldingRangeKind, FoldingRange, FoldingContext, CancellationToken } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, Disposable } from 'vscode-languageclient';
import { FoldingRangeRequest, FoldingRangeRequestParam, FoldingRangeClientCapabilities, FoldingRangeKind as LSFoldingRangeKind } from 'vscode-languageserver-protocol-foldingprovider';

// this method is called when vs code is activated
export function activate(context: ExtensionContext) {

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(path.join('server', 'out', 'cssServerMain.js'));
	// The debug options for the server
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6044'] };

	// If the extension is launch in debug mode the debug server options are use
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	};

	let documentSelector = ['css', 'scss', 'less'];

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		documentSelector,
		synchronize: {
			configurationSection: ['css', 'scss', 'less']
		},
		initializationOptions: {
		}
	};

	// Create the language client and start the client.
	let client = new LanguageClient('css', localize('cssserver.name', 'CSS Language Server'), serverOptions, clientOptions);
	client.registerProposedFeatures();
	client.registerFeature({
		fillClientCapabilities(capabilities: FoldingRangeClientCapabilities): void {
			let textDocumentCap = capabilities.textDocument;
			if (!textDocumentCap) {
				textDocumentCap = capabilities.textDocument = {};
			}
			textDocumentCap.foldingRange = {
				dynamicRegistration: false,
				rangeLimit: 5000,
				lineFoldingOnly: true
			};
		},
		initialize(capabilities, documentSelector): void {
		}
	});

	let disposable = client.start();
	// Push the disposable to the context's subscriptions so that the
	// client can be deactivated on extension deactivation
	context.subscriptions.push(disposable);

	let indentationRules = {
		increaseIndentPattern: /(^.*\{[^}]*$)/,
		decreaseIndentPattern: /^\s*\}/
	};

	languages.setLanguageConfiguration('css', {
		wordPattern: /(#?-?\d*\.\d\w*%?)|(::?[\w-]*(?=[^,{;]*[,{]))|(([@#.!])?[\w-?]+%?|[@#!.])/g,
		indentationRules: indentationRules
	});

	languages.setLanguageConfiguration('less', {
		wordPattern: /(#?-?\d*\.\d\w*%?)|(::?[\w-]+(?=[^,{;]*[,{]))|(([@#.!])?[\w-?]+%?|[@#!.])/g,
		indentationRules: indentationRules
	});

	languages.setLanguageConfiguration('scss', {
		wordPattern: /(#?-?\d*\.\d\w*%?)|(::?[\w-]*(?=[^,{;]*[,{]))|(([@$#.!])?[\w-?]+%?|[@#!$.])/g,
		indentationRules: indentationRules
	});

	client.onReady().then(() => {
		context.subscriptions.push(initCompletionProvider());
		context.subscriptions.push(initFoldingProvider());
	});

	function initCompletionProvider(): Disposable {
		const regionCompletionRegExpr = /^(\s*)(\/(\*\s*(#\w*)?)?)?$/;

		return languages.registerCompletionItemProvider(documentSelector, {
			provideCompletionItems(doc, pos) {
				let lineUntilPos = doc.getText(new Range(new Position(pos.line, 0), pos));
				let match = lineUntilPos.match(regionCompletionRegExpr);
				if (match) {
					let range = new Range(new Position(pos.line, match[1].length), pos);
					let beginProposal = new CompletionItem('#region', CompletionItemKind.Snippet);
					beginProposal.range = range; TextEdit.replace(range, '/* #region */');
					beginProposal.insertText = new SnippetString('/* #region $1*/');
					beginProposal.documentation = localize('folding.start', 'Folding Region Start');
					beginProposal.filterText = match[2];
					beginProposal.sortText = 'za';
					let endProposal = new CompletionItem('#endregion', CompletionItemKind.Snippet);
					endProposal.range = range;
					endProposal.insertText = '/* #endregion */';
					endProposal.documentation = localize('folding.end', 'Folding Region End');
					endProposal.sortText = 'zb';
					endProposal.filterText = match[2];
					return [beginProposal, endProposal];
				}
				return null;
			}
		});
	}

	function initFoldingProvider(): Disposable {
		function getKind(kind: string | undefined): FoldingRangeKind | undefined {
			if (kind) {
				switch (kind) {
					case LSFoldingRangeKind.Comment:
						return FoldingRangeKind.Comment;
					case LSFoldingRangeKind.Imports:
						return FoldingRangeKind.Imports;
					case LSFoldingRangeKind.Region:
						return FoldingRangeKind.Region;
				}
			}
			return void 0;
		}
		return languages.registerFoldingRangeProvider(documentSelector, {
			provideFoldingRanges(document: TextDocument, context: FoldingContext, token: CancellationToken) {
				const param: FoldingRangeRequestParam = {
					textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document)
				};
				return client.sendRequest(FoldingRangeRequest.type, param, token).then(ranges => {
					if (Array.isArray(ranges)) {
						return ranges.map(r => new FoldingRange(r.startLine, r.endLine, getKind(r.kind)));
					}
					return null;
				}, error => {
					client.logFailedRequest(FoldingRangeRequest.type, error);
					return null;
				});
			}
		});
	}

	commands.registerCommand('_css.applyCodeAction', applyCodeAction);

	function applyCodeAction(uri: string, documentVersion: number, edits: TextEdit[]) {
		let textEditor = window.activeTextEditor;
		if (textEditor && textEditor.document.uri.toString() === uri) {
			if (textEditor.document.version !== documentVersion) {
				window.showInformationMessage(`CSS fix is outdated and can't be applied to the document.`);
			}
			textEditor.edit(mutator => {
				for (let edit of edits) {
					mutator.replace(client.protocol2CodeConverter.asRange(edit.range), edit.newText);
				}
			}).then(success => {
				if (!success) {
					window.showErrorMessage('Failed to apply CSS fix to the document. Please consider opening an issue with steps to reproduce.');
				}
			});
		}
	}
}


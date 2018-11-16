/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import { join } from 'path';
import {
	languages, workspace, commands, Uri, Diagnostic, Range, Command, Disposable, CancellationToken,
	CompletionList, CompletionItem, CompletionItemKind, TextDocument, Position
} from 'vscode';


suite('languages namespace tests', () => {

	test('diagnostics, read & event', function () {
		let uri = Uri.file('/foo/bar.txt');
		let col1 = languages.createDiagnosticCollection('foo1');
		col1.set(uri, [new Diagnostic(new Range(0, 0, 0, 12), 'error1')]);

		let col2 = languages.createDiagnosticCollection('foo2');
		col2.set(uri, [new Diagnostic(new Range(0, 0, 0, 12), 'error1')]);

		let diag = languages.getDiagnostics(uri);
		assert.equal(diag.length, 2);

		let tuples = languages.getDiagnostics();
		let found = false;
		for (let [thisUri,] of tuples) {
			if (thisUri.toString() === uri.toString()) {
				found = true;
				break;
			}
		}
		assert.ok(tuples.length >= 1);
		assert.ok(found);
	});

	test('diagnostics & CodeActionProvider', function () {

		class D2 extends Diagnostic {
			customProp = { complex() { } };
			constructor() {
				super(new Range(0, 2, 0, 7), 'sonntag');
			}
		}

		let diag1 = new Diagnostic(new Range(0, 0, 0, 5), 'montag');
		let diag2 = new D2();

		let ran = false;
		let uri = Uri.parse('ttt:path.far');

		let r1 = languages.registerCodeActionsProvider({ pattern: '*.far', scheme: 'ttt' }, {
			provideCodeActions(document, range, ctx): Command[] {

				assert.equal(ctx.diagnostics.length, 2);
				let [first, second] = ctx.diagnostics;
				assert.ok(first === diag1);
				assert.ok(second === diag2);
				assert.ok(diag2 instanceof D2);
				ran = true;
				return [];
			}
		});

		let r2 = workspace.registerTextDocumentContentProvider('ttt', {
			provideTextDocumentContent() {
				return 'this is some text';
			}
		});

		let r3 = languages.createDiagnosticCollection();
		r3.set(uri, [diag1]);

		let r4 = languages.createDiagnosticCollection();
		r4.set(uri, [diag2]);

		return workspace.openTextDocument(uri).then(doc => {
			return commands.executeCommand('vscode.executeCodeActionProvider', uri, new Range(0, 0, 0, 10));
		}).then(commands => {
			assert.ok(ran);
			Disposable.from(r1, r2, r3, r4).dispose();
		});
	});

	test('completions with document filters', function () {
		let ran = false;
		let uri = Uri.file(join(workspace.rootPath || '', './bower.json'));

		let jsonDocumentFilter = [{ language: 'json', pattern: '**/package.json' }, { language: 'json', pattern: '**/bower.json' }, { language: 'json', pattern: '**/.bower.json' }];

		let r1 = languages.registerCompletionItemProvider(jsonDocumentFilter, {
			provideCompletionItems: (document: TextDocument, position: Position, token: CancellationToken): CompletionItem[] => {
				let proposal = new CompletionItem('foo');
				proposal.kind = CompletionItemKind.Property;
				ran = true;
				return [proposal];
			}
		});

		return workspace.openTextDocument(uri).then(doc => {
			return commands.executeCommand<CompletionList>('vscode.executeCompletionItemProvider', uri, new Position(1, 0));
		}).then((result: CompletionList | undefined) => {
			r1.dispose();
			assert.ok(ran);
			console.log(result!.items);
			assert.equal(result!.items[0].label, 'foo');
		});
	});
});

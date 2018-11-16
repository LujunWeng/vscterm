/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import { workspace, window, commands, ViewColumn, TextEditorViewColumnChangeEvent, Uri, Selection, Position, CancellationTokenSource, TextEditorSelectionChangeKind } from 'vscode';
import { join } from 'path';
import { closeAllEditors, pathEquals, createRandomFile } from '../utils';

suite('window namespace tests', () => {

	teardown(closeAllEditors);

	test('editor, active text editor', () => {
		return workspace.openTextDocument(join(workspace.rootPath || '', './far.js')).then(doc => {
			return window.showTextDocument(doc).then((editor) => {
				const active = window.activeTextEditor;
				assert.ok(active);
				assert.ok(pathEquals(active!.document.uri.fsPath, doc.uri.fsPath));
			});
		});
	});

	test('editor, opened via resource', () => {
		const uri = Uri.file(join(workspace.rootPath || '', './far.js'));
		return window.showTextDocument(uri).then((editor) => {
			const active = window.activeTextEditor;
			assert.ok(active);
			assert.ok(pathEquals(active!.document.uri.fsPath, uri.fsPath));
		});
	});

	// test('editor, UN-active text editor', () => {
	// 	assert.equal(window.visibleTextEditors.length, 0);
	// 	assert.ok(window.activeTextEditor === undefined);
	// });

	test('editor, assign and check view columns', () => {

		return workspace.openTextDocument(join(workspace.rootPath || '', './far.js')).then(doc => {
			let p1 = window.showTextDocument(doc, ViewColumn.One).then(editor => {
				assert.equal(editor.viewColumn, ViewColumn.One);
			});
			let p2 = window.showTextDocument(doc, ViewColumn.Two).then(editor => {
				assert.equal(editor.viewColumn, ViewColumn.Two);
			});
			let p3 = window.showTextDocument(doc, ViewColumn.Three).then(editor => {
				assert.equal(editor.viewColumn, ViewColumn.Three);
			});
			return Promise.all([p1, p2, p3]);
		});
	});

	test('editor, onDidChangeVisibleTextEditors', () => {

		let eventCounter = 0;
		let reg = window.onDidChangeVisibleTextEditors(editor => {
			eventCounter += 1;
		});

		return workspace.openTextDocument(join(workspace.rootPath || '', './far.js')).then(doc => {
			return window.showTextDocument(doc, ViewColumn.One).then(editor => {
				assert.equal(eventCounter, 1);
				return doc;
			});
		}).then(doc => {
			return window.showTextDocument(doc, ViewColumn.Two).then(editor => {
				assert.equal(eventCounter, 2);
				return doc;
			});
		}).then(doc => {
			return window.showTextDocument(doc, ViewColumn.Three).then(editor => {
				assert.equal(eventCounter, 3);
				return doc;
			});
		}).then(doc => {
			reg.dispose();
		});
	});

	test('editor, onDidChangeTextEditorViewColumn', () => {

		let actualEvent: TextEditorViewColumnChangeEvent;

		let registration1 = workspace.registerTextDocumentContentProvider('bikes', {
			provideTextDocumentContent() {
				return 'mountainbiking,roadcycling';
			}
		});

		return Promise.all([
			workspace.openTextDocument(Uri.parse('bikes://testing/one')).then(doc => window.showTextDocument(doc, ViewColumn.One)),
			workspace.openTextDocument(Uri.parse('bikes://testing/two')).then(doc => window.showTextDocument(doc, ViewColumn.Two))
		]).then(editors => {

			let [one, two] = editors;

			return new Promise(resolve => {

				let registration2 = window.onDidChangeTextEditorViewColumn(event => {
					actualEvent = event;
					registration2.dispose();
					resolve();
				});

				// close editor 1, wait a little for the event to bubble
				one.hide();

			}).then(() => {
				assert.ok(actualEvent);
				assert.ok(actualEvent.textEditor === two);
				assert.ok(actualEvent.viewColumn === two.viewColumn);

				registration1.dispose();
			});
		});
	});

	test('active editor not always correct... #49125', async function () {
		const [docA, docB] = await Promise.all([
			workspace.openTextDocument(await createRandomFile()),
			workspace.openTextDocument(await createRandomFile()),
		]);
		for (let c = 0; c < 4; c++) {
			let editorA = await window.showTextDocument(docA, ViewColumn.One);
			assert(window.activeTextEditor === editorA);

			let editorB = await window.showTextDocument(docB, ViewColumn.Two);
			assert(window.activeTextEditor === editorB);
		}
	});

	test('default column when opening a file', async () => {
		const [docA, docB, docC] = await Promise.all([
			workspace.openTextDocument(await createRandomFile()),
			workspace.openTextDocument(await createRandomFile()),
			workspace.openTextDocument(await createRandomFile())
		]);

		await window.showTextDocument(docA, ViewColumn.One);
		await window.showTextDocument(docB, ViewColumn.Two);

		assert.ok(window.activeTextEditor);
		assert.ok(window.activeTextEditor!.document === docB);
		assert.equal(window.activeTextEditor!.viewColumn, ViewColumn.Two);

		const editor = await window.showTextDocument(docC);
		assert.ok(
			window.activeTextEditor === editor,
			`wanted fileName:${editor.document.fileName}/viewColumn:${editor.viewColumn} but got fileName:${window.activeTextEditor!.document.fileName}/viewColumn:${window.activeTextEditor!.viewColumn}. a:${docA.fileName}, b:${docB.fileName}, c:${docC.fileName}`
		);
		assert.ok(window.activeTextEditor!.document === docC);
		assert.equal(window.activeTextEditor!.viewColumn, ViewColumn.Two);
	});

	test('issue #27408 - showTextDocument & vscode.diff always default to ViewColumn.One', async () => {
		const [docA, docB, docC] = await Promise.all([
			workspace.openTextDocument(await createRandomFile()),
			workspace.openTextDocument(await createRandomFile()),
			workspace.openTextDocument(await createRandomFile())
		]);

		await window.showTextDocument(docA, ViewColumn.One);
		await window.showTextDocument(docB, ViewColumn.Two);

		assert.ok(window.activeTextEditor);
		assert.ok(window.activeTextEditor!.document === docB);
		assert.equal(window.activeTextEditor!.viewColumn, ViewColumn.Two);

		await window.showTextDocument(docC, ViewColumn.Active);

		assert.ok(window.activeTextEditor!.document === docC);
		assert.equal(window.activeTextEditor!.viewColumn, ViewColumn.Two);
	});

	test('issue #5362 - Incorrect TextEditor passed by onDidChangeTextEditorSelection', (done) => {
		const file10Path = join(workspace.rootPath || '', './10linefile.ts');
		const file30Path = join(workspace.rootPath || '', './30linefile.ts');

		let finished = false;
		let failOncePlease = (err: Error) => {
			if (finished) {
				return;
			}
			finished = true;
			done(err);
		};

		let passOncePlease = () => {
			if (finished) {
				return;
			}
			finished = true;
			done(null);
		};

		let subscription = window.onDidChangeTextEditorSelection((e) => {
			let lineCount = e.textEditor.document.lineCount;
			let pos1 = e.textEditor.selections[0].active.line;
			let pos2 = e.selections[0].active.line;

			if (pos1 !== pos2) {
				failOncePlease(new Error('received invalid selection changed event!'));
				return;
			}

			if (pos1 >= lineCount) {
				failOncePlease(new Error(`Cursor position (${pos1}) is not valid in the document ${e.textEditor.document.fileName} that has ${lineCount} lines.`));
				return;
			}
		});

		// Open 10 line file, show it in slot 1, set cursor to line 10
		// Open 30 line file, show it in slot 1, set cursor to line 30
		// Open 10 line file, show it in slot 1
		// Open 30 line file, show it in slot 1
		workspace.openTextDocument(file10Path).then((doc) => {
			return window.showTextDocument(doc, ViewColumn.One);
		}).then((editor10line) => {
			editor10line.selection = new Selection(new Position(9, 0), new Position(9, 0));
		}).then(() => {
			return workspace.openTextDocument(file30Path);
		}).then((doc) => {
			return window.showTextDocument(doc, ViewColumn.One);
		}).then((editor30line) => {
			editor30line.selection = new Selection(new Position(29, 0), new Position(29, 0));
		}).then(() => {
			return workspace.openTextDocument(file10Path);
		}).then((doc) => {
			return window.showTextDocument(doc, ViewColumn.One);
		}).then(() => {
			return workspace.openTextDocument(file30Path);
		}).then((doc) => {
			return window.showTextDocument(doc, ViewColumn.One);
		}).then(() => {
			subscription.dispose();
		}).then(passOncePlease, failOncePlease);
	});

	test('#7013 - input without options', function () {
		const source = new CancellationTokenSource();
		let p = window.showInputBox(undefined, source.token);
		assert.ok(typeof p === 'object');
		source.dispose();
	});

	test('showInputBox - undefined on cancel', function () {
		const source = new CancellationTokenSource();
		const p = window.showInputBox(undefined, source.token);
		source.cancel();
		return p.then(value => {
			assert.equal(value, undefined);
		});
	});

	test('showInputBox - cancel early', function () {
		const source = new CancellationTokenSource();
		source.cancel();
		const p = window.showInputBox(undefined, source.token);
		return p.then(value => {
			assert.equal(value, undefined);
		});
	});

	test('showInputBox - \'\' on Enter', function () {
		const p = window.showInputBox();
		return Promise.all<any>([
			commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'),
			p.then(value => assert.equal(value, ''))
		]);
	});

	test('showInputBox - default value on Enter', function () {
		const p = window.showInputBox({ value: 'farboo' });
		return Promise.all<any>([
			p.then(value => assert.equal(value, 'farboo')),
			commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'),
		]);
	});

	test('showInputBox - `undefined` on Esc', function () {
		const p = window.showInputBox();
		return Promise.all<any>([
			commands.executeCommand('workbench.action.closeQuickOpen'),
			p.then(value => assert.equal(value, undefined))
		]);
	});

	test('showInputBox - `undefined` on Esc (despite default)', function () {
		const p = window.showInputBox({ value: 'farboo' });
		return Promise.all<any>([
			commands.executeCommand('workbench.action.closeQuickOpen'),
			p.then(value => assert.equal(value, undefined))
		]);
	});


	test('showQuickPick, accept first', async function () {
		const pick = window.showQuickPick(['eins', 'zwei', 'drei']);
		await commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		assert.equal(await pick, 'eins');
	});

	test('showQuickPick, accept second', async function () {
		const resolves: ((value: string) => void)[] = [];
		const first = new Promise(resolve => resolves.push(resolve));
		const pick = window.showQuickPick(['eins', 'zwei', 'drei'], {
			onDidSelectItem: item => resolves.shift()!(item as string)
		});
		assert.equal(await first, 'eins');
		const second = new Promise(resolve => resolves.push(resolve));
		await commands.executeCommand('workbench.action.quickOpenSelectNext');
		assert.equal(await second, 'zwei');
		await commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		assert.equal(await pick, 'zwei');
	});

	test('showQuickPick, select first two', async function () {
		const resolves: ((value: string) => void)[] = [];
		const picks = window.showQuickPick(['eins', 'zwei', 'drei'], {
			onDidSelectItem: item => resolves.shift()!(item as string),
			canPickMany: true
		});
		const first = new Promise(resolve => resolves.push(resolve));
		await commands.executeCommand('workbench.action.quickOpenSelectNext');
		assert.equal(await first, 'eins');
		await commands.executeCommand('workbench.action.quickPickManyToggle');
		const second = new Promise(resolve => resolves.push(resolve));
		await commands.executeCommand('workbench.action.quickOpenSelectNext');
		assert.equal(await second, 'zwei');
		await commands.executeCommand('workbench.action.quickPickManyToggle');
		await commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		assert.deepStrictEqual(await picks, ['eins', 'zwei']);
	});

	test('showQuickPick, undefined on cancel', function () {
		const source = new CancellationTokenSource();
		const p = window.showQuickPick(['eins', 'zwei', 'drei'], undefined, source.token);
		source.cancel();
		return p.then(value => {
			assert.equal(value, undefined);
		});
	});

	test('showQuickPick, cancel early', function () {
		const source = new CancellationTokenSource();
		source.cancel();
		const p = window.showQuickPick(['eins', 'zwei', 'drei'], undefined, source.token);
		return p.then(value => {
			assert.equal(value, undefined);
		});
	});

	test('showQuickPick, canceled by another picker', function () {

		const result = window.showQuickPick(['eins', 'zwei', 'drei'], { ignoreFocusOut: true }).then(result => {
			assert.equal(result, undefined);
		});

		const source = new CancellationTokenSource();
		source.cancel();
		window.showQuickPick(['eins', 'zwei', 'drei'], undefined, source.token);

		return result;
	});

	test('showQuickPick, canceled by input', function () {

		const result = window.showQuickPick(['eins', 'zwei', 'drei'], { ignoreFocusOut: true }).then(result => {
			assert.equal(result, undefined);
		});

		const source = new CancellationTokenSource();
		source.cancel();
		window.showInputBox(undefined, source.token);

		return result;
	});

	test('showQuickPick, native promise - #11754', function () {

		const data = new Promise<string[]>(resolve => {
			resolve(['a', 'b', 'c']);
		});

		const source = new CancellationTokenSource();
		const result = window.showQuickPick(data, undefined, source.token);
		source.cancel();
		return result.then(value => {
			assert.equal(value, undefined);
		});
	});

	test('showQuickPick, never resolve promise and cancel - #22453', function () {

		const result = window.showQuickPick(new Promise<string[]>(resolve => { }));

		const a = result.then(value => {
			assert.equal(value, undefined);
		});
		const b = commands.executeCommand('workbench.action.closeQuickOpen');
		return Promise.all([a, b]);
	});

	test('showWorkspaceFolderPick', function () {
		const p = window.showWorkspaceFolderPick(undefined);

		return commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem').then(() => {
			return p.then(workspace => {
				assert.ok(true);
			}, error => {
				assert.ok(false);
			});
		});
	});

	test('Default value for showInput Box accepted even if fails validateInput, #33691', function () {
		const result = window.showInputBox({
			validateInput: (value: string) => {
				if (!value || value.trim().length === 0) {
					return 'Cannot set empty description';
				}
				return null;
			}
		});

		const accept = commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return Promise.race([
			result.then(() => assert.ok(false)),
			accept.then(() => assert.ok(false), err => assert.ok(err))
				.then(() => new Promise(resolve => setTimeout(resolve, 10)))
		])
			.then(() => {
				const close = commands.executeCommand('workbench.action.closeQuickOpen');
				return Promise.all([result, close])
					.then(([value]) => {
						assert.equal(value, undefined);
					});
			});
	});


	test('editor, selection change kind', () => {
		return workspace.openTextDocument(join(workspace.rootPath || '', './far.js')).then(doc => window.showTextDocument(doc)).then(editor => {


			return new Promise((resolve, reject) => {

				let subscription = window.onDidChangeTextEditorSelection(e => {
					assert.ok(e.textEditor === editor);
					assert.equal(e.kind, TextEditorSelectionChangeKind.Command);

					subscription.dispose();
					resolve();
				});

				editor.selection = new Selection(editor.selection.anchor, editor.selection.active.translate(2));
			});

		});
	});

	test('createTerminal, Terminal.name', () => {
		const terminal = window.createTerminal('foo');
		assert.equal(terminal.name, 'foo');

		assert.throws(() => {
			(<any>terminal).name = 'bar';
		}, 'Terminal.name should be readonly');
	});

	test('terminal, sendText immediately after createTerminal should not throw', () => {
		const terminal = window.createTerminal();
		assert.doesNotThrow(terminal.sendText.bind(terminal, 'echo "foo"'));
	});

	test('terminal, onDidCloseTerminal event fires when terminal is disposed', (done) => {
		const terminal = window.createTerminal();
		window.onDidCloseTerminal((eventTerminal) => {
			assert.equal(terminal, eventTerminal);
			done();
		});
		terminal.dispose();
	});

	test('terminal, processId immediately after createTerminal should fetch the pid', (done) => {
		window.createTerminal().processId.then(id => {
			assert.ok(id > 0);
			done();
		});
	});

	test('terminal, name should set terminal.name', () => {
		assert.equal(window.createTerminal('foo').name, 'foo');
	});
});

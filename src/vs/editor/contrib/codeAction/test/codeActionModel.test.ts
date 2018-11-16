/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as assert from 'assert';
import URI from 'vs/base/common/uri';
import { TextModel } from 'vs/editor/common/model/textModel';
import { createTestCodeEditor } from 'vs/editor/test/browser/testCodeEditor';
import { MarkerService } from 'vs/platform/markers/common/markerService';
import { CodeActionOracle } from 'vs/editor/contrib/codeAction/codeActionModel';
import { CodeActionProviderRegistry, LanguageIdentifier } from 'vs/editor/common/modes';
import { IDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { Selection } from 'vs/editor/common/core/selection';

suite('CodeAction', () => {

	const languageIdentifier = new LanguageIdentifier('foo-lang', 3);
	let uri = URI.parse('untitled:path');
	let model: TextModel;
	let markerService: MarkerService;
	let editor: ICodeEditor;
	let reg: IDisposable;

	setup(() => {
		reg = CodeActionProviderRegistry.register(languageIdentifier.language, {
			provideCodeActions() {
				return [{ id: 'test-command', title: 'test', arguments: [] }];
			}
		});
		markerService = new MarkerService();
		model = TextModel.createFromString('foobar  foo bar\nfarboo far boo', undefined, languageIdentifier, uri);
		editor = createTestCodeEditor({ model: model });
		editor.setPosition({ lineNumber: 1, column: 1 });
	});

	teardown(() => {
		reg.dispose();
		editor.dispose();
		model.dispose();
		markerService.dispose();
	});

	test('Orcale -> marker added', done => {

		const oracle = new CodeActionOracle(editor, markerService, e => {
			assert.equal(e.trigger.type, 'auto');
			assert.ok(e.actions);

			e.actions.then(fixes => {
				oracle.dispose();
				assert.equal(fixes.length, 1);
				done();
			}, done);
		});

		// start here
		markerService.changeOne('fake', uri, [{
			startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6,
			message: 'error',
			severity: 1,
			code: '',
			source: ''
		}]);

	});

	test('Orcale -> position changed', () => {

		markerService.changeOne('fake', uri, [{
			startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6,
			message: 'error',
			severity: 1,
			code: '',
			source: ''
		}]);

		editor.setPosition({ lineNumber: 2, column: 1 });

		return new Promise((resolve, reject) => {

			const oracle = new CodeActionOracle(editor, markerService, e => {
				assert.equal(e.trigger.type, 'auto');
				assert.ok(e.actions);
				e.actions.then(fixes => {
					oracle.dispose();
					assert.equal(fixes.length, 1);
					resolve(undefined);
				}, reject);
			});
			// start here
			editor.setPosition({ lineNumber: 1, column: 1 });
		});
	});

	test('Lightbulb is in the wrong place, #29933', async function () {
		let reg = CodeActionProviderRegistry.register(languageIdentifier.language, {
			provideCodeActions(doc, _range) {
				return [];
			}
		});

		editor.getModel().setValue('// @ts-check\n2\ncon\n');

		markerService.changeOne('fake', uri, [{
			startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 4,
			message: 'error',
			severity: 1,
			code: '',
			source: ''
		}]);

		// case 1 - drag selection over multiple lines -> range of enclosed marker, position or marker
		await new Promise(resolve => {

			let oracle = new CodeActionOracle(editor, markerService, e => {
				assert.equal(e.trigger.type, 'auto');
				const selection = <Selection>e.rangeOrSelection;
				assert.deepEqual(selection.selectionStartLineNumber, 1);
				assert.deepEqual(selection.selectionStartColumn, 1);
				assert.deepEqual(selection.endLineNumber, 4);
				assert.deepEqual(selection.endColumn, 1);
				assert.deepEqual(e.position, { lineNumber: 3, column: 1 });

				oracle.dispose();
				resolve(null);
			}, 5);

			editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 1 });
		});

		// // case 2 - selection over multiple lines & manual trigger -> lightbulb
		// await new TPromise(resolve => {

		// 	editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 1 });

		// 	let oracle = new QuickFixOracle(editor, markerService, e => {
		// 		assert.equal(e.type, 'manual');
		// 		assert.ok(e.range.equalsRange({ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 1 }));

		// 		oracle.dispose();
		// 		resolve(null);
		// 	}, 5);

		// 	oracle.trigger('manual');
		// });


		reg.dispose();
	});

});

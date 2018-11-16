/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import { FileDecorationsService } from 'vs/workbench/services/decorations/browser/decorationsService';
import { IDecorationsProvider, IDecorationData } from 'vs/workbench/services/decorations/browser/decorations';
import URI from 'vs/base/common/uri';
import { Event, toPromise, Emitter } from 'vs/base/common/event';
import { TestThemeService } from 'vs/platform/theme/test/common/testThemeService';
import { TPromise } from 'vs/base/common/winjs.base';

suite('DecorationsService', function () {

	let service: FileDecorationsService;

	setup(function () {
		if (service) {
			service.dispose();
		}
		service = new FileDecorationsService(new TestThemeService());
	});

	test('Async provider, async/evented result', function () {

		let uri = URI.parse('foo:bar');
		let callCounter = 0;

		service.registerDecorationsProvider(new class implements IDecorationsProvider {
			readonly label: string = 'Test';
			readonly onDidChange: Event<URI[]> = Event.None;
			provideDecorations(uri: URI) {
				callCounter += 1;
				return new TPromise<IDecorationData>(resolve => {
					setTimeout(() => resolve({
						color: 'someBlue',
						tooltip: 'T'
					}));
				});
			}
		});

		// trigger -> async
		assert.equal(service.getDecoration(uri, false), undefined);
		assert.equal(callCounter, 1);

		// event when result is computed
		return toPromise(service.onDidChangeDecorations).then(e => {
			assert.equal(e.affectsResource(uri), true);

			// sync result
			assert.deepEqual(service.getDecoration(uri, false).tooltip, 'T');
			assert.equal(callCounter, 1);
		});
	});

	test('Sync provider, sync result', function () {

		let uri = URI.parse('foo:bar');
		let callCounter = 0;

		service.registerDecorationsProvider(new class implements IDecorationsProvider {
			readonly label: string = 'Test';
			readonly onDidChange: Event<URI[]> = Event.None;
			provideDecorations(uri: URI) {
				callCounter += 1;
				return { color: 'someBlue', tooltip: 'Z' };
			}
		});

		// trigger -> sync
		assert.deepEqual(service.getDecoration(uri, false).tooltip, 'Z');
		assert.equal(callCounter, 1);
	});

	test('Clear decorations on provider dispose', async function () {
		let uri = URI.parse('foo:bar');
		let callCounter = 0;

		let reg = service.registerDecorationsProvider(new class implements IDecorationsProvider {
			readonly label: string = 'Test';
			readonly onDidChange: Event<URI[]> = Event.None;
			provideDecorations(uri: URI) {
				callCounter += 1;
				return { color: 'someBlue', tooltip: 'J' };
			}
		});

		// trigger -> sync
		assert.deepEqual(service.getDecoration(uri, false).tooltip, 'J');
		assert.equal(callCounter, 1);

		// un-register -> ensure good event
		let didSeeEvent = false;
		let p = toPromise(service.onDidChangeDecorations).then(e => {
			assert.equal(e.affectsResource(uri), true);
			assert.deepEqual(service.getDecoration(uri, false), undefined);
			assert.equal(callCounter, 1);
			didSeeEvent = true;
		});
		reg.dispose();
		await p;
		assert.equal(didSeeEvent, true);
	});

	test('No default bubbling', function () {

		let reg = service.registerDecorationsProvider({
			label: 'Test',
			onDidChange: Event.None,
			provideDecorations(uri: URI) {
				return uri.path.match(/\.txt/)
					? { tooltip: '.txt', weight: 17 }
					: undefined;
			}
		});

		let childUri = URI.parse('file:///some/path/some/file.txt');

		let deco = service.getDecoration(childUri, false);
		assert.equal(deco.tooltip, '.txt');

		deco = service.getDecoration(childUri.with({ path: 'some/path/' }), true);
		assert.equal(deco, undefined);
		reg.dispose();

		// bubble
		reg = service.registerDecorationsProvider({
			label: 'Test',
			onDidChange: Event.None,
			provideDecorations(uri: URI) {
				return uri.path.match(/\.txt/)
					? { tooltip: '.txt.bubble', weight: 71, bubble: true }
					: undefined;
			}
		});

		deco = service.getDecoration(childUri, false);
		assert.equal(deco.tooltip, '.txt.bubble');

		deco = service.getDecoration(childUri.with({ path: 'some/path/' }), true);
		assert.equal(typeof deco.tooltip, 'string');
	});

	test('Overwrite data', function () {

		let someUri = URI.parse('file:///some/path/some/file.txt');
		let deco = service.getDecoration(someUri, false);
		assert.equal(deco, undefined);

		deco = service.getDecoration(someUri, false, { tooltip: 'Overwrite' });
		assert.equal(deco.tooltip, 'Overwrite');

		let reg = service.registerDecorationsProvider({
			label: 'Test',
			onDidChange: Event.None,
			provideDecorations(uri: URI) {
				return { tooltip: 'FromMe', source: 'foo' };
			}
		});

		deco = service.getDecoration(someUri, false);
		assert.equal(deco.tooltip, 'FromMe');

		deco = service.getDecoration(someUri, false, { source: 'foo', tooltip: 'O' });
		assert.equal(deco.tooltip, 'O');

		reg.dispose();
	});

	test('Decorations not showing up for second root folder #48502', async function () {

		let cancelCount = 0;
		let callCount = 0;

		let provider = new class implements IDecorationsProvider {

			_onDidChange = new Emitter<URI[]>();
			onDidChange: Event<URI[]> = this._onDidChange.event;

			label: string = 'foo';

			provideDecorations(uri: URI): TPromise<IDecorationData> {
				return new TPromise(resolve => {
					callCount += 1;
					setTimeout(() => {
						resolve({ letter: 'foo' });
					}, 10);
				}, () => {
					cancelCount += 1;
				});
			}
		};

		let reg = service.registerDecorationsProvider(provider);

		const uri = URI.parse('foo://bar');
		service.getDecoration(uri, false);

		provider._onDidChange.fire([uri]);
		service.getDecoration(uri, false);

		assert.equal(cancelCount, 1);
		assert.equal(callCount, 2);

		reg.dispose();
	});
});

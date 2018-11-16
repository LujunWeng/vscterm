/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import { Builder, $ } from 'vs/base/browser/builder';
import { Part } from 'vs/workbench/browser/part';
import * as Types from 'vs/base/common/types';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { StorageService, InMemoryLocalStorage } from 'vs/platform/storage/common/storageService';
import { TestThemeService } from 'vs/platform/theme/test/common/testThemeService';
import { TestWorkspace } from 'vs/platform/workspace/test/common/testWorkspace';

class MyPart extends Part {

	constructor(private expectedParent: HTMLElement) {
		super('myPart', { hasTitle: true }, new TestThemeService());
	}

	public createTitleArea(parent: HTMLElement): HTMLElement {
		assert.strictEqual(parent, this.expectedParent);
		return super.createTitleArea(parent);
	}

	public createContentArea(parent: HTMLElement): HTMLElement {
		assert.strictEqual(parent, this.expectedParent);
		return super.createContentArea(parent);
	}

	public getMemento(storageService: IStorageService): any {
		return super.getMemento(storageService);
	}
}

class MyPart2 extends Part {

	constructor() {
		super('myPart2', { hasTitle: true }, new TestThemeService());
	}

	public createTitleArea(parent: HTMLElement): HTMLElement {
		return $(parent).div(function (div) {
			div.span({
				id: 'myPart.title',
				innerHtml: 'Title'
			});
		}).getHTMLElement();
	}

	public createContentArea(parent: HTMLElement): HTMLElement {
		return $(parent).div(function (div) {
			div.span({
				id: 'myPart.content',
				innerHtml: 'Content'
			});
		}).getHTMLElement();
	}
}

class MyPart3 extends Part {

	constructor() {
		super('myPart2', { hasTitle: false }, new TestThemeService());
	}

	public createTitleArea(parent: HTMLElement): HTMLElement {
		return null;
	}

	public createContentArea(parent: HTMLElement): HTMLElement {
		return $(parent).div(function (div) {
			div.span({
				id: 'myPart.content',
				innerHtml: 'Content'
			});
		}).getHTMLElement();
	}
}

suite('Workbench parts', () => {
	let fixture: HTMLElement;
	let fixtureId = 'workbench-part-fixture';
	let storage: IStorageService;

	setup(() => {
		fixture = document.createElement('div');
		fixture.id = fixtureId;
		document.body.appendChild(fixture);
		storage = new StorageService(new InMemoryLocalStorage(), null, TestWorkspace.id);
	});

	teardown(() => {
		document.body.removeChild(fixture);
	});

	test('Creation', function () {
		let b = new Builder(document.getElementById(fixtureId));
		b.div().hide();

		let part = new MyPart(b.getHTMLElement());
		part.create(b.getHTMLElement());

		assert.strictEqual(part.getId(), 'myPart');

		// Memento
		let memento = part.getMemento(storage);
		assert(memento);
		memento.foo = 'bar';
		memento.bar = [1, 2, 3];

		part.shutdown();

		// Re-Create to assert memento contents
		part = new MyPart(b.getHTMLElement());

		memento = part.getMemento(storage);
		assert(memento);
		assert.strictEqual(memento.foo, 'bar');
		assert.strictEqual(memento.bar.length, 3);

		// Empty Memento stores empty object
		delete memento.foo;
		delete memento.bar;

		part.shutdown();
		part = new MyPart(b.getHTMLElement());
		memento = part.getMemento(storage);
		assert(memento);
		assert.strictEqual(Types.isEmptyObject(memento), true);
	});

	test('Part Layout with Title and Content', function () {
		let b = new Builder(document.getElementById(fixtureId));
		b.div().hide();

		let part = new MyPart2();
		part.create(b.getHTMLElement());

		assert(document.getElementById('myPart.title'));
		assert(document.getElementById('myPart.content'));
	});

	test('Part Layout with Content only', function () {
		let b = new Builder(document.getElementById(fixtureId));
		b.div().hide();

		let part = new MyPart3();
		part.create(b.getHTMLElement());

		assert(!document.getElementById('myPart.title'));
		assert(document.getElementById('myPart.content'));
	});
});
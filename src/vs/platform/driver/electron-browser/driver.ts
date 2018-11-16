/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, toDisposable, combinedDisposable } from 'vs/base/common/lifecycle';
import { IWindowDriver, IElement, WindowDriverChannel, WindowDriverRegistryChannelClient } from 'vs/platform/driver/common/driver';
import { IPCClient } from 'vs/base/parts/ipc/common/ipc';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { getTopLeftOffset, getClientArea } from 'vs/base/browser/dom';
import * as electron from 'electron';
import { IWindowService } from 'vs/platform/windows/common/windows';

function serializeElement(element: Element, recursive: boolean): IElement {
	const attributes = Object.create(null);

	for (let j = 0; j < element.attributes.length; j++) {
		const attr = element.attributes.item(j);
		attributes[attr.name] = attr.value;
	}

	const children = [];

	if (recursive) {
		for (let i = 0; i < element.children.length; i++) {
			children.push(serializeElement(element.children.item(i), true));
		}
	}

	return {
		tagName: element.tagName,
		className: element.className,
		textContent: element.textContent || '',
		attributes,
		children
	};
}

class WindowDriver implements IWindowDriver {

	constructor(
		@IWindowService private windowService: IWindowService
	) { }

	async click(selector: string, xoffset?: number, yoffset?: number): TPromise<void> {
		return this._click(selector, 1, xoffset, yoffset);
	}

	doubleClick(selector: string): TPromise<void> {
		return this._click(selector, 2);
	}

	private async _getElementXY(selector: string, xoffset?: number, yoffset?: number): TPromise<{ x: number; y: number; }> {
		const element = document.querySelector(selector);

		if (!element) {
			throw new Error('Element not found');
		}

		const { left, top } = getTopLeftOffset(element as HTMLElement);
		const { width, height } = getClientArea(element as HTMLElement);
		let x: number, y: number;

		if ((typeof xoffset === 'number') || (typeof yoffset === 'number')) {
			x = left + xoffset;
			y = top + yoffset;
		} else {
			x = left + (width / 2);
			y = top + (height / 2);
		}

		x = Math.round(x);
		y = Math.round(y);

		return { x, y };
	}

	private async _click(selector: string, clickCount: number, xoffset?: number, yoffset?: number): TPromise<void> {
		const { x, y } = await this._getElementXY(selector, xoffset, yoffset);
		const webContents = electron.remote.getCurrentWebContents();
		webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount } as any);
		webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount } as any);

		await TPromise.timeout(100);
	}

	async move(selector: string): TPromise<void> {
		const { x, y } = await this._getElementXY(selector);
		const webContents = electron.remote.getCurrentWebContents();
		webContents.sendInputEvent({ type: 'mouseMove', x, y } as any);

		await TPromise.timeout(100);
	}

	async setValue(selector: string, text: string): TPromise<void> {
		const element = document.querySelector(selector);

		if (!element) {
			throw new Error('Element not found');
		}

		const inputElement = element as HTMLInputElement;
		inputElement.value = text;

		const event = new Event('input', { bubbles: true, cancelable: true });
		inputElement.dispatchEvent(event);
	}

	async getTitle(): TPromise<string> {
		return document.title;
	}

	async isActiveElement(selector: string): TPromise<boolean> {
		const element = document.querySelector(selector);

		if (element !== document.activeElement) {
			const el = document.activeElement;
			const tagName = el.tagName;
			const id = el.id ? `#${el.id}` : '';
			const classes = el.className.split(/\W+/g).map(c => c.trim()).filter(c => !!c).map(c => `.${c}`).join('');
			const current = `${tagName}${id}${classes}`;

			throw new Error(`Active element not found. Current active element is '${current}'`);
		}

		return true;
	}

	async getElements(selector: string, recursive: boolean): TPromise<IElement[]> {
		const query = document.querySelectorAll(selector);
		const result: IElement[] = [];

		for (let i = 0; i < query.length; i++) {
			const element = query.item(i);
			result.push(serializeElement(element, recursive));
		}

		return result;
	}

	async typeInEditor(selector: string, text: string): TPromise<void> {
		const element = document.querySelector(selector);

		if (!element) {
			throw new Error('Editor not found: ' + selector);
		}

		const textarea = element as HTMLTextAreaElement;
		const start = textarea.selectionStart;
		const newStart = start + text.length;
		const value = textarea.value;
		const newValue = value.substr(0, start) + text + value.substr(start);

		textarea.value = newValue;
		textarea.setSelectionRange(newStart, newStart);

		const event = new Event('input', { 'bubbles': true, 'cancelable': true });
		textarea.dispatchEvent(event);
	}

	async getTerminalBuffer(selector: string): TPromise<string[]> {
		const element = document.querySelector(selector);

		if (!element) {
			throw new Error('Terminal not found: ' + selector);
		}

		const xterm = (element as any).xterm;

		if (!xterm) {
			throw new Error('Xterm not found: ' + selector);
		}

		const lines: string[] = [];

		for (let i = 0; i < xterm.buffer.lines.length; i++) {
			lines.push(xterm.buffer.translateBufferLineToString(i, true));
		}

		return lines;
	}

	async writeInTerminal(selector: string, text: string): TPromise<void> {
		const element = document.querySelector(selector);

		if (!element) {
			throw new Error('Element not found');
		}

		const xterm = (element as any).xterm;

		if (!xterm) {
			throw new Error('Xterm not found');
		}

		xterm.send(text);
	}

	async openDevTools(): TPromise<void> {
		await this.windowService.openDevTools({ mode: 'detach' });
	}
}

export async function registerWindowDriver(
	client: IPCClient,
	windowId: number,
	instantiationService: IInstantiationService
): TPromise<IDisposable> {
	const windowDriver = instantiationService.createInstance(WindowDriver);
	const windowDriverChannel = new WindowDriverChannel(windowDriver);
	client.registerChannel('windowDriver', windowDriverChannel);

	const windowDriverRegistryChannel = client.getChannel('windowDriverRegistry');
	const windowDriverRegistry = new WindowDriverRegistryChannelClient(windowDriverRegistryChannel);

	const options = await windowDriverRegistry.registerWindowDriver(windowId);

	if (options.verbose) {
		// windowDriver.openDevTools();
	}

	const disposable = toDisposable(() => windowDriverRegistry.reloadWindowDriver(windowId));
	return combinedDisposable([disposable, client]);
}
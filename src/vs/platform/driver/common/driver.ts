/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IChannel } from 'vs/base/parts/ipc/common/ipc';

export const ID = 'driverService';
export const IDriver = createDecorator<IDriver>(ID);

// !! Do not remove the following START and END markers, they are parsed by the smoketest build

//*START
export interface IElement {
	tagName: string;
	className: string;
	textContent: string;
	attributes: { [name: string]: string; };
	children: IElement[];
}

export interface IDriver {
	_serviceBrand: any;

	getWindowIds(): TPromise<number[]>;
	capturePage(windowId: number): TPromise<string>;
	reloadWindow(windowId: number): TPromise<void>;
	dispatchKeybinding(windowId: number, keybinding: string): TPromise<void>;
	click(windowId: number, selector: string, xoffset?: number | undefined, yoffset?: number | undefined): TPromise<void>;
	doubleClick(windowId: number, selector: string): TPromise<void>;
	move(windowId: number, selector: string): TPromise<void>;
	setValue(windowId: number, selector: string, text: string): TPromise<void>;
	getTitle(windowId: number): TPromise<string>;
	isActiveElement(windowId: number, selector: string): TPromise<boolean>;
	getElements(windowId: number, selector: string, recursive?: boolean): TPromise<IElement[]>;
	typeInEditor(windowId: number, selector: string, text: string): TPromise<void>;
	getTerminalBuffer(windowId: number, selector: string): TPromise<string[]>;
	writeInTerminal(windowId: number, selector: string, text: string): TPromise<void>;
}
//*END

export interface IDriverChannel extends IChannel {
	call(command: 'getWindowIds'): TPromise<number[]>;
	call(command: 'capturePage'): TPromise<string>;
	call(command: 'reloadWindow', arg: number): TPromise<void>;
	call(command: 'dispatchKeybinding', arg: [number, string]): TPromise<void>;
	call(command: 'click', arg: [number, string, number | undefined, number | undefined]): TPromise<void>;
	call(command: 'doubleClick', arg: [number, string]): TPromise<void>;
	call(command: 'move', arg: [number, string]): TPromise<void>;
	call(command: 'setValue', arg: [number, string, string]): TPromise<void>;
	call(command: 'getTitle', arg: [number]): TPromise<string>;
	call(command: 'isActiveElement', arg: [number, string]): TPromise<boolean>;
	call(command: 'getElements', arg: [number, string, boolean]): TPromise<IElement[]>;
	call(command: 'typeInEditor', arg: [number, string, string]): TPromise<void>;
	call(command: 'getTerminalBuffer', arg: [number, string]): TPromise<string[]>;
	call(command: 'writeInTerminal', arg: [number, string, string]): TPromise<void>;
	call(command: string, arg: any): TPromise<any>;
}

export class DriverChannel implements IDriverChannel {

	constructor(private driver: IDriver) { }

	call(command: string, arg?: any): TPromise<any> {
		switch (command) {
			case 'getWindowIds': return this.driver.getWindowIds();
			case 'capturePage': return this.driver.capturePage(arg);
			case 'reloadWindow': return this.driver.reloadWindow(arg);
			case 'dispatchKeybinding': return this.driver.dispatchKeybinding(arg[0], arg[1]);
			case 'click': return this.driver.click(arg[0], arg[1], arg[2], arg[3]);
			case 'doubleClick': return this.driver.doubleClick(arg[0], arg[1]);
			case 'move': return this.driver.move(arg[0], arg[1]);
			case 'setValue': return this.driver.setValue(arg[0], arg[1], arg[2]);
			case 'getTitle': return this.driver.getTitle(arg[0]);
			case 'isActiveElement': return this.driver.isActiveElement(arg[0], arg[1]);
			case 'getElements': return this.driver.getElements(arg[0], arg[1], arg[2]);
			case 'typeInEditor': return this.driver.typeInEditor(arg[0], arg[1], arg[2]);
			case 'getTerminalBuffer': return this.driver.getTerminalBuffer(arg[0], arg[1]);
			case 'writeInTerminal': return this.driver.writeInTerminal(arg[0], arg[1], arg[2]);
		}

		return undefined;
	}
}

export class DriverChannelClient implements IDriver {

	_serviceBrand: any;

	constructor(private channel: IDriverChannel) { }

	getWindowIds(): TPromise<number[]> {
		return this.channel.call('getWindowIds');
	}

	capturePage(windowId: number): TPromise<string> {
		return this.channel.call('capturePage', windowId);
	}

	reloadWindow(windowId: number): TPromise<void> {
		return this.channel.call('reloadWindow', windowId);
	}

	dispatchKeybinding(windowId: number, keybinding: string): TPromise<void> {
		return this.channel.call('dispatchKeybinding', [windowId, keybinding]);
	}

	click(windowId: number, selector: string, xoffset: number | undefined, yoffset: number | undefined): TPromise<void> {
		return this.channel.call('click', [windowId, selector, xoffset, yoffset]);
	}

	doubleClick(windowId: number, selector: string): TPromise<void> {
		return this.channel.call('doubleClick', [windowId, selector]);
	}

	move(windowId: number, selector: string): TPromise<void> {
		return this.channel.call('move', [windowId, selector]);
	}

	setValue(windowId: number, selector: string, text: string): TPromise<void> {
		return this.channel.call('setValue', [windowId, selector, text]);
	}

	getTitle(windowId: number): TPromise<string> {
		return this.channel.call('getTitle', [windowId]);
	}

	isActiveElement(windowId: number, selector: string): TPromise<boolean> {
		return this.channel.call('isActiveElement', [windowId, selector]);
	}

	getElements(windowId: number, selector: string, recursive: boolean): TPromise<IElement[]> {
		return this.channel.call('getElements', [windowId, selector, recursive]);
	}

	typeInEditor(windowId: number, selector: string, text: string): TPromise<void> {
		return this.channel.call('typeInEditor', [windowId, selector, text]);
	}

	getTerminalBuffer(windowId: number, selector: string): TPromise<string[]> {
		return this.channel.call('getTerminalBuffer', [windowId, selector]);
	}

	writeInTerminal(windowId: number, selector: string, text: string): TPromise<void> {
		return this.channel.call('writeInTerminal', [windowId, selector, text]);
	}
}

export interface IDriverOptions {
	verbose: boolean;
}

export interface IWindowDriverRegistry {
	registerWindowDriver(windowId: number): TPromise<IDriverOptions>;
	reloadWindowDriver(windowId: number): TPromise<void>;
}

export interface IWindowDriverRegistryChannel extends IChannel {
	call(command: 'registerWindowDriver', arg: number): TPromise<IDriverOptions>;
	call(command: 'reloadWindowDriver', arg: number): TPromise<void>;
	call(command: string, arg: any): TPromise<any>;
}

export class WindowDriverRegistryChannel implements IWindowDriverRegistryChannel {

	constructor(private registry: IWindowDriverRegistry) { }

	call(command: string, arg?: any): TPromise<any> {
		switch (command) {
			case 'registerWindowDriver': return this.registry.registerWindowDriver(arg);
			case 'reloadWindowDriver': return this.registry.reloadWindowDriver(arg);
		}

		return undefined;
	}
}

export class WindowDriverRegistryChannelClient implements IWindowDriverRegistry {

	_serviceBrand: any;

	constructor(private channel: IWindowDriverRegistryChannel) { }

	registerWindowDriver(windowId: number): TPromise<IDriverOptions> {
		return this.channel.call('registerWindowDriver', windowId);
	}

	reloadWindowDriver(windowId: number): TPromise<void> {
		return this.channel.call('reloadWindowDriver', windowId);
	}
}

export interface IWindowDriver {
	click(selector: string, xoffset?: number | undefined, yoffset?: number | undefined): TPromise<void>;
	doubleClick(selector: string): TPromise<void>;
	move(selector: string): TPromise<void>;
	setValue(selector: string, text: string): TPromise<void>;
	getTitle(): TPromise<string>;
	isActiveElement(selector: string): TPromise<boolean>;
	getElements(selector: string, recursive: boolean): TPromise<IElement[]>;
	typeInEditor(selector: string, text: string): TPromise<void>;
	getTerminalBuffer(selector: string): TPromise<string[]>;
	writeInTerminal(selector: string, text: string): TPromise<void>;
}

export interface IWindowDriverChannel extends IChannel {
	call(command: 'click', arg: [string, number | undefined, number | undefined]): TPromise<void>;
	call(command: 'doubleClick', arg: string): TPromise<void>;
	call(command: 'move', arg: string): TPromise<void>;
	call(command: 'setValue', arg: [string, string]): TPromise<void>;
	call(command: 'getTitle'): TPromise<string>;
	call(command: 'isActiveElement', arg: string): TPromise<boolean>;
	call(command: 'getElements', arg: [string, boolean]): TPromise<IElement[]>;
	call(command: 'typeInEditor', arg: [string, string]): TPromise<void>;
	call(command: 'getTerminalBuffer', arg: string): TPromise<string[]>;
	call(command: 'writeInTerminal', arg: [string, string]): TPromise<void>;
	call(command: string, arg: any): TPromise<any>;
}

export class WindowDriverChannel implements IWindowDriverChannel {

	constructor(private driver: IWindowDriver) { }

	call(command: string, arg?: any): TPromise<any> {
		switch (command) {
			case 'click': return this.driver.click(arg[0], arg[1], arg[2]);
			case 'doubleClick': return this.driver.doubleClick(arg);
			case 'move': return this.driver.move(arg);
			case 'setValue': return this.driver.setValue(arg[0], arg[1]);
			case 'getTitle': return this.driver.getTitle();
			case 'isActiveElement': return this.driver.isActiveElement(arg);
			case 'getElements': return this.driver.getElements(arg[0], arg[1]);
			case 'typeInEditor': return this.driver.typeInEditor(arg[0], arg[1]);
			case 'getTerminalBuffer': return this.driver.getTerminalBuffer(arg);
			case 'writeInTerminal': return this.driver.writeInTerminal(arg[0], arg[1]);
		}

		return undefined;
	}
}

export class WindowDriverChannelClient implements IWindowDriver {

	_serviceBrand: any;

	constructor(private channel: IWindowDriverChannel) { }

	click(selector: string, xoffset?: number, yoffset?: number): TPromise<void> {
		return this.channel.call('click', [selector, xoffset, yoffset]);
	}

	doubleClick(selector: string): TPromise<void> {
		return this.channel.call('doubleClick', selector);
	}

	move(selector: string): TPromise<void> {
		return this.channel.call('move', selector);
	}

	setValue(selector: string, text: string): TPromise<void> {
		return this.channel.call('setValue', [selector, text]);
	}

	getTitle(): TPromise<string> {
		return this.channel.call('getTitle');
	}

	isActiveElement(selector: string): TPromise<boolean> {
		return this.channel.call('isActiveElement', selector);
	}

	getElements(selector: string, recursive: boolean): TPromise<IElement[]> {
		return this.channel.call('getElements', [selector, recursive]);
	}

	typeInEditor(selector: string, text: string): TPromise<void> {
		return this.channel.call('typeInEditor', [selector, text]);
	}

	getTerminalBuffer(selector: string): TPromise<string[]> {
		return this.channel.call('getTerminalBuffer', selector);
	}

	writeInTerminal(selector: string, text: string): TPromise<void> {
		return this.channel.call('writeInTerminal', [selector, text]);
	}
}
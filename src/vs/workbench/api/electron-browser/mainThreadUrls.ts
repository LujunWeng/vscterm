/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtHostContext, IExtHostContext, MainContext, MainThreadUrlsShape, ExtHostUrlsShape } from 'vs/workbench/api/node/extHost.protocol';
import { extHostNamedCustomer } from './extHostCustomers';
import { TPromise } from 'vs/base/common/winjs.base';
import { IURLService, IURLHandler } from 'vs/platform/url/common/url';
import URI from 'vs/base/common/uri';
import { IDisposable } from 'vs/base/common/lifecycle';
import { IExtensionUrlHandler } from 'vs/platform/url/electron-browser/inactiveExtensionUrlHandler';

class ExtensionUrlHandler implements IURLHandler {

	constructor(
		private readonly proxy: ExtHostUrlsShape,
		private readonly handle: number,
		readonly extensionId: string
	) { }

	handleURL(uri: URI): TPromise<boolean> {
		if (uri.authority !== this.extensionId) {
			return TPromise.as(false);
		}

		return this.proxy.$handleExternalUri(this.handle, uri).then(() => true);
	}
}

@extHostNamedCustomer(MainContext.MainThreadUrls)
export class MainThreadUrls implements MainThreadUrlsShape {

	private readonly proxy: ExtHostUrlsShape;
	private handlers = new Map<number, { extensionId: string, disposable: IDisposable }>();

	constructor(
		context: IExtHostContext,
		@IURLService private urlService: IURLService,
		@IExtensionUrlHandler private inactiveExtensionUrlHandler: IExtensionUrlHandler
	) {
		this.proxy = context.getProxy(ExtHostContext.ExtHostUrls);
	}

	$registerProtocolHandler(handle: number, extensionId: string): TPromise<void> {
		const handler = new ExtensionUrlHandler(this.proxy, handle, extensionId);
		const disposable = this.urlService.registerHandler(handler);

		this.handlers.set(handle, { extensionId, disposable });
		this.inactiveExtensionUrlHandler.registerExtensionHandler(extensionId, handler);

		return TPromise.as(null);
	}

	$unregisterProtocolHandler(handle: number): TPromise<void> {
		const tuple = this.handlers.get(handle);

		if (!tuple) {
			return TPromise.as(null);
		}

		const { extensionId, disposable } = tuple;

		this.inactiveExtensionUrlHandler.unregisterExtensionHandler(extensionId);
		this.handlers.delete(handle);
		disposable.dispose();

		return TPromise.as(null);
	}

	dispose(): void {
		this.handlers.forEach(({ disposable }) => disposable.dispose());
		this.handlers.clear();
	}
}

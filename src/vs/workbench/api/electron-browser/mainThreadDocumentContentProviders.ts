/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI, { UriComponents } from 'vs/base/common/uri';
import { IDisposable } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { ITextModel, DefaultEndOfLine } from 'vs/editor/common/model';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { MainThreadDocumentContentProvidersShape, ExtHostContext, ExtHostDocumentContentProvidersShape, MainContext, IExtHostContext } from '../node/extHost.protocol';
import { createTextBuffer } from 'vs/editor/common/model/textModel';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { extHostNamedCustomer } from 'vs/workbench/api/electron-browser/extHostCustomers';

@extHostNamedCustomer(MainContext.MainThreadDocumentContentProviders)
export class MainThreadDocumentContentProviders implements MainThreadDocumentContentProvidersShape {

	private _resourceContentProvider: { [handle: number]: IDisposable } = Object.create(null);
	private readonly _proxy: ExtHostDocumentContentProvidersShape;

	constructor(
		extHostContext: IExtHostContext,
		@ITextModelService private readonly _textModelResolverService: ITextModelService,
		@IModeService private readonly _modeService: IModeService,
		@IModelService private readonly _modelService: IModelService,
		@ICodeEditorService codeEditorService: ICodeEditorService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostDocumentContentProviders);
	}

	public dispose(): void {
		for (let handle in this._resourceContentProvider) {
			this._resourceContentProvider[handle].dispose();
		}
	}

	$registerTextContentProvider(handle: number, scheme: string): void {
		this._resourceContentProvider[handle] = this._textModelResolverService.registerTextModelContentProvider(scheme, {
			provideTextContent: (uri: URI): TPromise<ITextModel> => {
				return this._proxy.$provideTextDocumentContent(handle, uri).then(value => {
					if (typeof value === 'string') {
						const firstLineText = value.substr(0, 1 + value.search(/\r?\n/));
						const mode = this._modeService.getOrCreateModeByFilenameOrFirstLine(uri.fsPath, firstLineText);
						return this._modelService.createModel(value, mode, uri);
					}
					return undefined;
				});
			}
		});
	}

	$unregisterTextContentProvider(handle: number): void {
		const registration = this._resourceContentProvider[handle];
		if (registration) {
			registration.dispose();
			delete this._resourceContentProvider[handle];
		}
	}

	$onVirtualDocumentChange(uri: UriComponents, value: string): void {
		const model = this._modelService.getModel(URI.revive(uri));
		if (!model) {
			return;
		}

		const textBuffer = createTextBuffer(value, DefaultEndOfLine.CRLF);

		if (!model.equalsTextBuffer(textBuffer)) {
			model.setValueFromTextBuffer(textBuffer);
		}
	}
}

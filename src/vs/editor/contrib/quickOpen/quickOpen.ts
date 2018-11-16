/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { illegalArgument, onUnexpectedExternalError } from 'vs/base/common/errors';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { Range } from 'vs/editor/common/core/range';
import { ITextModel } from 'vs/editor/common/model';
import { registerLanguageCommand } from 'vs/editor/browser/editorExtensions';
import { SymbolInformation, DocumentSymbolProviderRegistry, IOutline } from 'vs/editor/common/modes';
import { IModelService } from 'vs/editor/common/services/modelService';
import { asWinJsPromise } from 'vs/base/common/async';

export function getDocumentSymbols(model: ITextModel): TPromise<IOutline> {

	let roots: SymbolInformation[] = [];

	let promises = DocumentSymbolProviderRegistry.all(model).map(support => {

		return asWinJsPromise(token => support.provideDocumentSymbols(model, token)).then(result => {
			if (Array.isArray(result)) {
				roots.push(...result);
			}
		}, err => {
			onUnexpectedExternalError(err);
		});
	});

	return TPromise.join(promises).then(() => {
		let flatEntries: SymbolInformation[] = [];
		flatten(flatEntries, roots, '');
		flatEntries.sort(compareEntriesUsingStart);

		return {
			entries: flatEntries,
		};
	});
}

function compareEntriesUsingStart(a: SymbolInformation, b: SymbolInformation): number {
	return Range.compareRangesUsingStarts(a.location.range, b.location.range);
}

function flatten(bucket: SymbolInformation[], entries: SymbolInformation[], overrideContainerLabel: string): void {
	for (let entry of entries) {
		bucket.push({
			kind: entry.kind,
			name: entry.name,
			detail: entry.detail,
			containerName: entry.containerName || overrideContainerLabel,
			location: entry.location,
			definingRange: entry.definingRange,
			children: undefined, // we flatten it...
		});
		if (entry.children) {
			flatten(bucket, entry.children, entry.name);
		}
	}
}


registerLanguageCommand('_executeDocumentSymbolProvider', function (accessor, args) {
	const { resource } = args;
	if (!(resource instanceof URI)) {
		throw illegalArgument('resource');
	}
	const model = accessor.get(IModelService).getModel(resource);
	if (!model) {
		throw illegalArgument('resource');
	}
	return getDocumentSymbols(model);
});

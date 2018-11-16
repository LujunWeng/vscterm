/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isFalsyOrEmpty, mergeSort, flatten } from 'vs/base/common/arrays';
import { asWinJsPromise } from 'vs/base/common/async';
import { illegalArgument, onUnexpectedExternalError, isPromiseCanceledError } from 'vs/base/common/errors';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { registerLanguageCommand } from 'vs/editor/browser/editorExtensions';
import { Range } from 'vs/editor/common/core/range';
import { ITextModel } from 'vs/editor/common/model';
import { CodeAction, CodeActionProviderRegistry, CodeActionContext, CodeActionTrigger as CodeActionTriggerKind } from 'vs/editor/common/modes';
import { IModelService } from 'vs/editor/common/services/modelService';
import { CodeActionFilter, CodeActionKind, CodeActionTrigger } from './codeActionTrigger';
import { Selection } from 'vs/editor/common/core/selection';

export function getCodeActions(model: ITextModel, rangeOrSelection: Range | Selection, trigger?: CodeActionTrigger): TPromise<CodeAction[]> {
	const codeActionContext: CodeActionContext = {
		only: trigger && trigger.filter && trigger.filter.kind ? trigger.filter.kind.value : undefined,
		trigger: trigger && trigger.type === 'manual' ? CodeActionTriggerKind.Manual : CodeActionTriggerKind.Automatic
	};

	const promises = CodeActionProviderRegistry.all(model).map(support => {
		return asWinJsPromise(token => support.provideCodeActions(model, rangeOrSelection, codeActionContext, token)).then(providedCodeActions => {
			if (!Array.isArray(providedCodeActions)) {
				return [];
			}
			return providedCodeActions.filter(action => isValidAction(trigger && trigger.filter, action));
		}, (err): CodeAction[] => {
			if (isPromiseCanceledError(err)) {
				throw err;
			}

			onUnexpectedExternalError(err);
			return [];
		});
	});

	return TPromise.join(promises)
		.then(flatten)
		.then(allCodeActions => mergeSort(allCodeActions, codeActionsComparator));
}

function isValidAction(filter: CodeActionFilter | undefined, action: CodeAction): boolean {
	if (!action) {
		return false;
	}

	// Filter out actions by kind
	if (filter && filter.kind && (!action.kind || !filter.kind.contains(action.kind))) {
		return false;
	}

	// Don't return source actions unless they are explicitly requested
	if (action.kind && CodeActionKind.Source.contains(action.kind) && (!filter || !filter.includeSourceActions)) {
		return false;
	}

	return true;
}

function codeActionsComparator(a: CodeAction, b: CodeAction): number {
	const aHasDiags = !isFalsyOrEmpty(a.diagnostics);
	const bHasDiags = !isFalsyOrEmpty(b.diagnostics);
	if (aHasDiags) {
		if (bHasDiags) {
			return a.diagnostics[0].message.localeCompare(b.diagnostics[0].message);
		} else {
			return -1;
		}
	} else if (bHasDiags) {
		return 1;
	} else {
		return 0;	// both have no diagnostics
	}
}

registerLanguageCommand('_executeCodeActionProvider', function (accessor, args) {
	const { resource, range } = args;
	if (!(resource instanceof URI) || !Range.isIRange(range)) {
		throw illegalArgument();
	}

	const model = accessor.get(IModelService).getModel(resource);
	if (!model) {
		throw illegalArgument();
	}

	return getCodeActions(model, model.validateRange(range), undefined);
});

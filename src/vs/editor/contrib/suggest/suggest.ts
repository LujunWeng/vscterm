/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { sequence, asWinJsPromise } from 'vs/base/common/async';
import { isFalsyOrEmpty } from 'vs/base/common/arrays';
import { compareIgnoreCase } from 'vs/base/common/strings';
import { assign } from 'vs/base/common/objects';
import { onUnexpectedExternalError } from 'vs/base/common/errors';
import { TPromise } from 'vs/base/common/winjs.base';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { ITextModel } from 'vs/editor/common/model';
import { registerDefaultLanguageCommand } from 'vs/editor/browser/editorExtensions';
import { ISuggestResult, ISuggestSupport, ISuggestion, SuggestRegistry, SuggestContext, SuggestTriggerKind } from 'vs/editor/common/modes';
import { Position, IPosition } from 'vs/editor/common/core/position';
import { RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';

export const Context = {
	Visible: new RawContextKey<boolean>('suggestWidgetVisible', false),
	MultipleSuggestions: new RawContextKey<boolean>('suggestWidgetMultipleSuggestions', false),
	MakesTextEdit: new RawContextKey('suggestionMakesTextEdit', true),
	AcceptOnKey: new RawContextKey<boolean>('suggestionSupportsAcceptOnKey', true),
	AcceptSuggestionsOnEnter: new RawContextKey<boolean>('acceptSuggestionOnEnter', true)
};

export interface ISuggestionItem {
	position: IPosition;
	suggestion: ISuggestion;
	container: ISuggestResult;
	support: ISuggestSupport;
	resolve(): TPromise<void>;
}

export type SnippetConfig = 'top' | 'bottom' | 'inline' | 'none';

let _snippetSuggestSupport: ISuggestSupport;

export function setSnippetSuggestSupport(support: ISuggestSupport): ISuggestSupport {
	const old = _snippetSuggestSupport;
	_snippetSuggestSupport = support;
	return old;
}

export function provideSuggestionItems(model: ITextModel, position: Position, snippetConfig: SnippetConfig = 'bottom', onlyFrom?: ISuggestSupport[], context?: SuggestContext): TPromise<ISuggestionItem[]> {

	const allSuggestions: ISuggestionItem[] = [];
	const acceptSuggestion = createSuggesionFilter(snippetConfig);

	position = position.clone();

	// get provider groups, always add snippet suggestion provider
	const supports = SuggestRegistry.orderedGroups(model);

	// add snippets provider unless turned off
	if (snippetConfig !== 'none' && _snippetSuggestSupport) {
		supports.unshift([_snippetSuggestSupport]);
	}

	const suggestConext = context || { triggerKind: SuggestTriggerKind.Invoke };

	// add suggestions from contributed providers - providers are ordered in groups of
	// equal score and once a group produces a result the process stops
	let hasResult = false;
	const factory = supports.map(supports => {
		return () => {
			// stop when we have a result
			if (hasResult) {
				return undefined;
			}
			// for each support in the group ask for suggestions
			return TPromise.join(supports.map(support => {

				if (!isFalsyOrEmpty(onlyFrom) && onlyFrom.indexOf(support) < 0) {
					return undefined;
				}

				return asWinJsPromise(token => support.provideCompletionItems(model, position, suggestConext, token)).then(container => {

					const len = allSuggestions.length;

					if (container && !isFalsyOrEmpty(container.suggestions)) {
						for (let suggestion of container.suggestions) {
							if (acceptSuggestion(suggestion)) {

								fixOverwriteBeforeAfter(suggestion, container);

								allSuggestions.push({
									position,
									container,
									suggestion,
									support,
									resolve: createSuggestionResolver(support, suggestion, model, position)
								});
							}
						}
					}

					if (len !== allSuggestions.length && support !== _snippetSuggestSupport) {
						hasResult = true;
					}

				}, onUnexpectedExternalError);
			}));
		};
	});

	const result = sequence(factory).then(() => allSuggestions.sort(getSuggestionComparator(snippetConfig)));

	// result.then(items => {
	// 	console.log(model.getWordUntilPosition(position), items.map(item => `${item.suggestion.label}, type=${item.suggestion.type}, incomplete?${item.container.incomplete}, overwriteBefore=${item.suggestion.overwriteBefore}`));
	// 	return items;
	// }, err => {
	// 	console.warn(model.getWordUntilPosition(position), err);
	// });

	return result;
}

function fixOverwriteBeforeAfter(suggestion: ISuggestion, container: ISuggestResult): void {
	if (typeof suggestion.overwriteBefore !== 'number') {
		suggestion.overwriteBefore = 0;
	}
	if (typeof suggestion.overwriteAfter !== 'number' || suggestion.overwriteAfter < 0) {
		suggestion.overwriteAfter = 0;
	}
}

function createSuggestionResolver(provider: ISuggestSupport, suggestion: ISuggestion, model: ITextModel, position: Position): () => TPromise<void> {
	return () => {
		if (typeof provider.resolveCompletionItem === 'function') {
			return asWinJsPromise(token => provider.resolveCompletionItem(model, position, suggestion, token))
				.then(value => { assign(suggestion, value); });
		}
		return TPromise.as(void 0);
	};
}

function createSuggesionFilter(snippetConfig: SnippetConfig): (candidate: ISuggestion) => boolean {
	if (snippetConfig === 'none') {
		return suggestion => suggestion.type !== 'snippet';
	} else {
		return () => true;
	}
}
function defaultComparator(a: ISuggestionItem, b: ISuggestionItem): number {

	let ret = 0;

	// check with 'sortText'
	if (typeof a.suggestion.sortText === 'string' && typeof b.suggestion.sortText === 'string') {
		ret = compareIgnoreCase(a.suggestion.sortText, b.suggestion.sortText);
	}

	// check with 'label'
	if (ret === 0) {
		ret = compareIgnoreCase(a.suggestion.label, b.suggestion.label);
	}

	// check with 'type' and lower snippets
	if (ret === 0 && a.suggestion.type !== b.suggestion.type) {
		if (a.suggestion.type === 'snippet') {
			ret = 1;
		} else if (b.suggestion.type === 'snippet') {
			ret = -1;
		}
	}

	return ret;
}

function snippetUpComparator(a: ISuggestionItem, b: ISuggestionItem): number {
	if (a.suggestion.type !== b.suggestion.type) {
		if (a.suggestion.type === 'snippet') {
			return -1;
		} else if (b.suggestion.type === 'snippet') {
			return 1;
		}
	}
	return defaultComparator(a, b);
}

function snippetDownComparator(a: ISuggestionItem, b: ISuggestionItem): number {
	if (a.suggestion.type !== b.suggestion.type) {
		if (a.suggestion.type === 'snippet') {
			return 1;
		} else if (b.suggestion.type === 'snippet') {
			return -1;
		}
	}
	return defaultComparator(a, b);
}

export function getSuggestionComparator(snippetConfig: SnippetConfig): (a: ISuggestionItem, b: ISuggestionItem) => number {
	if (snippetConfig === 'top') {
		return snippetUpComparator;
	} else if (snippetConfig === 'bottom') {
		return snippetDownComparator;
	} else {
		return defaultComparator;
	}
}

registerDefaultLanguageCommand('_executeCompletionItemProvider', (model, position, args) => {

	const result: ISuggestResult = {
		incomplete: false,
		suggestions: []
	};

	let resolving: Thenable<any>[] = [];
	let maxItemsToResolve = args['maxItemsToResolve'] || 0;

	return provideSuggestionItems(model, position).then(items => {
		for (const item of items) {
			if (resolving.length < maxItemsToResolve) {
				resolving.push(item.resolve());
			}
			result.incomplete = result.incomplete || item.container.incomplete;
			result.suggestions.push(item.suggestion);
		}
	}).then(() => {
		return TPromise.join(resolving);
	}).then(() => {
		return result;
	});
});

interface SuggestController extends IEditorContribution {
	triggerSuggest(onlyFrom?: ISuggestSupport[]): void;
}

let _suggestions: ISuggestion[];
let _provider = new class implements ISuggestSupport {
	provideCompletionItems(): ISuggestResult {
		return _suggestions && { suggestions: _suggestions };
	}
};

SuggestRegistry.register('*', _provider);

export function showSimpleSuggestions(editor: ICodeEditor, suggestions: ISuggestion[]) {
	setTimeout(() => {
		_suggestions = suggestions;
		editor.getContribution<SuggestController>('editor.contrib.suggestController').triggerSuggest([_provider]);
		_suggestions = undefined;
	}, 0);
}

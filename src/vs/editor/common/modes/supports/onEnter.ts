/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import * as strings from 'vs/base/common/strings';
import { CharacterPair, IndentAction, EnterAction, OnEnterRule } from 'vs/editor/common/modes/languageConfiguration';

export interface IOnEnterSupportOptions {
	brackets?: CharacterPair[];
	regExpRules?: OnEnterRule[];
}

interface IProcessedBracketPair {
	open: string;
	close: string;
	openRegExp: RegExp;
	closeRegExp: RegExp;
}

export class OnEnterSupport {

	private readonly _brackets: IProcessedBracketPair[];
	private readonly _regExpRules: OnEnterRule[];

	constructor(opts?: IOnEnterSupportOptions) {
		opts = opts || {};
		opts.brackets = opts.brackets || [
			['(', ')'],
			['{', '}'],
			['[', ']']
		];

		this._brackets = opts.brackets.map((bracket) => {
			return {
				open: bracket[0],
				openRegExp: OnEnterSupport._createOpenBracketRegExp(bracket[0]),
				close: bracket[1],
				closeRegExp: OnEnterSupport._createCloseBracketRegExp(bracket[1]),
			};
		});
		this._regExpRules = opts.regExpRules || [];
	}

	public onEnter(oneLineAboveText: string, beforeEnterText: string, afterEnterText: string): EnterAction {
		// (1): `regExpRules`
		for (let i = 0, len = this._regExpRules.length; i < len; i++) {
			let rule = this._regExpRules[i];
			if (rule.beforeText.test(beforeEnterText)) {
				if (rule.afterText) {
					if (rule.afterText.test(afterEnterText)) {
						return rule.action;
					}
				} else {
					return rule.action;
				}
			}
		}

		// (2): Special indent-outdent
		if (beforeEnterText.length > 0 && afterEnterText.length > 0) {
			for (let i = 0, len = this._brackets.length; i < len; i++) {
				let bracket = this._brackets[i];
				if (bracket.openRegExp.test(beforeEnterText) && bracket.closeRegExp.test(afterEnterText)) {
					return { indentAction: IndentAction.IndentOutdent };
				}
			}
		}


		// (4): Open bracket based logic
		if (beforeEnterText.length > 0) {
			for (let i = 0, len = this._brackets.length; i < len; i++) {
				let bracket = this._brackets[i];
				if (bracket.openRegExp.test(beforeEnterText)) {
					return { indentAction: IndentAction.Indent };
				}
			}
		}

		return null;
	}

	private static _createOpenBracketRegExp(bracket: string): RegExp {
		let str = strings.escapeRegExpCharacters(bracket);
		if (!/\B/.test(str.charAt(0))) {
			str = '\\b' + str;
		}
		str += '\\s*$';
		return OnEnterSupport._safeRegExp(str);
	}

	private static _createCloseBracketRegExp(bracket: string): RegExp {
		let str = strings.escapeRegExpCharacters(bracket);
		if (!/\B/.test(str.charAt(str.length - 1))) {
			str = str + '\\b';
		}
		str = '^\\s*' + str;
		return OnEnterSupport._safeRegExp(str);
	}

	private static _safeRegExp(def: string): RegExp {
		try {
			return new RegExp(def);
		} catch (err) {
			onUnexpectedError(err);
			return null;
		}
	}
}

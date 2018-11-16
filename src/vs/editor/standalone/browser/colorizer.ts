/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IDisposable } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { ITextModel } from 'vs/editor/common/model';
import { ColorId, MetadataConsts, FontStyle, TokenizationRegistry, ITokenizationSupport } from 'vs/editor/common/modes';
import { IModeService } from 'vs/editor/common/services/modeService';
import { renderViewLine2 as renderViewLine, RenderLineInput } from 'vs/editor/common/viewLayout/viewLineRenderer';
import { LineTokens, IViewLineTokens } from 'vs/editor/common/core/lineTokens';
import * as strings from 'vs/base/common/strings';
import { IStandaloneThemeService } from 'vs/editor/standalone/common/standaloneThemeService';
import { ViewLineRenderingData } from 'vs/editor/common/viewModel/viewModel';

export interface IColorizerOptions {
	tabSize?: number;
}

export interface IColorizerElementOptions extends IColorizerOptions {
	theme?: string;
	mimeType?: string;
}

export class Colorizer {

	public static colorizeElement(themeService: IStandaloneThemeService, modeService: IModeService, domNode: HTMLElement, options: IColorizerElementOptions): TPromise<void> {
		options = options || {};
		let theme = options.theme || 'vs';
		let mimeType = options.mimeType || domNode.getAttribute('lang') || domNode.getAttribute('data-lang');
		if (!mimeType) {
			console.error('Mode not detected');
			return undefined;
		}

		themeService.setTheme(theme);

		let text = domNode.firstChild.nodeValue;
		domNode.className += ' ' + theme;
		let render = (str: string) => {
			domNode.innerHTML = str;
		};
		return this.colorize(modeService, text, mimeType, options).then(render, (err) => console.error(err), render);
	}

	private static _tokenizationSupportChangedPromise(language: string): TPromise<void> {
		let listener: IDisposable = null;
		let stopListening = () => {
			if (listener) {
				listener.dispose();
				listener = null;
			}
		};

		return new TPromise<void>((c, e, p) => {
			listener = TokenizationRegistry.onDidChange((e) => {
				if (e.changedLanguages.indexOf(language) >= 0) {
					stopListening();
					c(void 0);
				}
			});
		}, stopListening);
	}

	public static colorize(modeService: IModeService, text: string, mimeType: string, options: IColorizerOptions): TPromise<string> {
		if (strings.startsWithUTF8BOM(text)) {
			text = text.substr(1);
		}
		let lines = text.split(/\r\n|\r|\n/);
		let language = modeService.getModeId(mimeType);

		options = options || {};
		if (typeof options.tabSize === 'undefined') {
			options.tabSize = 4;
		}

		// Send out the event to create the mode
		modeService.getOrCreateMode(language);

		let tokenizationSupport = TokenizationRegistry.get(language);
		if (tokenizationSupport) {
			return TPromise.as(_colorize(lines, options.tabSize, tokenizationSupport));
		}

		// wait 500ms for mode to load, then give up
		return TPromise.any([this._tokenizationSupportChangedPromise(language), TPromise.timeout(500)]).then(_ => {
			let tokenizationSupport = TokenizationRegistry.get(language);
			if (tokenizationSupport) {
				return _colorize(lines, options.tabSize, tokenizationSupport);
			}
			return _fakeColorize(lines, options.tabSize);
		});
	}

	public static colorizeLine(line: string, mightContainNonBasicASCII: boolean, mightContainRTL: boolean, tokens: IViewLineTokens, tabSize: number = 4): string {
		const isBasicASCII = ViewLineRenderingData.isBasicASCII(line, mightContainNonBasicASCII);
		const containsRTL = ViewLineRenderingData.containsRTL(line, isBasicASCII, mightContainRTL);
		let renderResult = renderViewLine(new RenderLineInput(
			false,
			line,
			false,
			isBasicASCII,
			containsRTL,
			0,
			tokens,
			[],
			tabSize,
			0,
			-1,
			'none',
			false,
			false
		));
		return renderResult.html;
	}

	public static colorizeModelLine(model: ITextModel, lineNumber: number, tabSize: number = 4): string {
		let content = model.getLineContent(lineNumber);
		model.forceTokenization(lineNumber);
		let tokens = model.getLineTokens(lineNumber);
		let inflatedTokens = tokens.inflate();
		return this.colorizeLine(content, model.mightContainNonBasicASCII(), model.mightContainRTL(), inflatedTokens, tabSize);
	}
}

function _colorize(lines: string[], tabSize: number, tokenizationSupport: ITokenizationSupport): string {
	return _actualColorize(lines, tabSize, tokenizationSupport);
}

function _fakeColorize(lines: string[], tabSize: number): string {
	let html: string[] = [];

	const defaultMetadata = (
		(FontStyle.None << MetadataConsts.FONT_STYLE_OFFSET)
		| (ColorId.DefaultForeground << MetadataConsts.FOREGROUND_OFFSET)
		| (ColorId.DefaultBackground << MetadataConsts.BACKGROUND_OFFSET)
	) >>> 0;

	const tokens = new Uint32Array(2);
	tokens[0] = 0;
	tokens[1] = defaultMetadata;

	for (let i = 0, length = lines.length; i < length; i++) {
		let line = lines[i];

		tokens[0] = line.length;
		const lineTokens = new LineTokens(tokens, line);

		const isBasicASCII = ViewLineRenderingData.isBasicASCII(line, /* check for basic ASCII */true);
		const containsRTL = ViewLineRenderingData.containsRTL(line, isBasicASCII, /* check for RTL */true);
		let renderResult = renderViewLine(new RenderLineInput(
			false,
			line,
			false,
			isBasicASCII,
			containsRTL,
			0,
			lineTokens,
			[],
			tabSize,
			0,
			-1,
			'none',
			false,
			false
		));

		html = html.concat(renderResult.html);
		html.push('<br/>');
	}

	return html.join('');
}

function _actualColorize(lines: string[], tabSize: number, tokenizationSupport: ITokenizationSupport): string {
	let html: string[] = [];
	let state = tokenizationSupport.getInitialState();

	for (let i = 0, length = lines.length; i < length; i++) {
		let line = lines[i];
		let tokenizeResult = tokenizationSupport.tokenize2(line, state, 0);
		LineTokens.convertToEndOffset(tokenizeResult.tokens, line.length);
		let lineTokens = new LineTokens(tokenizeResult.tokens, line);
		const isBasicASCII = ViewLineRenderingData.isBasicASCII(line, /* check for basic ASCII */true);
		const containsRTL = ViewLineRenderingData.containsRTL(line, isBasicASCII, /* check for RTL */true);
		let renderResult = renderViewLine(new RenderLineInput(
			false,
			line,
			false,
			isBasicASCII,
			containsRTL,
			0,
			lineTokens.inflate(),
			[],
			tabSize,
			0,
			-1,
			'none',
			false,
			false
		));

		html = html.concat(renderResult.html);
		html.push('<br/>');

		state = tokenizeResult.endState;
	}

	return html.join('');
}

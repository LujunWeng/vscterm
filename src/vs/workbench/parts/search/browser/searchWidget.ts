/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as strings from 'vs/base/common/strings';
import * as dom from 'vs/base/browser/dom';
import { TPromise } from 'vs/base/common/winjs.base';
import { Widget } from 'vs/base/browser/ui/widget';
import { Action } from 'vs/base/common/actions';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { FindInput, IFindInputOptions } from 'vs/base/browser/ui/findinput/findInput';
import { InputBox, IMessage } from 'vs/base/browser/ui/inputbox/inputBox';
import { Button, IButtonOptions } from 'vs/base/browser/ui/button/button';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ContextKeyExpr, IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Event, Emitter } from 'vs/base/common/event';
import { Builder } from 'vs/base/browser/builder';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { isSearchViewFocused, appendKeyBindingLabel } from 'vs/workbench/parts/search/browser/searchActions';
import { HistoryNavigator } from 'vs/base/common/history';
import * as Constants from 'vs/workbench/parts/search/common/constants';
import { attachInputBoxStyler, attachFindInputBoxStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { CONTEXT_FIND_WIDGET_NOT_VISIBLE } from 'vs/editor/contrib/find/findModel';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { ISearchConfigurationProperties } from 'vs/platform/search/common/search';

export interface ISearchWidgetOptions {
	value?: string;
	isRegex?: boolean;
	isCaseSensitive?: boolean;
	isWholeWords?: boolean;
	searchHistory?: string[];
	historyLimit?: number;
	replaceHistory?: string[];
}

class ReplaceAllAction extends Action {

	private static fgInstance: ReplaceAllAction = null;
	public static readonly ID: string = 'search.action.replaceAll';

	static get INSTANCE(): ReplaceAllAction {
		if (ReplaceAllAction.fgInstance === null) {
			ReplaceAllAction.fgInstance = new ReplaceAllAction();
		}
		return ReplaceAllAction.fgInstance;
	}

	private _searchWidget: SearchWidget = null;

	constructor() {
		super(ReplaceAllAction.ID, '', 'action-replace-all', false);
	}

	set searchWidget(searchWidget: SearchWidget) {
		this._searchWidget = searchWidget;
	}

	run(): TPromise<any> {
		if (this._searchWidget) {
			return this._searchWidget.triggerReplaceAll();
		}
		return TPromise.as(null);
	}
}

export class SearchWidget extends Widget {

	private static readonly REPLACE_ALL_DISABLED_LABEL = nls.localize('search.action.replaceAll.disabled.label', "Replace All (Submit Search to Enable)");
	private static readonly REPLACE_ALL_ENABLED_LABEL = (keyBindingService2: IKeybindingService): string => {
		let kb = keyBindingService2.lookupKeybinding(ReplaceAllAction.ID);
		return appendKeyBindingLabel(nls.localize('search.action.replaceAll.enabled.label', "Replace All"), kb, keyBindingService2);
	}

	public domNode: HTMLElement;
	public searchInput: FindInput;
	private searchInputBoxFocused: IContextKey<boolean>;
	private replaceInputBoxFocused: IContextKey<boolean>;
	private replaceInput: InputBox;

	public searchInputFocusTracker: dom.IFocusTracker;
	public replaceInputFocusTracker: dom.IFocusTracker;

	private replaceContainer: HTMLElement;
	private toggleReplaceButton: Button;
	private replaceAllAction: ReplaceAllAction;
	private replaceActive: IContextKey<boolean>;
	private replaceActionBar: ActionBar;

	private searchHistory: HistoryNavigator<string>;
	private replaceHistory: HistoryNavigator<string>;
	private ignoreGlobalFindBufferOnNextFocus = false;
	private previousGlobalFindBufferValue: string;

	private _onSearchSubmit = this._register(new Emitter<boolean>());
	public readonly onSearchSubmit: Event<boolean> = this._onSearchSubmit.event;

	private _onSearchCancel = this._register(new Emitter<void>());
	public readonly onSearchCancel: Event<void> = this._onSearchCancel.event;

	private _onReplaceToggled = this._register(new Emitter<void>());
	public readonly onReplaceToggled: Event<void> = this._onReplaceToggled.event;

	private _onReplaceStateChange = this._register(new Emitter<boolean>());
	public readonly onReplaceStateChange: Event<boolean> = this._onReplaceStateChange.event;

	private _onReplaceValueChanged = this._register(new Emitter<string>());
	public readonly onReplaceValueChanged: Event<string> = this._onReplaceValueChanged.event;

	private _onReplaceAll = this._register(new Emitter<void>());
	public readonly onReplaceAll: Event<void> = this._onReplaceAll.event;

	constructor(
		container: Builder,
		options: ISearchWidgetOptions,
		@IContextViewService private contextViewService: IContextViewService,
		@IThemeService private themeService: IThemeService,
		@IContextKeyService private keyBindingService: IContextKeyService,
		@IKeybindingService private keyBindingService2: IKeybindingService,
		@IClipboardService private clipboardServce: IClipboardService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super();
		this.searchHistory = new HistoryNavigator<string>(options.searchHistory, options.historyLimit);
		this.replaceHistory = new HistoryNavigator<string>(options.replaceHistory, options.historyLimit);
		this.replaceActive = Constants.ReplaceActiveKey.bindTo(this.keyBindingService);
		this.searchInputBoxFocused = Constants.SearchInputBoxFocusedKey.bindTo(this.keyBindingService);
		this.replaceInputBoxFocused = Constants.ReplaceInputBoxFocusedKey.bindTo(this.keyBindingService);
		this.render(container, options);
	}

	public focus(select: boolean = true, focusReplace: boolean = false, suppressGlobalSearchBuffer = false): void {
		this.ignoreGlobalFindBufferOnNextFocus = suppressGlobalSearchBuffer;

		if (focusReplace && this.isReplaceShown()) {
			this.replaceInput.focus();
			if (select) {
				this.replaceInput.select();
			}
		} else {
			this.searchInput.focus();
			if (select) {
				this.searchInput.select();
			}
		}
	}

	public setWidth(width: number) {
		this.searchInput.setWidth(width);
		this.replaceInput.width = width - 28;
	}

	public clear() {
		this.searchInput.clear();
		this.replaceInput.value = '';
		this.setReplaceAllActionState(false);
	}

	public isReplaceShown(): boolean {
		return !dom.hasClass(this.replaceContainer, 'disabled');
	}

	public getReplaceValue(): string {
		return this.replaceInput.value;
	}

	public toggleReplace(show?: boolean): void {
		if (show === void 0 || show !== this.isReplaceShown()) {
			this.onToggleReplaceButton();
		}
	}

	public getSearchHistory(): string[] {
		return this.searchHistory.getHistory();
	}

	public getReplaceHistory(): string[] {
		return this.replaceHistory.getHistory();
	}

	public clearHistory(): void {
		this.searchHistory.clear();
	}

	public showNextSearchTerm() {
		let next = this.searchHistory.next();
		if (next) {
			this.searchInput.setValue(next);
		}
	}

	public showPreviousSearchTerm() {
		let previous;
		if (this.searchInput.getValue().length === 0) {
			previous = this.searchHistory.current();
		} else {
			this.searchHistory.addIfNotPresent(this.searchInput.getValue());
			previous = this.searchHistory.previous();
		}
		if (previous) {
			this.searchInput.setValue(previous);
		}
	}

	public showNextReplaceTerm() {
		let next = this.replaceHistory.next();
		if (next) {
			this.replaceInput.value = next;
		}
	}

	public showPreviousReplaceTerm() {
		let previous;
		if (this.replaceInput.value.length === 0) {
			previous = this.replaceHistory.current();
		} else {
			this.replaceHistory.addIfNotPresent(this.replaceInput.value);
			previous = this.replaceHistory.previous();
		}
		if (previous) {
			this.replaceInput.value = previous;
		}
	}

	public searchInputHasFocus(): boolean {
		return this.searchInputBoxFocused.get();
	}

	public replaceInputHasFocus(): boolean {
		return this.replaceInput.hasFocus();
	}

	private render(container: Builder, options: ISearchWidgetOptions): void {
		this.domNode = container.div({ 'class': 'search-widget' }).style({ position: 'relative' }).getHTMLElement();
		this.renderToggleReplaceButton(this.domNode);

		this.renderSearchInput(this.domNode, options);
		this.renderReplaceInput(this.domNode);
	}

	private renderToggleReplaceButton(parent: HTMLElement): void {
		const opts: IButtonOptions = {
			buttonBackground: null,
			buttonBorder: null,
			buttonForeground: null,
			buttonHoverBackground: null
		};
		this.toggleReplaceButton = this._register(new Button(parent, opts));
		this.toggleReplaceButton.icon = 'toggle-replace-button collapse';
		// TODO@joh need to dispose this listener eventually
		this.toggleReplaceButton.onDidClick(() => this.onToggleReplaceButton());
		this.toggleReplaceButton.element.title = nls.localize('search.replace.toggle.button.title', "Toggle Replace");
	}

	private renderSearchInput(parent: HTMLElement, options: ISearchWidgetOptions): void {
		let inputOptions: IFindInputOptions = {
			label: nls.localize('label.Search', 'Search: Type Search Term and press Enter to search or Escape to cancel'),
			validation: (value: string) => this.validateSearchInput(value),
			placeholder: nls.localize('search.placeHolder', "Search"),
			appendCaseSensitiveLabel: appendKeyBindingLabel('', this.keyBindingService2.lookupKeybinding(Constants.ToggleCaseSensitiveCommandId), this.keyBindingService2),
			appendWholeWordsLabel: appendKeyBindingLabel('', this.keyBindingService2.lookupKeybinding(Constants.ToggleWholeWordCommandId), this.keyBindingService2),
			appendRegexLabel: appendKeyBindingLabel('', this.keyBindingService2.lookupKeybinding(Constants.ToggleRegexCommandId), this.keyBindingService2)
		};

		let searchInputContainer = dom.append(parent, dom.$('.search-container.input-box'));
		this.searchInput = this._register(new FindInput(searchInputContainer, this.contextViewService, inputOptions));
		this._register(attachFindInputBoxStyler(this.searchInput, this.themeService));
		this.searchInput.onKeyUp((keyboardEvent: IKeyboardEvent) => this.onSearchInputKeyUp(keyboardEvent));
		this.searchInput.setValue(options.value || '');
		this.searchInput.setRegex(!!options.isRegex);
		this.searchInput.setCaseSensitive(!!options.isCaseSensitive);
		this.searchInput.setWholeWords(!!options.isWholeWords);
		this._register(this.onSearchSubmit(() => {
			this.searchHistory.add(this.searchInput.getValue());
		}));

		this._register(this.onReplaceValueChanged(() => {
			if ((this.replaceHistory.current() !== this.replaceInput.value) && (this.replaceInput.value)) {
				this.replaceHistory.add(this.replaceInput.value);
			}
		}));

		this.searchInputFocusTracker = this._register(dom.trackFocus(this.searchInput.inputBox.inputElement));
		this._register(this.searchInputFocusTracker.onDidFocus(() => {
			this.searchInputBoxFocused.set(true);

			const useGlobalFindBuffer = this.configurationService.getValue<ISearchConfigurationProperties>('search').globalFindClipboard;
			if (!this.ignoreGlobalFindBufferOnNextFocus && useGlobalFindBuffer) {
				const globalBufferText = this.clipboardServce.readFindText();
				if (this.previousGlobalFindBufferValue !== globalBufferText) {
					this.searchHistory.add(this.searchInput.getValue());
					this.searchInput.setValue(globalBufferText);
					this.searchInput.select();
				}

				this.previousGlobalFindBufferValue = globalBufferText;
			}

			this.ignoreGlobalFindBufferOnNextFocus = false;
		}));
		this._register(this.searchInputFocusTracker.onDidBlur(() => this.searchInputBoxFocused.set(false)));
	}

	private renderReplaceInput(parent: HTMLElement): void {
		this.replaceContainer = dom.append(parent, dom.$('.replace-container.disabled'));
		let replaceBox = dom.append(this.replaceContainer, dom.$('.input-box'));
		this.replaceInput = this._register(new InputBox(replaceBox, this.contextViewService, {
			ariaLabel: nls.localize('label.Replace', 'Replace: Type replace term and press Enter to preview or Escape to cancel'),
			placeholder: nls.localize('search.replace.placeHolder', "Replace")
		}));
		this._register(attachInputBoxStyler(this.replaceInput, this.themeService));
		this.onkeyup(this.replaceInput.inputElement, (keyboardEvent) => this.onReplaceInputKeyUp(keyboardEvent));
		this.replaceInput.onDidChange(() => this._onReplaceValueChanged.fire());
		this.searchInput.inputBox.onDidChange(() => this.onSearchInputChanged());

		this.replaceAllAction = ReplaceAllAction.INSTANCE;
		this.replaceAllAction.searchWidget = this;
		this.replaceAllAction.label = SearchWidget.REPLACE_ALL_DISABLED_LABEL;
		this.replaceActionBar = this._register(new ActionBar(this.replaceContainer));
		this.replaceActionBar.push([this.replaceAllAction], { icon: true, label: false });

		this.replaceInputFocusTracker = this._register(dom.trackFocus(this.replaceInput.inputElement));
		this._register(this.replaceInputFocusTracker.onDidFocus(() => this.replaceInputBoxFocused.set(true)));
		this._register(this.replaceInputFocusTracker.onDidBlur(() => this.replaceInputBoxFocused.set(false)));
	}

	triggerReplaceAll(): TPromise<any> {
		this._onReplaceAll.fire();
		return TPromise.as(null);
	}

	private onToggleReplaceButton(): void {
		dom.toggleClass(this.replaceContainer, 'disabled');
		dom.toggleClass(this.toggleReplaceButton.element, 'collapse');
		dom.toggleClass(this.toggleReplaceButton.element, 'expand');
		this.updateReplaceActiveState();
		this._onReplaceToggled.fire();
	}

	public setReplaceAllActionState(enabled: boolean): void {
		if (this.replaceAllAction.enabled !== enabled) {
			this.replaceAllAction.enabled = enabled;
			this.replaceAllAction.label = enabled ? SearchWidget.REPLACE_ALL_ENABLED_LABEL(this.keyBindingService2) : SearchWidget.REPLACE_ALL_DISABLED_LABEL;
			this.updateReplaceActiveState();
		}
	}

	private isReplaceActive(): boolean {
		return this.replaceActive.get();
	}

	private updateReplaceActiveState(): void {
		let currentState = this.isReplaceActive();
		let newState = this.isReplaceShown() && this.replaceAllAction.enabled;
		if (currentState !== newState) {
			this.replaceActive.set(newState);
			this._onReplaceStateChange.fire(newState);
		}
	}

	private validateSearchInput(value: string): IMessage {
		if (value.length === 0) {
			return null;
		}
		if (!this.searchInput.getRegex()) {
			return null;
		}
		let regExp: RegExp;
		try {
			regExp = new RegExp(value);
		} catch (e) {
			return { content: e.message };
		}
		if (strings.regExpLeadsToEndlessLoop(regExp)) {
			return { content: nls.localize('regexp.validationFailure', "Expression matches everything") };
		}

		if (strings.regExpContainsBackreference(value)) {
			return { content: nls.localize('regexp.backreferenceValidationFailure', "Backreferences are not supported") };
		}

		return null;
	}

	private onSearchInputChanged(): void {
		this.setReplaceAllActionState(false);
	}

	private onSearchInputKeyUp(keyboardEvent: IKeyboardEvent) {
		switch (keyboardEvent.keyCode) {
			case KeyCode.Enter:
				this.submitSearch();
				return;
			case KeyCode.Escape:
				this._onSearchCancel.fire();
				return;
			default:
				return;
		}
	}

	private onReplaceInputKeyUp(keyboardEvent: IKeyboardEvent) {
		switch (keyboardEvent.keyCode) {
			case KeyCode.Enter:
				this.submitSearch();
				return;
			default:
				return;
		}
	}

	private submitSearch(refresh: boolean = true): void {
		const value = this.searchInput.getValue();
		const useGlobalFindBuffer = this.configurationService.getValue<ISearchConfigurationProperties>('search').globalFindClipboard;
		if (value) {
			if (useGlobalFindBuffer) {
				this.clipboardServce.writeFindText(value);
			}

			this._onSearchSubmit.fire(refresh);
		}
	}

	public dispose(): void {
		this.setReplaceAllActionState(false);
		this.replaceAllAction.searchWidget = null;
		this.replaceActionBar = null;
		super.dispose();
	}
}

export function registerContributions() {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: ReplaceAllAction.ID,
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ContextKeyExpr.and(Constants.SearchViewVisibleKey, Constants.ReplaceActiveKey, CONTEXT_FIND_WIDGET_NOT_VISIBLE),
		primary: KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.Enter,
		handler: accessor => {
			if (isSearchViewFocused(accessor.get(IViewletService), accessor.get(IPanelService))) {
				ReplaceAllAction.INSTANCE.run();
			}
		}
	});
}

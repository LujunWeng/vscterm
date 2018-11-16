/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { localize } from 'vs/nls';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IMenu, MenuItemAction, IMenuActionOptions, ICommandAction } from 'vs/platform/actions/common/actions';
import { IAction } from 'vs/base/common/actions';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ActionItem, Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { domEvent } from 'vs/base/browser/event';
import { Emitter } from 'vs/base/common/event';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IdGenerator } from 'vs/base/common/idGenerator';
import { createCSSRule } from 'vs/base/browser/dom';
import URI from 'vs/base/common/uri';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { isWindows, isLinux } from 'vs/base/common/platform';

// The alternative key on all platforms is alt. On windows we also support shift as an alternative key #44136
class AlternativeKeyEmitter extends Emitter<boolean> {

	private _subscriptions: IDisposable[] = [];
	private _isPressed: boolean;
	private static instance: AlternativeKeyEmitter;
	private _suppressAltKeyUp: boolean = false;

	private constructor(contextMenuService: IContextMenuService) {
		super();

		this._subscriptions.push(domEvent(document.body, 'keydown')(e => {
			this.isPressed = e.altKey || ((isWindows || isLinux) && e.shiftKey);
		}));
		this._subscriptions.push(domEvent(document.body, 'keyup')(e => {
			if (this.isPressed) {
				if (this._suppressAltKeyUp) {
					e.preventDefault();
				}
			}

			this._suppressAltKeyUp = false;
			this.isPressed = false;
		}));
		this._subscriptions.push(domEvent(document.body, 'mouseleave')(e => this.isPressed = false));
		this._subscriptions.push(domEvent(document.body, 'blur')(e => this.isPressed = false));
		// Workaround since we do not get any events while a context menu is shown
		this._subscriptions.push(contextMenuService.onDidContextMenu(() => this.isPressed = false));
	}

	get isPressed(): boolean {
		return this._isPressed;
	}

	set isPressed(value: boolean) {
		this._isPressed = value;
		this.fire(this._isPressed);
	}

	suppressAltKeyUp() {
		// Sometimes the native alt behavior needs to be suppresed since the alt was already used as an alternative key
		// Example: windows behavior to toggle tha top level menu #44396
		this._suppressAltKeyUp = true;
	}

	static getInstance(contextMenuService: IContextMenuService) {
		if (!AlternativeKeyEmitter.instance) {
			AlternativeKeyEmitter.instance = new AlternativeKeyEmitter(contextMenuService);
		}

		return AlternativeKeyEmitter.instance;
	}

	dispose() {
		super.dispose();
		this._subscriptions = dispose(this._subscriptions);
	}
}

export function fillInContextMenuActions(menu: IMenu, options: IMenuActionOptions, target: IAction[] | { primary: IAction[]; secondary: IAction[]; }, contextMenuService: IContextMenuService, isPrimaryGroup?: (group: string) => boolean): void {
	const groups = menu.getActions(options);
	const getAlternativeActions = AlternativeKeyEmitter.getInstance(contextMenuService).isPressed;

	fillInActions(groups, target, getAlternativeActions, isPrimaryGroup);
}

export function fillInActionBarActions(menu: IMenu, options: IMenuActionOptions, target: IAction[] | { primary: IAction[]; secondary: IAction[]; }, isPrimaryGroup?: (group: string) => boolean): void {
	const groups = menu.getActions(options);
	// Action bars handle alternative actions on their own so the alternative actions should be ignored
	fillInActions(groups, target, false, isPrimaryGroup);
}

function fillInActions(groups: [string, MenuItemAction[]][], target: IAction[] | { primary: IAction[]; secondary: IAction[]; }, getAlternativeActions, isPrimaryGroup: (group: string) => boolean = group => group === 'navigation'): void {
	for (let tuple of groups) {
		let [group, actions] = tuple;
		if (getAlternativeActions) {
			actions = actions.map(a => !!a.alt ? a.alt : a);
		}

		if (isPrimaryGroup(group)) {

			const head = Array.isArray<IAction>(target) ? target : target.primary;

			// split contributed actions at the point where order
			// changes form lt zero to gte
			let pivot = 0;
			for (; pivot < actions.length; pivot++) {
				if ((<MenuItemAction>actions[pivot]).order >= 0) {
					break;
				}
			}
			// prepend contributed actions with order lte zero
			head.unshift(...actions.slice(0, pivot));

			// find the first separator which marks the end of the
			// navigation group - might be the whole array length
			let sep = 0;
			while (sep < head.length) {
				if (head[sep] instanceof Separator) {
					break;
				}
				sep++;
			}
			// append contributed actions with order gt zero
			head.splice(sep, 0, ...actions.slice(pivot));

		} else {
			const to = Array.isArray<IAction>(target) ? target : target.secondary;

			if (to.length > 0) {
				to.push(new Separator());
			}

			to.push(...actions);
		}
	}
}


export function createActionItem(action: IAction, keybindingService: IKeybindingService, notificationService: INotificationService, contextMenuService: IContextMenuService): ActionItem {
	if (action instanceof MenuItemAction) {
		return new MenuItemActionItem(action, keybindingService, notificationService, contextMenuService);
	}
	return undefined;
}

const ids = new IdGenerator('menu-item-action-item-icon-');

export class MenuItemActionItem extends ActionItem {

	static readonly ICON_PATH_TO_CSS_RULES: Map<string /* path*/, string /* CSS rule */> = new Map<string, string>();

	private _wantsAltCommand: boolean;
	private _itemClassDispose: IDisposable;

	constructor(
		public _action: MenuItemAction,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@INotificationService protected _notificationService: INotificationService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService
	) {
		super(undefined, _action, { icon: !!(_action.class || _action.item.iconPath), label: !_action.class && !_action.item.iconPath });
	}

	protected get _commandAction(): IAction {
		return this._wantsAltCommand && (<MenuItemAction>this._action).alt || this._action;
	}

	onClick(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();

		const altKey = AlternativeKeyEmitter.getInstance(this._contextMenuService);
		if (altKey.isPressed) {
			altKey.suppressAltKeyUp();
		}

		this.actionRunner.run(this._commandAction)
			.done(undefined, err => this._notificationService.error(err));
	}

	render(container: HTMLElement): void {
		super.render(container);

		this._updateItemClass(this._action.item);
		const alternativeKeyEmitter = AlternativeKeyEmitter.getInstance(this._contextMenuService);
		let alternativeKeyDown = alternativeKeyEmitter.isPressed;

		const updateAltState = () => {
			if (alternativeKeyDown !== this._wantsAltCommand) {
				this._wantsAltCommand = alternativeKeyDown;
				this._updateLabel();
				this._updateTooltip();
				this._updateClass();
			}
		};
		updateAltState();

		this._callOnDispose.push(alternativeKeyEmitter.event(value => {
			alternativeKeyDown = value;
			updateAltState();
		}));
	}

	_updateLabel(): void {
		if (this.options.label) {
			this.$e.text(this._commandAction.label);
		}
	}

	_updateTooltip(): void {
		const element = this.$e.getHTMLElement();
		const keybinding = this._keybindingService.lookupKeybinding(this._commandAction.id);
		const keybindingLabel = keybinding && keybinding.getLabel();

		element.title = keybindingLabel
			? localize('titleAndKb', "{0} ({1})", this._commandAction.label, keybindingLabel)
			: this._commandAction.label;
	}

	_updateClass(): void {
		if (this.options.icon) {
			if (this._commandAction !== this._action) {
				this._updateItemClass(this._action.alt.item);
			} else if ((<MenuItemAction>this._action).alt) {
				this._updateItemClass(this._action.item);
			}
		}
	}

	_updateItemClass(item: ICommandAction): void {
		dispose(this._itemClassDispose);
		this._itemClassDispose = undefined;

		if (item.iconPath) {
			let iconClass: string;

			if (MenuItemActionItem.ICON_PATH_TO_CSS_RULES.has(item.iconPath.dark)) {
				iconClass = MenuItemActionItem.ICON_PATH_TO_CSS_RULES.get(item.iconPath.dark);
			} else {
				iconClass = ids.nextId();
				createCSSRule(`.icon.${iconClass}`, `background-image: url("${URI.file(item.iconPath.light || item.iconPath.dark).toString()}")`);
				createCSSRule(`.vs-dark .icon.${iconClass}, .hc-black .icon.${iconClass}`, `background-image: url("${URI.file(item.iconPath.dark).toString()}")`);
				MenuItemActionItem.ICON_PATH_TO_CSS_RULES.set(item.iconPath.dark, iconClass);
			}

			this.$e.getHTMLElement().classList.add('icon', iconClass);
			this._itemClassDispose = { dispose: () => this.$e.getHTMLElement().classList.remove('icon', iconClass) };
		}
	}

	dispose(): void {
		if (this._itemClassDispose) {
			dispose(this._itemClassDispose);
			this._itemClassDispose = undefined;
		}

		super.dispose();
	}
}

// Need to subclass MenuItemActionItem in order to respect
// the action context coming from any action bar, without breaking
// existing users
export class ContextAwareMenuItemActionItem extends MenuItemActionItem {

	onClick(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();

		this.actionRunner.run(this._commandAction, this._context)
			.done(undefined, err => this._notificationService.error(err));
	}
}

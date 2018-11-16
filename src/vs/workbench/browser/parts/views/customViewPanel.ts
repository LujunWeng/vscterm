/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/views';
import { Event, Emitter } from 'vs/base/common/event';
import { IDisposable, dispose, empty as EmptyDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { TPromise } from 'vs/base/common/winjs.base';
import { IAction, IActionItem } from 'vs/base/common/actions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IMenuService, MenuId, MenuItemAction } from 'vs/platform/actions/common/actions';
import { ContextAwareMenuItemActionItem, fillInActionBarActions } from 'vs/platform/actions/browser/menuItemActionItem';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IViewsService, ITreeViewer } from 'vs/workbench/common/views';
import { IViewletViewOptions, IViewOptions, ViewsViewletPanel } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { INotificationService } from 'vs/platform/notification/common/notification';

export class CustomTreeViewPanel extends ViewsViewletPanel {

	private menus: Menus;
	private treeViewer: ITreeViewer;

	constructor(
		options: IViewletViewOptions,
		@INotificationService private notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IViewsService viewsService: IViewsService,
	) {
		super({ ...(options as IViewOptions), ariaHeaderLabel: options.name }, keybindingService, contextMenuService, configurationService);
		this.treeViewer = viewsService.getTreeViewer(this.id);
		this.disposables.push(toDisposable(() => this.treeViewer.setVisibility(false)));
		this.menus = this.instantiationService.createInstance(Menus, this.id);
		this.menus.onDidChangeTitle(() => this.updateActions(), this, this.disposables);
		this.updateTreeVisibility();
	}

	setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible).then(() => this.updateTreeVisibility());
	}

	focus(): void {
		super.focus();
		this.treeViewer.focus();
	}

	renderBody(container: HTMLElement): void {
		this.treeViewer.show(container);
	}

	setExpanded(expanded: boolean): void {
		this.treeViewer.setVisibility(this.isVisible() && expanded);
		super.setExpanded(expanded);
	}

	layoutBody(size: number): void {
		this.treeViewer.layout(size);
	}

	getActions(): IAction[] {
		return [...this.menus.getTitleActions()];
	}

	getSecondaryActions(): IAction[] {
		return this.menus.getTitleSecondaryActions();
	}

	getActionItem(action: IAction): IActionItem {
		return action instanceof MenuItemAction ? new ContextAwareMenuItemActionItem(action, this.keybindingService, this.notificationService, this.contextMenuService) : undefined;
	}

	getOptimalWidth(): number {
		return this.treeViewer.getOptimalWidth();
	}

	private updateTreeVisibility(): void {
		this.treeViewer.setVisibility(this.isVisible() && this.isExpanded());
	}

	dispose(): void {
		dispose(this.disposables);
		super.dispose();
	}
}

export class Menus implements IDisposable {

	private disposables: IDisposable[] = [];
	private titleDisposable: IDisposable = EmptyDisposable;
	private titleActions: IAction[] = [];
	private titleSecondaryActions: IAction[] = [];

	private _onDidChangeTitle = new Emitter<void>();
	get onDidChangeTitle(): Event<void> { return this._onDidChangeTitle.event; }

	constructor(
		id: string,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IMenuService private menuService: IMenuService,
	) {
		if (this.titleDisposable) {
			this.titleDisposable.dispose();
			this.titleDisposable = EmptyDisposable;
		}

		const _contextKeyService = this.contextKeyService.createScoped();
		_contextKeyService.createKey('view', id);

		const titleMenu = this.menuService.createMenu(MenuId.ViewTitle, _contextKeyService);
		const updateActions = () => {
			this.titleActions = [];
			this.titleSecondaryActions = [];
			fillInActionBarActions(titleMenu, undefined, { primary: this.titleActions, secondary: this.titleSecondaryActions });
			this._onDidChangeTitle.fire();
		};

		const listener = titleMenu.onDidChange(updateActions);
		updateActions();

		this.titleDisposable = toDisposable(() => {
			listener.dispose();
			titleMenu.dispose();
			_contextKeyService.dispose();
			this.titleActions = [];
			this.titleSecondaryActions = [];
		});
	}

	getTitleActions(): IAction[] {
		return this.titleActions;
	}

	getTitleSecondaryActions(): IAction[] {
		return this.titleSecondaryActions;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

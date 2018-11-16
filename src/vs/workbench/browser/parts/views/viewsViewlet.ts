/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TPromise } from 'vs/base/common/winjs.base';
import * as errors from 'vs/base/common/errors';
import * as DOM from 'vs/base/browser/dom';
import { Scope } from 'vs/workbench/common/memento';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { IAction, IActionRunner } from 'vs/base/common/actions';
import { IActionItem, Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { firstIndex } from 'vs/base/common/arrays';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { ViewsRegistry, ViewLocation, IViewDescriptor, IViewsViewlet } from 'vs/workbench/common/views';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IContextKeyService, IContextKeyChangeEvent } from 'vs/platform/contextkey/common/contextkey';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { PanelViewlet, ViewletPanel } from 'vs/workbench/browser/parts/views/panelViewlet';
import { IPanelOptions, DefaultPanelDndController } from 'vs/base/browser/ui/splitview/panelview';
import { WorkbenchTree, IListService } from 'vs/platform/list/browser/listService';
import { IWorkbenchThemeService, IFileIconTheme } from 'vs/workbench/services/themes/common/workbenchThemeService';
import { ITreeConfiguration, ITreeOptions } from 'vs/base/parts/tree/browser/tree';
import { Event, Emitter } from 'vs/base/common/event';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { localize } from 'vs/nls';
import { isUndefined, isUndefinedOrNull } from 'vs/base/common/types';

export interface IViewOptions extends IPanelOptions {
	id: string;
	name: string;
	actionRunner: IActionRunner;
}

export abstract class ViewsViewletPanel extends ViewletPanel {

	private _isVisible: boolean;

	readonly id: string;
	readonly name: string;

	constructor(
		options: IViewOptions,
		protected keybindingService: IKeybindingService,
		protected contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(options.name, options, keybindingService, contextMenuService, configurationService);

		this.id = options.id;
		this.name = options.name;
		this._expanded = options.expanded;
	}

	setVisible(visible: boolean): TPromise<void> {
		if (this._isVisible !== visible) {
			this._isVisible = visible;
		}

		return TPromise.wrap(null);
	}

	isVisible(): boolean {
		return this._isVisible;
	}

	getActions(): IAction[] {
		return [];
	}

	getSecondaryActions(): IAction[] {
		return [];
	}

	getActionItem(action: IAction): IActionItem {
		return null;
	}

	getActionsContext(): any {
		return undefined;
	}

	getOptimalWidth(): number {
		return 0;
	}

	create(): TPromise<void> {
		return TPromise.as(null);
	}

	shutdown(): void {
		// Subclass to implement
	}

}

export abstract class TreeViewsViewletPanel extends ViewsViewletPanel {

	protected tree: WorkbenchTree;

	setExpanded(expanded: boolean): void {
		if (this.isExpanded() !== expanded) {
			this.updateTreeVisibility(this.tree, expanded);
			super.setExpanded(expanded);
		}
	}

	setVisible(visible: boolean): TPromise<void> {
		if (this.isVisible() !== visible) {
			return super.setVisible(visible)
				.then(() => this.updateTreeVisibility(this.tree, visible && this.isExpanded()));
		}
		return TPromise.wrap(null);
	}

	focus(): void {
		super.focus();
		this.focusTree();
	}

	layoutBody(size: number): void {
		if (this.tree) {
			this.tree.layout(size);
		}
	}

	protected updateTreeVisibility(tree: WorkbenchTree, isVisible: boolean): void {
		if (!tree) {
			return;
		}

		if (isVisible) {
			DOM.show(tree.getHTMLElement());
		} else {
			DOM.hide(tree.getHTMLElement()); // make sure the tree goes out of the tabindex world by hiding it
		}

		if (isVisible) {
			tree.onVisible();
		} else {
			tree.onHidden();
		}
	}

	private focusTree(): void {
		if (!this.tree) {
			return; // return early if viewlet has not yet been created
		}

		// Make sure the current selected element is revealed
		const selectedElement = this.tree.getSelection()[0];
		if (selectedElement) {
			this.tree.reveal(selectedElement, 0.5).done(null, errors.onUnexpectedError);
		}

		// Pass Focus to Viewer
		this.tree.domFocus();
	}

	dispose(): void {
		if (this.tree) {
			this.tree.dispose();
		}
		super.dispose();
	}
}

export interface IViewletViewOptions extends IViewOptions {
	viewletSettings: object;
}

export interface IViewState {
	collapsed: boolean;
	size: number | undefined;
	isHidden: boolean;
	order: number;
}

export class ViewsViewlet extends PanelViewlet implements IViewsViewlet {

	private viewHeaderContextMenuListeners: IDisposable[] = [];
	private viewletSettings: object;
	private readonly viewsContextKeys: Set<string> = new Set<string>();
	private viewsViewletPanels: ViewsViewletPanel[] = [];
	private didLayout = false;
	private dimension: DOM.Dimension;
	protected viewsStates: Map<string, IViewState> = new Map<string, IViewState>();
	private areExtensionsReady: boolean = false;

	private readonly _onDidChangeViewVisibilityState: Emitter<string> = new Emitter<string>();
	readonly onDidChangeViewVisibilityState: Event<string> = this._onDidChangeViewVisibilityState.event;

	private readonly visibleViewsCountFromCache: number;
	private readonly visibleViewsStorageId: string;

	constructor(
		id: string,
		private location: ViewLocation,
		showHeaderInTitleWhenSingleView: boolean,
		@IPartService partService: IPartService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService protected storageService: IStorageService,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IContextKeyService protected contextKeyService: IContextKeyService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IExtensionService protected extensionService: IExtensionService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService
	) {
		super(id, { showHeaderInTitleWhenSingleView, dnd: new DefaultPanelDndController() }, partService, contextMenuService, telemetryService, themeService);
		this.visibleViewsStorageId = `${id}.numberOfVisibleViews`;
		this.visibleViewsCountFromCache = this.storageService.getInteger(this.visibleViewsStorageId, this.contextService.getWorkbenchState() === WorkbenchState.EMPTY ? StorageScope.GLOBAL : StorageScope.WORKSPACE, 0);
		this.viewletSettings = this.getMemento(storageService, Scope.WORKSPACE);
	}

	async create(parent: HTMLElement): TPromise<void> {
		await super.create(parent);

		this._register(this.onDidSashChange(() => this.snapshotViewsStates()));
		this._register(ViewsRegistry.onViewsRegistered(this.onViewsRegistered, this));
		this._register(ViewsRegistry.onViewsDeregistered(this.onViewsDeregistered, this));
		this._register(this.contextKeyService.onDidChangeContext(this.onContextChanged, this));

		// Update headers after and title contributed views after available, since we read from cache in the beginning to know if the viewlet has single view or not. Ref #29609
		this.extensionService.whenInstalledExtensionsRegistered().then(() => {
			this.areExtensionsReady = true;
			this.updateHeaders();
		});

		this.onViewsRegistered(ViewsRegistry.getViews(this.location));
		this.focus();
	}

	getContextMenuActions(): IAction[] {
		const result: IAction[] = [];
		const viewToggleActions = this.getViewDescriptorsFromRegistry()
			.filter(viewDescriptor => this.contextKeyService.contextMatchesRules(viewDescriptor.when))
			.map(viewDescriptor => (<IAction>{
				id: `${viewDescriptor.id}.toggleVisibility`,
				label: viewDescriptor.name,
				checked: this.isCurrentlyVisible(viewDescriptor),
				enabled: viewDescriptor.canToggleVisibility,
				run: () => this.toggleViewVisibility(viewDescriptor.id)
			}));
		result.push(...viewToggleActions);
		const parentActions = super.getContextMenuActions();
		if (viewToggleActions.length && parentActions.length) {
			result.push(new Separator());
		}
		result.push(...parentActions);
		return result;
	}

	setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible)
			.then(() => TPromise.join(this.viewsViewletPanels.filter(view => view.isVisible() !== visible)
				.map((view) => view.setVisible(visible))))
			.then(() => void 0);
	}

	openView(id: string, focus?: boolean): TPromise<void> {
		if (focus) {
			this.focus();
		}
		const view = this.getView(id);
		if (view) {
			view.setExpanded(true);
			if (focus) {
				view.focus();
			}
			return TPromise.as(null);
		} else {
			return this.toggleViewVisibility(id, focus);
		}
	}

	layout(dimension: DOM.Dimension): void {
		super.layout(dimension);
		this.dimension = dimension;
		if (this.didLayout) {
			this.snapshotViewsStates();
		} else {
			this.didLayout = true;
			this.resizePanels();
		}

	}

	getOptimalWidth(): number {
		const additionalMargin = 16;
		const optimalWidth = Math.max(...this.viewsViewletPanels.map(view => view.getOptimalWidth() || 0));
		return optimalWidth + additionalMargin;
	}

	shutdown(): void {
		this.viewsViewletPanels.forEach((view) => view.shutdown());
		this.storageService.store(this.visibleViewsStorageId, this.length, this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL);
		super.shutdown();
	}

	private toggleViewVisibility(id: string, focus?: boolean): TPromise<void> {
		const viewDescriptor = this.getViewDescriptorsFromRegistry().filter(v => v.id === id)[0];
		const viewState = this.viewsStates.get(id);

		if (!viewDescriptor || !viewState) {
			return TPromise.as(null);
		}

		if (!viewDescriptor.canToggleVisibility) {
			return TPromise.wrapError(new Error(localize({ key: 'cannot toggle', comment: ['Parameter that will be replaced here is the id of the view'] }, "Visibility cannot be toggled for this view {0}", id)));
		}

		if (viewState.isHidden && !this.contextKeyService.contextMatchesRules(viewDescriptor.when)) {
			return TPromise.wrapError(new Error(localize('cannot show', "This view {0} cannot be shown because it is hidden by its 'when' condition", id)));
		}

		viewState.isHidden = !viewState.isHidden;
		return this.updateViews()
			.then(() => {
				this._onDidChangeViewVisibilityState.fire(id);
				const view = this.getView(id);
				if (view) {
					view.setExpanded(true);
					if (focus) {
						view.focus();
					}
				} else if (focus) {
					this.focus();
				}
			});
	}

	private onViewsRegistered(views: IViewDescriptor[]): void {
		this.viewsContextKeys.clear();
		for (const viewDescriptor of this.getViewDescriptorsFromRegistry()) {
			if (viewDescriptor.when) {
				for (const key of viewDescriptor.when.keys()) {
					this.viewsContextKeys.add(key);
				}
			}

			// Update view state
			const viewState = this.viewsStates.get(viewDescriptor.id) || { collapsed: void 0, isHidden: void 0, order: void 0, size: void 0 };
			viewState.collapsed = isUndefined(viewState.collapsed) ? viewDescriptor.collapsed : viewState.collapsed;
			viewState.isHidden = isUndefined(viewState.isHidden) ? !!viewDescriptor.hideByDefault : viewState.isHidden;
			viewState.order = isUndefined(viewState.order) ? viewDescriptor.order : viewState.order;
			this.viewsStates.set(viewDescriptor.id, viewState);
		}

		this.updateViews();
	}

	private onViewsDeregistered(views: IViewDescriptor[]): void {
		this.updateViews(views);
	}

	private onContextChanged(event: IContextKeyChangeEvent): void {
		if (event.affectsSome(this.viewsContextKeys)) {
			this.updateViews();
		}
	}

	protected updateViews(unregisteredViews: IViewDescriptor[] = []): TPromise<ViewsViewletPanel[]> {
		const registeredViews = this.getViewDescriptorsFromRegistry();
		const [visible, toAdd, toRemove] = registeredViews.reduce<[IViewDescriptor[], IViewDescriptor[], IViewDescriptor[]]>((result, viewDescriptor) => {
			const isCurrentlyVisible = this.isCurrentlyVisible(viewDescriptor);
			const canBeVisible = this.canBeVisible(viewDescriptor);

			if (canBeVisible) {
				result[0].push(viewDescriptor);
			}

			if (!isCurrentlyVisible && canBeVisible) {
				result[1].push(viewDescriptor);
			}

			if (isCurrentlyVisible && !canBeVisible) {
				result[2].push(viewDescriptor);
			}

			return result;

		}, [[], [], []]);

		toRemove.push(...unregisteredViews.filter(viewDescriptor => this.isCurrentlyVisible(viewDescriptor)));

		const toCreate: ViewsViewletPanel[] = [];

		if (toAdd.length || toRemove.length) {

			this.snapshotViewsStates();

			if (toRemove.length) {
				const panelsToRemove: ViewsViewletPanel[] = toRemove.map(viewDescriptor => this.getView(viewDescriptor.id));
				this.removePanels(panelsToRemove);
				for (const panel of panelsToRemove) {
					this.viewsViewletPanels.splice(this.viewsViewletPanels.indexOf(panel), 1);
					panel.dispose();
				}
			}

			const panelsToAdd: { panel: ViewsViewletPanel, size: number, index: number }[] = [];
			for (const viewDescriptor of toAdd) {
				let viewState = this.viewsStates.get(viewDescriptor.id);
				let index = visible.indexOf(viewDescriptor);
				const panel = this.createView(viewDescriptor,
					{
						id: viewDescriptor.id,
						name: viewDescriptor.name,
						actionRunner: this.getActionRunner(),
						expanded: !(viewState ? viewState.collapsed : viewDescriptor.collapsed),
						viewletSettings: this.viewletSettings
					});
				panel.render();
				toCreate.push(panel);

				const size = (viewState && viewState.size) || 200;
				panelsToAdd.push({ panel, size, index });
			}

			this.addPanels(panelsToAdd);

			for (const { panel, index } of panelsToAdd) {
				this.viewsViewletPanels.splice(index, 0, panel);
			}

			return TPromise.join(toCreate.map(view => view.create()))
				.then(() => this.onViewsUpdated())
				.then(() => {
					this.resizePanels(toCreate);
					return toCreate;
				});
		}

		return TPromise.as([]);
	}

	private resizePanels(panels: ViewsViewletPanel[] = this.viewsViewletPanels): void {
		if (!this.didLayout) {
			// Do not do anything if layout has not happened yet
			return;
		}

		let initialSizes;
		for (const panel of panels) {
			const viewState = this.viewsStates.get(panel.id);
			if (viewState && viewState.size) {
				this.resizePanel(panel, viewState.size);
			} else {
				initialSizes = initialSizes ? initialSizes : this.computeInitialSizes();
				this.resizePanel(panel, initialSizes[panel.id] || 200);
			}
		}

		this.snapshotViewsStates();
	}

	private computeInitialSizes(): { [id: string]: number } {
		let sizes = {};
		if (this.dimension) {
			let totalWeight = 0;
			const allViewDescriptors = this.getViewDescriptorsFromRegistry();
			const viewDescriptors: IViewDescriptor[] = [];
			for (const panel of this.viewsViewletPanels) {
				const viewDescriptor = allViewDescriptors.filter(viewDescriptor => viewDescriptor.id === panel.id)[0];
				totalWeight = totalWeight + (viewDescriptor.weight || 20);
				viewDescriptors.push(viewDescriptor);
			}
			for (const viewDescriptor of viewDescriptors) {
				sizes[viewDescriptor.id] = this.dimension.height * (viewDescriptor.weight || 20) / totalWeight;
			}
		}
		return sizes;
	}

	movePanel(from: ViewletPanel, to: ViewletPanel): void {
		const fromIndex = firstIndex(this.viewsViewletPanels, panel => panel === from);
		const toIndex = firstIndex(this.viewsViewletPanels, panel => panel === to);

		if (fromIndex < 0 || fromIndex >= this.viewsViewletPanels.length) {
			return;
		}

		if (toIndex < 0 || toIndex >= this.viewsViewletPanels.length) {
			return;
		}

		super.movePanel(from, to);

		const [panel] = this.viewsViewletPanels.splice(fromIndex, 1);
		this.viewsViewletPanels.splice(toIndex, 0, panel);

		for (let order = 0; order < this.viewsViewletPanels.length; order++) {
			const view = this.viewsStates.get(this.viewsViewletPanels[order].id);

			if (!view) {
				continue;
			}

			view.order = order;
		}
	}

	private isCurrentlyVisible(viewDescriptor: IViewDescriptor): boolean {
		return !!this.getView(viewDescriptor.id);
	}

	private canBeVisible(viewDescriptor: IViewDescriptor): boolean {
		if (!this.contextKeyService.contextMatchesRules(viewDescriptor.when)) {
			return false;
		}

		const viewstate = this.viewsStates.get(viewDescriptor.id);
		if (viewstate && viewDescriptor.canToggleVisibility) {
			return !viewstate.isHidden;
		}

		return true;
	}

	private onViewsUpdated(): TPromise<void> {
		this.viewHeaderContextMenuListeners = dispose(this.viewHeaderContextMenuListeners);

		for (const viewDescriptor of this.getViewDescriptorsFromRegistry()) {
			const view = this.getView(viewDescriptor.id);

			if (view) {
				this.viewHeaderContextMenuListeners.push(DOM.addDisposableListener(view.draggableElement, DOM.EventType.CONTEXT_MENU, e => {
					e.stopPropagation();
					e.preventDefault();
					this.onContextMenu(new StandardMouseEvent(e), viewDescriptor);
				}));
			}
		}

		return this.setVisible(this.isVisible());
	}

	private updateHeaders(): void {
		if (this.viewsViewletPanels.length) {
			this.updateTitleArea();
			this.updateViewHeaders();
		}
	}

	private onContextMenu(event: StandardMouseEvent, viewDescriptor: IViewDescriptor): void {
		event.stopPropagation();
		event.preventDefault();

		const actions: IAction[] = [];
		actions.push(<IAction>{
			id: `${viewDescriptor.id}.removeView`,
			label: localize('hideView', "Hide"),
			enabled: viewDescriptor.canToggleVisibility,
			run: () => this.toggleViewVisibility(viewDescriptor.id)
		});
		const otherActions = this.getContextMenuActions();
		if (otherActions.length) {
			actions.push(...[new Separator(), ...otherActions]);
		}

		let anchor: { x: number, y: number } = { x: event.posx, y: event.posy };
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => TPromise.as(actions)
		});
	}

	protected isSingleView(): boolean {
		if (!super.isSingleView()) {
			return false;
		}
		if (!this.areExtensionsReady) {
			// Check in cache so that view do not jump. See #29609
			return this.visibleViewsCountFromCache === 1;
		}
		return true;
	}

	protected getViewDescriptorsFromRegistry(): IViewDescriptor[] {
		return ViewsRegistry.getViews(this.location)
			.sort((a, b) => {
				const viewStateA = this.viewsStates.get(a.id);
				const viewStateB = this.viewsStates.get(b.id);
				const orderA = viewStateA ? viewStateA.order : a.order;
				const orderB = viewStateB ? viewStateB.order : b.order;

				if (isUndefinedOrNull(orderB)) {
					return -1;
				}
				if (isUndefinedOrNull(orderA)) {
					return 1;
				}

				return orderA - orderB;
			});
	}

	protected createView(viewDescriptor: IViewDescriptor, options: IViewletViewOptions): ViewsViewletPanel {
		return this.instantiationService.createInstance(viewDescriptor.ctor, options) as ViewsViewletPanel;
	}

	protected get views(): ViewsViewletPanel[] {
		return this.viewsViewletPanels;
	}

	protected getView(id: string): ViewsViewletPanel {
		return this.viewsViewletPanels.filter(view => view.id === id)[0];
	}

	private snapshotViewsStates(): void {
		for (const view of this.viewsViewletPanels) {
			const currentState = this.viewsStates.get(view.id);
			if (currentState && !this.didLayout) {
				// Do not update to new state if the layout has not happened yet
				return;
			}

			const collapsed = !view.isExpanded();
			const panelSize = this.getPanelSize(view);
			// Do not save order because views can come late.
			if (currentState) {
				currentState.collapsed = collapsed;
				currentState.size = collapsed ? currentState.size : panelSize;
			} else {
				this.viewsStates.set(view.id, {
					collapsed,
					size: this.didLayout ? panelSize : void 0,
					isHidden: false,
					order: void 0
				});
			}
		}
	}
}

export class PersistentViewsViewlet extends ViewsViewlet {

	private readonly hiddenViewsStorageId: string;

	constructor(
		id: string,
		location: ViewLocation,
		private readonly viewletStateStorageId: string,
		showHeaderInTitleWhenSingleView: boolean,
		@IPartService partService: IPartService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService
	) {
		super(id, location, showHeaderInTitleWhenSingleView, partService, telemetryService, storageService, instantiationService, themeService, contextKeyService, contextMenuService, extensionService, contextService);
		this.hiddenViewsStorageId = `${this.viewletStateStorageId}.hidden`;
		this._register(this.onDidChangeViewVisibilityState(id => this.saveViewsStates()));
	}

	create(parent: HTMLElement): TPromise<void> {
		this.loadViewsStates();
		return super.create(parent);
	}

	shutdown(): void {
		this.saveViewsStates();
		super.shutdown();
	}

	private saveViewsStates(): void {
		const storedViewsStates: { [id: string]: { collapsed: boolean, size: number, order: number } } = {};
		const storedViewsVisibilityStates: { id: string, isHidden: boolean }[] = [];
		for (const viewDescriptor of this.getViewDescriptorsFromRegistry()) {
			const viewState = this.viewsStates.get(viewDescriptor.id);
			if (viewState) {
				const view = this.getView(viewDescriptor.id);
				storedViewsVisibilityStates.push({ id: viewDescriptor.id, isHidden: viewState ? viewState.isHidden : void 0 });
				if (view) {
					storedViewsStates[viewDescriptor.id] = {
						collapsed: !view.isExpanded(),
						size: this.getPanelSize(view),
						order: viewState.order
					};
				} else {
					storedViewsStates[viewDescriptor.id] = { collapsed: viewState.collapsed, size: viewState.size, order: viewState.order };
				}
			}
		}
		this.storageService.store(this.viewletStateStorageId, JSON.stringify(storedViewsStates), this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL);
		this.storageService.store(this.hiddenViewsStorageId, JSON.stringify(storedViewsVisibilityStates), StorageScope.GLOBAL);
	}

	protected loadViewsStates(): void {
		const viewsStates = JSON.parse(this.storageService.get(this.viewletStateStorageId, this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL, '{}'));
		const viewsVisibilityStates = this.loadViewsVisibilityStates();
		for (const { id, isHidden } of viewsVisibilityStates) {
			const viewState = viewsStates[id];
			// View state should exist always. Add a check if in case does not exist.
			if (viewState) {
				this.viewsStates.set(id, <IViewState>{ ...viewState, ...{ isHidden } });
			}
		}

		// Migration: Update those not existing in visibility states
		for (const id of Object.keys(viewsStates)) {
			if (!this.viewsStates.has(id)) {
				this.viewsStates.set(id, <IViewState>{ ...viewsStates[id], ...{ isHidden: false } });
			}
		}
	}

	private loadViewsVisibilityStates(): { id: string, isHidden: boolean }[] {
		const storedStates = <Array<string | { id: string, isHidden: boolean }>>JSON.parse(this.storageService.get(this.hiddenViewsStorageId, StorageScope.GLOBAL, '[]'));
		return <{ id: string, isHidden: boolean }[]>storedStates.map(c =>
			typeof c === 'string' /* migration */ ? { id: c, isHidden: true } : c);
	}
}

export class FileIconThemableWorkbenchTree extends WorkbenchTree {

	constructor(
		container: HTMLElement,
		configuration: ITreeConfiguration,
		options: ITreeOptions,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService listService: IListService,
		@IThemeService themeService: IWorkbenchThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(container, configuration, { ...options, ...{ showTwistie: false, twistiePixels: 12 } }, contextKeyService, listService, themeService, instantiationService, configurationService);

		DOM.addClass(container, 'file-icon-themable-tree');
		DOM.addClass(container, 'show-file-icons');

		const onFileIconThemeChange = (fileIconTheme: IFileIconTheme) => {
			DOM.toggleClass(container, 'align-icons-and-twisties', fileIconTheme.hasFileIcons && !fileIconTheme.hasFolderIcons);
			DOM.toggleClass(container, 'hide-arrows', fileIconTheme.hidesExplorerArrows === true);
		};

		this.disposables.push(themeService.onDidFileIconThemeChange(onFileIconThemeChange));
		onFileIconThemeChange(themeService.getFileIconTheme());
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/views';
import * as errors from 'vs/base/common/errors';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { TPromise } from 'vs/base/common/winjs.base';
import * as DOM from 'vs/base/browser/dom';
import { LIGHT, FileThemeIcon, FolderThemeIcon } from 'vs/platform/theme/common/themeService';
import { ITree, IDataSource, IRenderer, ContextMenuEvent } from 'vs/base/parts/tree/browser/tree';
import { TreeItemCollapsibleState, ITreeItem, ITreeViewer, IViewsService, ITreeViewDataProvider, ViewsRegistry, IViewDescriptor, TreeViewItemHandleArg, ICustomViewDescriptor, IViewsViewlet, ViewLocation } from 'vs/workbench/common/views';
import { IWorkbenchThemeService } from 'vs/workbench/services/themes/common/workbenchThemeService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IProgressService2, ProgressLocation } from 'vs/platform/progress/common/progress';
import { ResourceLabel } from 'vs/workbench/browser/labels';
import { ActionBar, IActionItemProvider, ActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import URI from 'vs/base/common/uri';
import { basename } from 'vs/base/common/paths';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { WorkbenchTreeController } from 'vs/platform/list/browser/listService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IAction, ActionRunner } from 'vs/base/common/actions';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IMenuService, MenuId, MenuItemAction } from 'vs/platform/actions/common/actions';
import { fillInContextMenuActions, ContextAwareMenuItemActionItem } from 'vs/platform/actions/browser/menuItemActionItem';
import { FileKind } from 'vs/platform/files/common/files';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { FileIconThemableWorkbenchTree } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { isUndefinedOrNull } from 'vs/base/common/types';
import { Emitter, Event } from 'vs/base/common/event';
import { ViewDescriptorCollection } from './contributableViews';
import { Registry } from 'vs/platform/registry/common/platform';
import { ViewletRegistry, Extensions as ViewletExtensions } from 'vs/workbench/browser/viewlet';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';

export class ViewsService extends Disposable implements IViewsService {

	_serviceBrand: any;

	private viewers: Map<string, CustomTreeViewer> = new Map<string, CustomTreeViewer>();

	constructor(
		@IInstantiationService private instantiationService: IInstantiationService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IViewletService private viewletService: IViewletService,
		@IStorageService private storageService: IStorageService
	) {
		super();

		ViewLocation.all.forEach(viewLocation => this.onDidRegisterViewLocation(viewLocation));
		this._register(ViewLocation.onDidRegister(viewLocation => this.onDidRegisterViewLocation(viewLocation)));
		this._register(Registry.as<ViewletRegistry>(ViewletExtensions.Viewlets).onDidRegister(viewlet => this.viewletService.setViewletEnablement(viewlet.id, this.storageService.getBoolean(`viewservice.${viewlet.id}.enablement`, StorageScope.GLOBAL, viewlet.id !== ViewLocation.TEST.id))));

		this.createViewers(ViewsRegistry.getAllViews());
		this._register(ViewsRegistry.onViewsRegistered(viewDescriptors => this.createViewers(viewDescriptors)));
		this._register(ViewsRegistry.onViewsDeregistered(viewDescriptors => this.removeViewers(viewDescriptors)));
	}

	getTreeViewer(id: string): ITreeViewer {
		return this.viewers.get(id);
	}

	openView(id: string, focus: boolean): TPromise<void> {
		const viewDescriptor = ViewsRegistry.getView(id);
		if (viewDescriptor) {
			const viewletId = viewDescriptor.location === ViewLocation.SCM ? 'workbench.view.scm' : viewDescriptor.location.id;
			const viewletDescriptor = this.viewletService.getViewlet(viewletId);
			if (viewletDescriptor) {
				return this.viewletService.openViewlet(viewletDescriptor.id)
					.then((viewlet: IViewsViewlet) => {
						if (viewlet && viewlet.openView) {
							return viewlet.openView(id, focus);
						}
						return null;
					});
			}
		}
		return TPromise.as(null);
	}

	private onDidRegisterViewLocation(viewLocation: ViewLocation): void {
		const viewDescriptorCollection = this._register(this.instantiationService.createInstance(ViewDescriptorCollection, viewLocation));
		this._register(viewDescriptorCollection.onDidChange(() => this.updateViewletEnablement(viewLocation, viewDescriptorCollection)));
		this.lifecycleService.when(LifecyclePhase.Eventually).then(() => this.updateViewletEnablement(viewLocation, viewDescriptorCollection));
	}

	private updateViewletEnablement(viewLocation: ViewLocation, viewDescriptorCollection: ViewDescriptorCollection): void {
		const enabled = viewDescriptorCollection.viewDescriptors.length > 0;
		this.viewletService.setViewletEnablement(viewLocation.id, enabled);
		this.storageService.store(`viewservice.${viewLocation.id}.enablement`, enabled, StorageScope.GLOBAL);
	}

	private createViewers(viewDescriptors: IViewDescriptor[]): void {
		for (const viewDescriptor of viewDescriptors) {
			if ((<ICustomViewDescriptor>viewDescriptor).treeView) {
				this.viewers.set(viewDescriptor.id, this.instantiationService.createInstance(CustomTreeViewer, viewDescriptor.id, viewDescriptor.location));
			}
		}
	}

	private removeViewers(viewDescriptors: IViewDescriptor[]): void {
		for (const { id } of viewDescriptors) {
			const viewer = this.getTreeViewer(id);
			if (viewer) {
				viewer.dispose();
				this.viewers.delete(id);
			}
		}
	}
}

class Root implements ITreeItem {
	label = 'root';
	handle = '0';
	parentHandle = null;
	collapsibleState = TreeItemCollapsibleState.Expanded;
	children = void 0;
}

class CustomTreeViewer extends Disposable implements ITreeViewer {

	private isVisible: boolean = false;
	private activated: boolean = false;
	private _hasIconForParentNode = false;
	private _hasIconForLeafNode = false;

	private treeContainer: HTMLElement;
	private tree: FileIconThemableWorkbenchTree;
	private root: ITreeItem;
	private elementsToRefresh: ITreeItem[] = [];

	private _dataProvider: ITreeViewDataProvider;

	private _onDidExpandItem: Emitter<ITreeItem> = this._register(new Emitter<ITreeItem>());
	readonly onDidExpandItem: Event<ITreeItem> = this._onDidExpandItem.event;

	private _onDidCollapseItem: Emitter<ITreeItem> = this._register(new Emitter<ITreeItem>());
	readonly onDidCollapseItem: Event<ITreeItem> = this._onDidCollapseItem.event;

	private _onDidChangeSelection: Emitter<ITreeItem[]> = this._register(new Emitter<ITreeItem[]>());
	readonly onDidChangeSelection: Event<ITreeItem[]> = this._onDidChangeSelection.event;

	constructor(
		private id: string,
		private location: ViewLocation,
		@IExtensionService private extensionService: IExtensionService,
		@IWorkbenchThemeService private themeService: IWorkbenchThemeService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@ICommandService private commandService: ICommandService
	) {
		super();
		this.root = new Root();
		this._register(this.themeService.onDidFileIconThemeChange(() => this.doRefresh([this.root]) /** soft refresh **/));
		this._register(this.themeService.onThemeChange(() => this.doRefresh([this.root]) /** soft refresh **/));
	}

	get dataProvider(): ITreeViewDataProvider {
		return this._dataProvider;
	}

	set dataProvider(dataProvider: ITreeViewDataProvider) {
		if (dataProvider) {
			this._dataProvider = new class implements ITreeViewDataProvider {
				getChildren(node?: ITreeItem): TPromise<ITreeItem[]> {
					if (node && node.children) {
						return TPromise.as(node.children);
					}
					const promise = node instanceof Root ? dataProvider.getChildren() : dataProvider.getChildren(node);
					return promise.then(children => {
						node.children = children;
						return children;
					});
				}
			};
		} else {
			this._dataProvider = null;
		}
		this.refresh();
	}

	get hasIconForParentNode(): boolean {
		return this._hasIconForParentNode;
	}

	get hasIconForLeafNode(): boolean {
		return this._hasIconForLeafNode;
	}

	setVisibility(isVisible: boolean): void {
		if (this.isVisible === isVisible) {
			return;
		}

		this.isVisible = isVisible;
		if (this.isVisible) {
			this.activate();
		}

		if (this.tree) {
			if (this.isVisible) {
				DOM.show(this.tree.getHTMLElement());
			} else {
				DOM.hide(this.tree.getHTMLElement()); // make sure the tree goes out of the tabindex world by hiding it
			}

			if (this.isVisible) {
				this.tree.onVisible();
			} else {
				this.tree.onHidden();
			}

			if (this.isVisible && this.elementsToRefresh.length) {
				this.doRefresh(this.elementsToRefresh);
				this.elementsToRefresh = [];
			}
		}
	}

	focus(): void {
		if (this.tree) {
			// Make sure the current selected element is revealed
			const selectedElement = this.tree.getSelection()[0];
			if (selectedElement) {
				this.tree.reveal(selectedElement, 0.5).done(null, errors.onUnexpectedError);
			}

			// Pass Focus to Viewer
			this.tree.domFocus();
		}
	}

	show(container: HTMLElement): void {
		if (!this.tree) {
			this.createTree();
		}
		DOM.append(container, this.treeContainer);
	}

	private createTree() {
		this.treeContainer = DOM.$('.tree-explorer-viewlet-tree-view');
		const actionItemProvider = (action: IAction) => action instanceof MenuItemAction ? this.instantiationService.createInstance(ContextAwareMenuItemActionItem, action) : undefined;
		const menus = this.instantiationService.createInstance(Menus, this.id);
		const dataSource = this.instantiationService.createInstance(TreeDataSource, this, this.getProgressLocation());
		const renderer = this.instantiationService.createInstance(TreeRenderer, this.id, menus, actionItemProvider);
		const controller = this.instantiationService.createInstance(TreeController, this.id, menus);
		this.tree = this.instantiationService.createInstance(FileIconThemableWorkbenchTree, this.treeContainer, { dataSource, renderer, controller }, {});
		this.tree.contextKeyService.createKey<boolean>(this.id, true);
		this._register(this.tree);
		this._register(this.tree.onDidChangeSelection(e => this.onSelection(e)));
		this._register(this.tree.onDidExpandItem(e => this._onDidExpandItem.fire(e.item.getElement())));
		this._register(this.tree.onDidCollapseItem(e => this._onDidCollapseItem.fire(e.item.getElement())));
		this._register(this.tree.onDidChangeSelection(e => this._onDidChangeSelection.fire(e.selection)));
		this.tree.setInput(this.root);
	}

	private getProgressLocation(): ProgressLocation {
		switch (this.location.id) {
			case ViewLocation.Explorer.id:
				return ProgressLocation.Explorer;
			case ViewLocation.SCM.id:
				return ProgressLocation.Scm;
			case ViewLocation.Debug.id:
				return null /* No debug progress location yet */;
		}
		return null;
	}

	layout(size: number) {
		if (this.tree) {
			this.treeContainer.style.height = size + 'px';
			this.tree.layout(size);
		}
	}

	getOptimalWidth(): number {
		if (this.tree) {
			const parentNode = this.tree.getHTMLElement();
			const childNodes = [].slice.call(parentNode.querySelectorAll('.outline-item-label > a'));
			return DOM.getLargestChildWidth(parentNode, childNodes);
		}
		return 0;
	}

	refresh(elements?: ITreeItem[]): TPromise<void> {
		if (this.tree) {
			elements = elements || [this.root];
			for (const element of elements) {
				element.children = null; // reset children
			}
			if (this.isVisible) {
				return this.doRefresh(elements);
			} else {
				this.elementsToRefresh.push(...elements);
			}
		}
		return TPromise.as(null);
	}

	reveal(item: ITreeItem, parentChain: ITreeItem[], options?: { select?: boolean }): TPromise<void> {
		if (this.tree && this.isVisible) {
			options = options ? options : { select: true };
			const root: Root = this.tree.getInput();
			const promise = root.children ? TPromise.as(null) : this.refresh(); // Refresh if root is not populated
			return promise.then(() => {
				const select = isUndefinedOrNull(options.select) ? true : options.select;
				var result = TPromise.as(null);
				parentChain.forEach((e) => {
					result = result.then(() => this.tree.expand(e));
				});
				return result.then(() => this.tree.reveal(item))
					.then(() => {
						if (select) {
							this.tree.setSelection([item], { source: 'api' });
						}
					});
			});
		}
		return TPromise.as(null);
	}

	private activate() {
		if (!this.activated) {
			this.extensionService.activateByEvent(`onView:${this.id}`);
			this.activated = true;
		}
	}

	private doRefresh(elements: ITreeItem[]): TPromise<void> {
		if (this.tree) {
			return TPromise.join(elements.map(e => this.tree.refresh(e))).then(() => null);
		}
		return TPromise.as(null);
	}

	private onSelection({ payload }: any): void {
		if (payload && payload.source === 'api') {
			return;
		}
		const selection: ITreeItem = this.tree.getSelection()[0];
		if (selection) {
			if (selection.command) {
				const originalEvent: KeyboardEvent | MouseEvent = payload && payload.originalEvent;
				const isMouseEvent = payload && payload.origin === 'mouse';
				const isDoubleClick = isMouseEvent && originalEvent && originalEvent.detail === 2;

				if (!isMouseEvent || this.tree.openOnSingleClick || isDoubleClick) {
					this.commandService.executeCommand(selection.command.id, ...(selection.command.arguments || []));
				}
			}
		}
	}
}

class TreeDataSource implements IDataSource {

	constructor(
		private treeView: ITreeViewer,
		private location: ProgressLocation,
		@IProgressService2 private progressService: IProgressService2
	) {
	}

	public getId(tree: ITree, node: ITreeItem): string {
		return node.handle;
	}

	public hasChildren(tree: ITree, node: ITreeItem): boolean {
		return this.treeView.dataProvider && node.collapsibleState !== TreeItemCollapsibleState.None;
	}

	public getChildren(tree: ITree, node: ITreeItem): TPromise<any[]> {
		if (this.treeView.dataProvider) {
			return this.location ? this.progressService.withProgress({ location: this.location }, () => this.treeView.dataProvider.getChildren(node)) : this.treeView.dataProvider.getChildren(node);
		}
		return TPromise.as([]);
	}

	public shouldAutoexpand(tree: ITree, node: ITreeItem): boolean {
		return node.collapsibleState === TreeItemCollapsibleState.Expanded;
	}

	public getParent(tree: ITree, node: any): TPromise<any> {
		return TPromise.as(null);
	}
}

interface ITreeExplorerTemplateData {
	label: HTMLElement;
	resourceLabel: ResourceLabel;
	icon: HTMLElement;
	actionBar: ActionBar;
	aligner: Aligner;
}

class TreeRenderer implements IRenderer {

	private static readonly ITEM_HEIGHT = 22;
	private static readonly TREE_TEMPLATE_ID = 'treeExplorer';

	constructor(
		private treeViewId: string,
		private menus: Menus,
		private actionItemProvider: IActionItemProvider,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWorkbenchThemeService private themeService: IWorkbenchThemeService
	) {
	}

	public getHeight(tree: ITree, element: any): number {
		return TreeRenderer.ITEM_HEIGHT;
	}

	public getTemplateId(tree: ITree, element: any): string {
		return TreeRenderer.TREE_TEMPLATE_ID;
	}

	public renderTemplate(tree: ITree, templateId: string, container: HTMLElement): ITreeExplorerTemplateData {
		DOM.addClass(container, 'custom-view-tree-node-item');

		const icon = DOM.append(container, DOM.$('.custom-view-tree-node-item-icon'));
		const label = DOM.append(container, DOM.$('.custom-view-tree-node-item-label'));
		const resourceLabel = this.instantiationService.createInstance(ResourceLabel, container, {});
		const actionsContainer = DOM.append(container, DOM.$('.actions'));
		const actionBar = new ActionBar(actionsContainer, {
			actionItemProvider: this.actionItemProvider,
			actionRunner: new MultipleSelectionActionRunner(() => tree.getSelection())
		});

		return { label, resourceLabel, icon, actionBar, aligner: new Aligner(container, tree, this.themeService) };
	}

	public renderElement(tree: ITree, node: ITreeItem, templateId: string, templateData: ITreeExplorerTemplateData): void {
		const resource = node.resourceUri ? URI.revive(node.resourceUri) : null;
		const label = node.label ? node.label : resource ? basename(resource.path) : '';
		const icon = this.themeService.getTheme().type === LIGHT ? node.icon : node.iconDark;

		// reset
		templateData.resourceLabel.clear();
		templateData.actionBar.clear();
		templateData.label.textContent = '';
		DOM.removeClass(templateData.label, 'custom-view-tree-node-item-label');
		DOM.removeClass(templateData.resourceLabel.element, 'custom-view-tree-node-item-resourceLabel');

		if ((resource || node.themeIcon) && !icon) {
			const title = node.tooltip ? node.tooltip : resource ? void 0 : label;
			templateData.resourceLabel.setLabel({ name: label, resource: resource ? resource : URI.parse('_icon_resource') }, { fileKind: this.getFileKind(node), title });
			DOM.addClass(templateData.resourceLabel.element, 'custom-view-tree-node-item-resourceLabel');
		} else {
			templateData.label.textContent = label;
			DOM.addClass(templateData.label, 'custom-view-tree-node-item-label');
			templateData.label.title = typeof node.tooltip === 'string' ? node.tooltip : label;
		}

		templateData.icon.style.backgroundImage = icon ? `url('${icon}')` : '';
		DOM.toggleClass(templateData.icon, 'custom-view-tree-node-item-icon', !!icon);
		templateData.actionBar.context = (<TreeViewItemHandleArg>{ $treeViewId: this.treeViewId, $treeItemHandle: node.handle });
		templateData.actionBar.push(this.menus.getResourceActions(node), { icon: true, label: false });

		templateData.aligner.treeItem = node;
	}

	private getFileKind(node: ITreeItem): FileKind {
		if (node.themeIcon) {
			switch (node.themeIcon.id) {
				case FileThemeIcon.id:
					return FileKind.FILE;
				case FolderThemeIcon.id:
					return FileKind.FOLDER;
			}
		}
		return node.collapsibleState === TreeItemCollapsibleState.Collapsed || node.collapsibleState === TreeItemCollapsibleState.Expanded ? FileKind.FOLDER : FileKind.FILE;
	}

	public disposeTemplate(tree: ITree, templateId: string, templateData: ITreeExplorerTemplateData): void {
		templateData.resourceLabel.dispose();
		templateData.actionBar.dispose();
		templateData.aligner.dispose();
	}
}

class Aligner extends Disposable {

	private _treeItem: ITreeItem;

	constructor(
		private container: HTMLElement,
		private tree: ITree,
		private themeService: IWorkbenchThemeService
	) {
		super();
		this._register(this.themeService.onDidFileIconThemeChange(() => this.render()));
	}

	set treeItem(treeItem: ITreeItem) {
		this._treeItem = treeItem;
		this.render();
	}

	private render(): void {
		if (this._treeItem) {
			DOM.toggleClass(this.container, 'align-icon-with-twisty', this.hasToAlignIconWithTwisty());
		}
	}

	private hasToAlignIconWithTwisty(): boolean {
		if (this._treeItem.collapsibleState !== TreeItemCollapsibleState.None) {
			return false;
		}
		if (!this.hasIcon(this._treeItem)) {
			return false;

		}
		const parent: ITreeItem = this.tree.getNavigator(this._treeItem).parent() || this.tree.getInput();
		if (this.hasIcon(parent)) {
			return false;
		}
		return parent.children && parent.children.every(c => c.collapsibleState === TreeItemCollapsibleState.None || !this.hasIcon(c));
	}

	private hasIcon(node: ITreeItem): boolean {
		const icon = this.themeService.getTheme().type === LIGHT ? node.icon : node.iconDark;
		if (icon) {
			return true;
		}
		if (node.resourceUri || node.themeIcon) {
			const fileIconTheme = this.themeService.getFileIconTheme();
			const isFolder = node.themeIcon ? node.themeIcon.id === FolderThemeIcon.id : node.collapsibleState !== TreeItemCollapsibleState.None;
			if (isFolder) {
				return fileIconTheme.hasFileIcons && fileIconTheme.hasFolderIcons;
			}
			return fileIconTheme.hasFileIcons;
		}
		return false;
	}
}

class TreeController extends WorkbenchTreeController {

	constructor(
		private treeViewId: string,
		private menus: Menus,
		@IContextMenuService private contextMenuService: IContextMenuService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super({}, configurationService);
	}

	public onContextMenu(tree: ITree, node: ITreeItem, event: ContextMenuEvent): boolean {
		event.preventDefault();
		event.stopPropagation();

		tree.setFocus(node);
		const actions = this.menus.getResourceContextActions(node);
		if (!actions.length) {
			return true;
		}
		const anchor = { x: event.posx, y: event.posy };
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,

			getActions: () => {
				return TPromise.as(actions);
			},

			getActionItem: (action) => {
				const keybinding = this._keybindingService.lookupKeybinding(action.id);
				if (keybinding) {
					return new ActionItem(action, action, { label: true, keybinding: keybinding.getLabel() });
				}
				return null;
			},

			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					tree.domFocus();
				}
			},

			getActionsContext: () => (<TreeViewItemHandleArg>{ $treeViewId: this.treeViewId, $treeItemHandle: node.handle }),

			actionRunner: new MultipleSelectionActionRunner(() => tree.getSelection())
		});

		return true;
	}
}

class MultipleSelectionActionRunner extends ActionRunner {

	constructor(private getSelectedResources: () => any[]) {
		super();
	}

	runAction(action: IAction, context: any): TPromise<any> {
		if (action instanceof MenuItemAction) {
			const selection = this.getSelectedResources();
			const filteredSelection = selection.filter(s => s !== context);

			if (selection.length === filteredSelection.length || selection.length === 1) {
				return action.run(context);
			}

			return action.run(context, ...filteredSelection);
		}

		return super.runAction(action, context);
	}
}

class Menus extends Disposable implements IDisposable {

	constructor(
		private id: string,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IMenuService private menuService: IMenuService,
		@IContextMenuService private contextMenuService: IContextMenuService
	) {
		super();
	}

	getResourceActions(element: ITreeItem): IAction[] {
		return this.getActions(MenuId.ViewItemContext, { key: 'viewItem', value: element.contextValue }).primary;
	}

	getResourceContextActions(element: ITreeItem): IAction[] {
		return this.getActions(MenuId.ViewItemContext, { key: 'viewItem', value: element.contextValue }).secondary;
	}

	private getActions(menuId: MenuId, context: { key: string, value: string }): { primary: IAction[]; secondary: IAction[]; } {
		const contextKeyService = this.contextKeyService.createScoped();
		contextKeyService.createKey('view', this.id);
		contextKeyService.createKey(context.key, context.value);

		const menu = this.menuService.createMenu(menuId, contextKeyService);
		const primary: IAction[] = [];
		const secondary: IAction[] = [];
		const result = { primary, secondary };
		fillInContextMenuActions(menu, { shouldForwardArgs: true }, result, this.contextMenuService, g => /^inline/.test(g));

		menu.dispose();
		contextKeyService.dispose();

		return result;
	}
}

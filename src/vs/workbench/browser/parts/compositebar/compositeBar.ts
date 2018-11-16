/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import { Action, IAction } from 'vs/base/common/actions';
import { illegalArgument } from 'vs/base/common/errors';
import * as arrays from 'vs/base/common/arrays';
import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IBadge } from 'vs/workbench/services/activity/common/activity';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ActionBar, ActionsOrientation, Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { CompositeActionItem, CompositeOverflowActivityAction, ICompositeActivity, CompositeOverflowActivityActionItem, ActivityAction, ICompositeBar, ICompositeBarColors } from 'vs/workbench/browser/parts/compositebar/compositeBarActions';
import { TPromise } from 'vs/base/common/winjs.base';
import { Dimension, $, addDisposableListener, EventType, EventHelper } from 'vs/base/browser/dom';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Widget } from 'vs/base/browser/ui/widget';

export interface ICompositeBarOptions {
	icon: boolean;
	storageId: string;
	orientation: ActionsOrientation;
	colors: ICompositeBarColors;
	compositeSize: number;
	overflowActionSize: number;
	getActivityAction: (compositeId: string) => ActivityAction;
	getCompositePinnedAction: (compositeId: string) => Action;
	getOnCompositeClickAction: (compositeId: string) => Action;
	getContextMenuActions: () => Action[];
	openComposite: (compositeId: string) => TPromise<any>;
	getDefaultCompositeId: () => string;
	hidePart: () => TPromise<any>;
}

export class CompositeBar extends Widget implements ICompositeBar {

	private dimension: Dimension;

	private compositeSwitcherBar: ActionBar;
	private compositeOverflowAction: CompositeOverflowActivityAction;
	private compositeOverflowActionItem: CompositeOverflowActivityActionItem;

	private model: CompositeBarModel;
	private storedState: ISerializedCompositeBarItem[];
	private visibleComposites: string[];
	private compositeSizeInBar: Map<string, number>;

	constructor(
		private options: ICompositeBarOptions,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IStorageService private storageService: IStorageService,
		@IContextMenuService private contextMenuService: IContextMenuService
	) {
		super();
		this.model = new CompositeBarModel(options);
		this.storedState = this.loadCompositeItemsFromStorage();
		this.visibleComposites = [];
		this.compositeSizeInBar = new Map<string, number>();
	}

	public getCompositesFromStorage(): string[] {
		return this.storedState.map(s => s.id);
	}

	public create(parent: HTMLElement): HTMLElement {
		const actionBarDiv = parent.appendChild($('.composite-bar'));
		this.compositeSwitcherBar = this._register(new ActionBar(actionBarDiv, {
			actionItemProvider: (action: Action) => {
				if (action instanceof CompositeOverflowActivityAction) {
					return this.compositeOverflowActionItem;
				}
				const item = this.model.findItem(action.id);
				return item && this.instantiationService.createInstance(CompositeActionItem, action, item.pinnedAction, this.options.colors, this.options.icon, this);
			},
			orientation: this.options.orientation,
			ariaLabel: nls.localize('activityBarAriaLabel', "Active View Switcher"),
			animated: false,
		}));

		// Contextmenu for composites
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => this.showContextMenu(e)));

		// Allow to drop at the end to move composites to the end
		this._register(addDisposableListener(parent, EventType.DROP, (e: DragEvent) => {
			const draggedCompositeId = CompositeActionItem.getDraggedCompositeId();
			if (draggedCompositeId) {
				EventHelper.stop(e, true);
				CompositeActionItem.clearDraggedComposite();

				const targetItem = this.model.items[this.model.items.length - 1];
				if (targetItem && targetItem.id !== draggedCompositeId) {
					this.move(draggedCompositeId, targetItem.id);
				}
			}
		}));

		return actionBarDiv;
	}

	public layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (dimension.height === 0 || dimension.width === 0) {
			// Do not layout if not visible. Otherwise the size measurment would be computed wrongly
			return;
		}

		if (this.compositeSizeInBar.size === 0) {
			// Compute size of each composite by getting the size from the css renderer
			// Size is later used for overflow computation
			this.computeSizes(this.model.items);
		}

		this.updateCompositeSwitcher();
	}

	public addComposite({ id, name, order }: { id: string; name: string, order: number }): void {
		const state = this.storedState.filter(s => s.id === id)[0];
		const pinned = state ? state.pinned : true;
		let index = order >= 0 ? order : this.model.items.length;

		if (state) {
			// Find the index by looking its previous item
			index = 0;
			for (let i = this.storedState.indexOf(state) - 1; i >= 0; i--) {
				const previousItemId = this.storedState[i].id;
				const previousItemIndex = this.model.findIndex(previousItemId);
				if (previousItemIndex !== -1) {
					index = previousItemIndex + 1;
					break;
				}
			}
		}

		// Add to the model
		if (this.model.add(id, name, order, index)) {
			this.computeSizes([this.model.findItem(id)]);
			if (pinned) {
				this.pin(id);
			} else {
				this.updateCompositeSwitcher();
			}
		}
	}

	public removeComposite(id: string): void {

		// If it pinned, unpin it first
		if (this.isPinned(id)) {
			this.unpin(id);
		}

		// Remove from the model
		if (this.model.remove(id)) {
			this.updateCompositeSwitcher();
		}
	}

	public activateComposite(id: string): void {
		const previousActiveItem = this.model.activeItem;
		if (this.model.activate(id)) {
			// Update if current composite is neither visible nor pinned
			// or previous active composite is not pinned
			if (this.visibleComposites.indexOf(id) === - 1 || !this.model.activeItem.pinned || (previousActiveItem && !previousActiveItem.pinned)) {
				this.updateCompositeSwitcher();
			}
		}
	}

	public deactivateComposite(id: string): void {
		const previousActiveItem = this.model.activeItem;
		if (this.model.deactivate()) {
			if (previousActiveItem && !previousActiveItem.pinned) {
				this.updateCompositeSwitcher();
			}
		}
	}

	public showActivity(compositeId: string, badge: IBadge, clazz?: string, priority?: number): IDisposable {
		if (!badge) {
			throw illegalArgument('badge');
		}

		if (typeof priority !== 'number') {
			priority = 0;
		}

		const activity: ICompositeActivity = { badge, clazz, priority };
		this.model.addActivity(compositeId, activity);
		return toDisposable(() => this.model.removeActivity(compositeId, activity));
	}

	public pin(compositeId: string, open?: boolean): void {
		if (this.model.setPinned(compositeId, true)) {
			this.updateCompositeSwitcher();

			if (open) {
				this.options.openComposite(compositeId)
					.done(() => this.activateComposite(compositeId)); // Activate after opening
			}
		}
	}

	public unpin(compositeId: string): void {
		if (this.model.setPinned(compositeId, false)) {

			this.updateCompositeSwitcher();

			const defaultCompositeId = this.options.getDefaultCompositeId();

			// Case: composite is not the active one or the active one is a different one
			// Solv: we do nothing
			if (!this.model.activeItem || this.model.activeItem.id !== compositeId) {
				return;
			}

			// Deactivate itself
			this.deactivateComposite(compositeId);

			// Case: composite is not the default composite and default composite is still showing
			// Solv: we open the default composite
			if (defaultCompositeId !== compositeId && this.isPinned(defaultCompositeId)) {
				this.options.openComposite(defaultCompositeId);
			}

			// Case: we closed the last visible composite
			// Solv: we hide the part
			else if (this.visibleComposites.length === 1) {
				this.options.hidePart();
			}

			// Case: we closed the default composite
			// Solv: we open the next visible composite from top
			else {
				this.options.openComposite(this.visibleComposites.filter(cid => cid !== compositeId)[0]);
			}

		}

	}

	public isPinned(compositeId: string): boolean {
		const item = this.model.findItem(compositeId);
		return item && item.pinned;
	}

	public move(compositeId: string, toCompositeId: string): void {
		if (this.model.move(compositeId, toCompositeId)) {
			// timeout helps to prevent artifacts from showing up
			setTimeout(() => this.updateCompositeSwitcher(), 0);
		}
	}

	public getAction(compositeId): ActivityAction {
		const item = this.model.findItem(compositeId);
		return item && item.activityAction;
	}

	private computeSizes(items: ICompositeBarItem[]): void {
		const size = this.options.compositeSize;
		if (size) {
			items.forEach(composite => this.compositeSizeInBar.set(composite.id, size));
		} else {
			if (this.dimension && this.dimension.height !== 0 && this.dimension.width !== 0) {
				// Compute sizes only if visible. Otherwise the size measurment would be computed wrongly.
				const currentItemsLength = this.compositeSwitcherBar.items.length;
				this.compositeSwitcherBar.push(items.map(composite => composite.activityAction));
				items.map((composite, index) => this.compositeSizeInBar.set(composite.id, this.options.orientation === ActionsOrientation.VERTICAL
					? this.compositeSwitcherBar.getHeight(currentItemsLength + index)
					: this.compositeSwitcherBar.getWidth(currentItemsLength + index)
				));
				items.forEach(() => this.compositeSwitcherBar.pull(this.compositeSwitcherBar.items.length - 1));
			}
		}
	}

	private updateCompositeSwitcher(): void {
		if (!this.compositeSwitcherBar || !this.dimension) {
			return; // We have not been rendered yet so there is nothing to update.
		}

		let compositesToShow = this.model.items.filter(item =>
			item.pinned
			|| (this.model.activeItem && this.model.activeItem.id === item.id) /* Show the active composite even if it is not pinned */
		).map(item => item.id);

		// Ensure we are not showing more composites than we have height for
		let overflows = false;
		let maxVisible = compositesToShow.length;
		let size = 0;
		const limit = this.options.orientation === ActionsOrientation.VERTICAL ? this.dimension.height : this.dimension.width;
		for (let i = 0; i < compositesToShow.length && size <= limit; i++) {
			size += this.compositeSizeInBar.get(compositesToShow[i]);
			if (size > limit) {
				maxVisible = i;
			}
		}
		overflows = compositesToShow.length > maxVisible;

		if (overflows) {
			size -= this.compositeSizeInBar.get(compositesToShow[maxVisible]);
			compositesToShow = compositesToShow.slice(0, maxVisible);
			size += this.options.overflowActionSize;
		}
		// Check if we need to make extra room for the overflow action
		if (size > limit) {
			size -= this.compositeSizeInBar.get(compositesToShow.pop());
		}

		// We always try show the active composite
		if (this.model.activeItem && compositesToShow.every(compositeId => compositeId !== this.model.activeItem.id)) {
			const removedComposite = compositesToShow.pop();
			size = size - this.compositeSizeInBar.get(removedComposite) + this.compositeSizeInBar.get(this.model.activeItem.id);
			compositesToShow.push(this.model.activeItem.id);
		}

		// The active composite might have bigger size than the removed composite, check for overflow again
		if (size > limit) {
			compositesToShow.length ? compositesToShow.splice(compositesToShow.length - 2, 1) : compositesToShow.pop();
		}

		const visibleCompositesChange = !arrays.equals(compositesToShow, this.visibleComposites);

		// Pull out overflow action if there is a composite change so that we can add it to the end later
		if (this.compositeOverflowAction && visibleCompositesChange) {
			this.compositeSwitcherBar.pull(this.compositeSwitcherBar.length() - 1);

			this.compositeOverflowAction.dispose();
			this.compositeOverflowAction = null;

			this.compositeOverflowActionItem.dispose();
			this.compositeOverflowActionItem = null;
		}

		// Pull out composites that overflow or got hidden
		const compositesToRemove: number[] = [];
		this.visibleComposites.forEach((compositeId, index) => {
			if (compositesToShow.indexOf(compositeId) === -1) {
				compositesToRemove.push(index);
			}
		});
		compositesToRemove.reverse().forEach(index => {
			const actionItem = this.compositeSwitcherBar.items[index];
			this.compositeSwitcherBar.pull(index);
			actionItem.dispose();
			this.visibleComposites.splice(index, 1);
		});

		// Update the positions of the composites
		compositesToShow.forEach((compositeId, newIndex) => {
			const currentIndex = this.visibleComposites.indexOf(compositeId);
			if (newIndex !== currentIndex) {
				if (currentIndex !== -1) {
					const actionItem = this.compositeSwitcherBar.items[currentIndex];
					this.compositeSwitcherBar.pull(currentIndex);
					actionItem.dispose();
					this.visibleComposites.splice(currentIndex, 1);
				}

				this.compositeSwitcherBar.push(this.model.findItem(compositeId).activityAction, { label: true, icon: this.options.icon, index: newIndex });
				this.visibleComposites.splice(newIndex, 0, compositeId);
			}
		});

		// Add overflow action as needed
		if ((visibleCompositesChange && overflows) || this.compositeSwitcherBar.length() === 0) {
			this.compositeOverflowAction = this.instantiationService.createInstance(CompositeOverflowActivityAction, () => this.compositeOverflowActionItem.showMenu());
			this.compositeOverflowActionItem = this.instantiationService.createInstance(
				CompositeOverflowActivityActionItem,
				this.compositeOverflowAction,
				() => this.getOverflowingComposites(),
				() => this.model.activeItem ? this.model.activeItem.id : void 0,
				(compositeId: string) => {
					const item = this.model.findItem(compositeId);
					return item && item.activity[0] && item.activity[0].badge;
				},
				this.options.getOnCompositeClickAction,
				this.options.colors
			);

			this.compositeSwitcherBar.push(this.compositeOverflowAction, { label: false, icon: true });
		}

		// Persist
		this.saveCompositeItems();
	}

	private getOverflowingComposites(): { id: string, name: string }[] {
		let overflowingIds = this.model.items.filter(item => item.pinned).map(item => item.id);

		// Show the active composite even if it is not pinned
		if (this.model.activeItem && !this.model.activeItem.pinned) {
			overflowingIds.push(this.model.activeItem.id);
		}

		overflowingIds = overflowingIds.filter(compositeId => this.visibleComposites.indexOf(compositeId) === -1);
		return this.model.items.filter(c => overflowingIds.indexOf(c.id) !== -1);
	}

	private showContextMenu(e: MouseEvent): void {
		EventHelper.stop(e, true);
		const event = new StandardMouseEvent(e);
		const actions: IAction[] = this.model.items
			.map(({ id, name, activityAction }) => (<IAction>{
				id,
				label: name,
				checked: this.isPinned(id),
				enabled: activityAction.enabled,
				run: () => {
					if (this.isPinned(id)) {
						this.unpin(id);
					} else {
						this.pin(id, true);
					}
				}
			}));
		const otherActions = this.options.getContextMenuActions();
		if (otherActions.length) {
			actions.push(new Separator());
			actions.push(...otherActions);
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => { return { x: event.posx, y: event.posy }; },
			getActions: () => TPromise.as(actions),
		});
	}

	private loadCompositeItemsFromStorage(): ISerializedCompositeBarItem[] {
		const storedStates = <Array<string | ISerializedCompositeBarItem>>JSON.parse(this.storageService.get(this.options.storageId, StorageScope.GLOBAL, '[]'));
		const compositeStates = <ISerializedCompositeBarItem[]>storedStates.map(c =>
			typeof c === 'string' /* migration from pinned states to composites states */ ? { id: c, pinned: true } : c);
		return compositeStates;
	}

	private saveCompositeItems(): void {
		this.storedState = this.model.toJSON();
		this.storageService.store(this.options.storageId, JSON.stringify(this.storedState), StorageScope.GLOBAL);
	}
}

interface ISerializedCompositeBarItem {
	id: string;
	pinned: boolean;
	order: number;
}

interface ICompositeBarItem extends ISerializedCompositeBarItem {
	name: string;
	activityAction: ActivityAction;
	pinnedAction: Action;
	activity: ICompositeActivity[];
}

class CompositeBarModel {

	readonly items: ICompositeBarItem[] = [];
	activeItem: ICompositeBarItem;

	constructor(private options: ICompositeBarOptions) { }

	private createCompositeBarItem(id: string, name: string, order: number, pinned: boolean): ICompositeBarItem {
		const options = this.options;
		return {
			id, name, pinned, order, activity: [],
			get activityAction() {
				return options.getActivityAction(id);
			},
			get pinnedAction() {
				return options.getCompositePinnedAction(id);
			}
		};
	}

	add(id: string, name: string, order: number, index: number): boolean {
		const item = this.findItem(id);
		if (item) {
			item.order = order;
			item.name = name;
			return false;
		} else {
			if (index === void 0) {
				index = 0;
				while (index < this.items.length && this.items[index].order < order) {
					index++;
				}
			}
			this.items.splice(index, 0, this.createCompositeBarItem(id, name, order, false));
			return true;
		}
	}

	remove(id: string): boolean {
		for (let index = 0; index < this.items.length; index++) {
			if (this.items[index].id === id) {
				this.items.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	move(compositeId: string, toCompositeId: string): boolean {

		const fromIndex = this.findIndex(compositeId);
		const toIndex = this.findIndex(toCompositeId);

		// Make sure both items are known to the model
		if (fromIndex === -1 || toIndex === -1) {
			return false;
		}

		const sourceItem = this.items.splice(fromIndex, 1)[0];
		this.items.splice(toIndex, 0, sourceItem);

		// Make sure a moved composite gets pinned
		sourceItem.pinned = true;

		return true;
	}

	setPinned(id: string, pinned: boolean): boolean {
		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index];
			if (item.id === id) {
				if (item.pinned !== pinned) {
					item.pinned = pinned;
					return true;
				}
				return false;
			}
		}
		return false;
	}

	addActivity(id: string, activity: ICompositeActivity): boolean {
		const item = this.findItem(id);
		if (item) {
			const stack = item.activity;
			for (let i = 0; i <= stack.length; i++) {
				if (i === stack.length) {
					stack.push(activity);
					break;
				} else if (stack[i].priority <= activity.priority) {
					stack.splice(i, 0, activity);
					break;
				}
			}
			this.updateActivity(id);
			return true;
		}
		return false;
	}

	removeActivity(id: string, activity: ICompositeActivity): boolean {
		const item = this.findItem(id);
		if (item) {
			const index = item.activity.indexOf(activity);
			if (index !== -1) {
				item.activity.splice(index, 1);
				this.updateActivity(id);
				return true;
			}
		}
		return false;
	}

	updateActivity(id: string): void {
		const item = this.findItem(id);
		if (item) {
			if (item.activity.length) {
				const [{ badge, clazz }] = item.activity;
				item.activityAction.setBadge(badge, clazz);
			}
			else {
				item.activityAction.setBadge(undefined);
			}
		}
	}

	activate(id: string): boolean {
		if (!this.activeItem || this.activeItem.id !== id) {
			if (this.activeItem) {
				this.deactivate();
			}
			for (let index = 0; index < this.items.length; index++) {
				const item = this.items[index];
				if (item.id === id) {
					this.activeItem = item;
					this.activeItem.activityAction.activate();
					return true;
				}
			}
		}
		return false;
	}

	deactivate(): boolean {
		if (this.activeItem) {
			this.activeItem.activityAction.deactivate();
			this.activeItem = void 0;
			return true;
		}
		return false;
	}

	findItem(id: string): ICompositeBarItem {
		return this.items.filter(item => item.id === id)[0];
	}

	findIndex(id: string): number {
		for (let index = 0; index < this.items.length; index++) {
			if (this.items[index].id === id) {
				return index;
			}
		}
		return -1;
	}

	toJSON(): ISerializedCompositeBarItem[] {
		return this.items.map(({ id, pinned, order }) => ({ id, pinned, order }));
	}
}

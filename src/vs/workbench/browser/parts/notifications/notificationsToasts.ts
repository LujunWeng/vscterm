/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/notificationsToasts';
import { INotificationsModel, NotificationChangeType, INotificationChangeEvent, INotificationViewItem, NotificationViewItemLabelKind } from 'vs/workbench/common/notifications';
import { IDisposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { addClass, removeClass, isAncestor, addDisposableListener, EventType, Dimension } from 'vs/base/browser/dom';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { NotificationsList } from 'vs/workbench/browser/parts/notifications/notificationsList';
import { once } from 'vs/base/common/event';
import { IPartService, Parts } from 'vs/workbench/services/part/common/partService';
import { Themable, NOTIFICATIONS_TOAST_BORDER } from 'vs/workbench/common/theme';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { widgetShadow } from 'vs/platform/theme/common/colorRegistry';
import { IEditorGroupsService } from 'vs/workbench/services/group/common/editorGroupsService';
import { NotificationsToastsVisibleContext } from 'vs/workbench/browser/parts/notifications/notificationsCommands';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { localize } from 'vs/nls';
import { Severity } from 'vs/platform/notification/common/notification';
import { ScrollbarVisibility } from 'vs/base/common/scrollable';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';

interface INotificationToast {
	item: INotificationViewItem;
	list: NotificationsList;
	container: HTMLElement;
	toast: HTMLElement;
	disposeables: IDisposable[];
}

enum ToastVisibility {
	HIDDEN_OR_VISIBLE,
	HIDDEN,
	VISIBLE
}

export class NotificationsToasts extends Themable {

	private static MAX_WIDTH = 450;
	private static MAX_NOTIFICATIONS = 3;

	private static PURGE_TIMEOUT: { [severity: number]: number } = (() => {
		const intervals = Object.create(null);
		intervals[Severity.Info] = 10000;
		intervals[Severity.Warning] = 12000;
		intervals[Severity.Error] = 15000;

		return intervals;
	})();

	private notificationsToastsContainer: HTMLElement;
	private workbenchDimensions: Dimension;
	private isNotificationsCenterVisible: boolean;
	private mapNotificationToToast: Map<INotificationViewItem, INotificationToast>;
	private notificationsToastsVisibleContextKey: IContextKey<boolean>;

	constructor(
		private container: HTMLElement,
		private model: INotificationsModel,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IPartService private partService: IPartService,
		@IThemeService themeService: IThemeService,
		@IEditorGroupsService private editorGroupService: IEditorGroupsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILifecycleService private lifecycleService: ILifecycleService
	) {
		super(themeService);

		this.mapNotificationToToast = new Map<INotificationViewItem, INotificationToast>();
		this.notificationsToastsVisibleContextKey = NotificationsToastsVisibleContext.bindTo(contextKeyService);

		// Show toast for initial notifications if any
		model.notifications.forEach(notification => this.addToast(notification));

		this.registerListeners();
	}

	private registerListeners(): void {
		this.toUnbind.push(this.model.onDidNotificationChange(e => this.onDidNotificationChange(e)));
	}

	private onDidNotificationChange(e: INotificationChangeEvent): void {
		switch (e.kind) {
			case NotificationChangeType.ADD:
				return this.addToast(e.item);
			case NotificationChangeType.REMOVE:
				return this.removeToast(e.item);
		}
	}

	private addToast(item: INotificationViewItem): void {
		if (this.isNotificationsCenterVisible) {
			return; // do not show toasts while notification center is visibles
		}

		// Lazily create toasts containers
		if (!this.notificationsToastsContainer) {
			this.notificationsToastsContainer = document.createElement('div');
			addClass(this.notificationsToastsContainer, 'notifications-toasts');

			this.container.appendChild(this.notificationsToastsContainer);
		}

		// Make Visible
		addClass(this.notificationsToastsContainer, 'visible');

		const itemDisposeables: IDisposable[] = [];

		// Container
		const notificationToastContainer = document.createElement('div');
		addClass(notificationToastContainer, 'notification-toast-container');

		const firstToast = this.notificationsToastsContainer.firstChild;
		if (firstToast) {
			this.notificationsToastsContainer.insertBefore(notificationToastContainer, firstToast); // always first
		} else {
			this.notificationsToastsContainer.appendChild(notificationToastContainer);
		}

		// Toast
		const notificationToast = document.createElement('div');
		addClass(notificationToast, 'notification-toast');
		notificationToastContainer.appendChild(notificationToast);

		// Create toast with item and show
		const notificationList = this.instantiationService.createInstance(NotificationsList, notificationToast, {
			ariaLabel: localize('notificationsToast', "Notification Toast"),
			verticalScrollMode: ScrollbarVisibility.Hidden
		});
		itemDisposeables.push(notificationList);

		const toast: INotificationToast = { item, list: notificationList, container: notificationToastContainer, toast: notificationToast, disposeables: itemDisposeables };
		this.mapNotificationToToast.set(item, toast);

		itemDisposeables.push(toDisposable(() => {
			if (this.isVisible(toast)) {
				this.notificationsToastsContainer.removeChild(toast.container);
			}
		}));

		// Make visible
		notificationList.show();

		// Layout lists
		const maxDimensions = this.computeMaxDimensions();
		this.layoutLists(maxDimensions.width);

		// Show notification
		notificationList.updateNotificationsList(0, 0, [item]);

		// Layout container: only after we show the notification to ensure that
		// the height computation takes the content of it into account!
		this.layoutContainer(maxDimensions.height);

		// Update when item height changes due to expansion
		itemDisposeables.push(item.onDidExpansionChange(() => {
			notificationList.updateNotificationsList(0, 1, [item]);
		}));

		// Update when item height potentially changes due to label changes
		itemDisposeables.push(item.onDidLabelChange(e => {
			if (e.kind === NotificationViewItemLabelKind.ACTIONS || e.kind === NotificationViewItemLabelKind.MESSAGE) {
				notificationList.updateNotificationsList(0, 1, [item]);
			}
		}));

		// Remove when item gets closed
		once(item.onDidClose)(() => {
			this.removeToast(item);
		});

		// Automatically hide collapsed notifications
		if (!item.expanded) {

			// Track mouse over item
			let isMouseOverToast = false;
			itemDisposeables.push(addDisposableListener(notificationToastContainer, EventType.MOUSE_OVER, () => isMouseOverToast = true));
			itemDisposeables.push(addDisposableListener(notificationToastContainer, EventType.MOUSE_OUT, () => isMouseOverToast = false));

			// Install Timers
			let timeoutHandle: number;
			const hideAfterTimeout = () => {
				timeoutHandle = setTimeout(() => {
					const showsProgress = item.progress && !item.progress.state.done;
					if (!notificationList.hasFocus() && !item.expanded && !isMouseOverToast && !showsProgress) {
						this.removeToast(item);
					} else {
						hideAfterTimeout(); // push out disposal if item has focus or is expanded
					}
				}, NotificationsToasts.PURGE_TIMEOUT[item.severity]);
			};

			hideAfterTimeout();

			itemDisposeables.push(toDisposable(() => clearTimeout(timeoutHandle)));
		}

		// Theming
		this.updateStyles();

		// Context Key
		this.notificationsToastsVisibleContextKey.set(true);

		// Animate In if we are in a running session (otherwise just show directly)
		if (this.lifecycleService.phase >= LifecyclePhase.Running) {
			addClass(notificationToast, 'notification-fade-in');
			itemDisposeables.push(addDisposableListener(notificationToast, 'transitionend', () => {
				removeClass(notificationToast, 'notification-fade-in');
				addClass(notificationToast, 'notification-fade-in-done');
			}));
		} else {
			addClass(notificationToast, 'notification-fade-in-done');
		}
	}

	private removeToast(item: INotificationViewItem): void {
		const notificationToast = this.mapNotificationToToast.get(item);
		let focusGroup = false;
		if (notificationToast) {
			const toastHasDOMFocus = isAncestor(document.activeElement, notificationToast.container);
			if (toastHasDOMFocus) {
				focusGroup = !(this.focusNext() || this.focusPrevious()); // focus next if any, otherwise focus editor
			}

			// Listeners
			dispose(notificationToast.disposeables);

			// Remove from Map
			this.mapNotificationToToast.delete(item);
		}

		// Layout if we still have toasts
		if (this.mapNotificationToToast.size > 0) {
			this.layout(this.workbenchDimensions);
		}

		// Otherwise hide if no more toasts to show
		else {
			this.doHide();

			// Move focus back to editor group as needed
			if (focusGroup) {
				this.editorGroupService.activeGroup.focus();
			}
		}
	}

	private removeToasts(): void {
		this.mapNotificationToToast.forEach(toast => dispose(toast.disposeables));
		this.mapNotificationToToast.clear();

		this.doHide();
	}

	private doHide(): void {
		if (this.notificationsToastsContainer) {
			removeClass(this.notificationsToastsContainer, 'visible');
		}

		// Context Key
		this.notificationsToastsVisibleContextKey.set(false);
	}

	public hide(): void {
		const focusGroup = isAncestor(document.activeElement, this.notificationsToastsContainer);

		this.removeToasts();

		if (focusGroup) {
			this.editorGroupService.activeGroup.focus();
		}
	}

	public focus(): boolean {
		const toasts = this.getToasts(ToastVisibility.VISIBLE);
		if (toasts.length > 0) {
			toasts[0].list.focusFirst();

			return true;
		}

		return false;
	}

	public focusNext(): boolean {
		const toasts = this.getToasts(ToastVisibility.VISIBLE);
		for (let i = 0; i < toasts.length; i++) {
			const toast = toasts[i];
			if (toast.list.hasFocus()) {
				const nextToast = toasts[i + 1];
				if (nextToast) {
					nextToast.list.focusFirst();

					return true;
				}

				break;
			}
		}

		return false;
	}

	public focusPrevious(): boolean {
		const toasts = this.getToasts(ToastVisibility.VISIBLE);
		for (let i = 0; i < toasts.length; i++) {
			const toast = toasts[i];
			if (toast.list.hasFocus()) {
				const previousToast = toasts[i - 1];
				if (previousToast) {
					previousToast.list.focusFirst();

					return true;
				}

				break;
			}
		}

		return false;
	}

	public focusFirst(): boolean {
		const toast = this.getToasts(ToastVisibility.VISIBLE)[0];
		if (toast) {
			toast.list.focusFirst();

			return true;
		}

		return false;
	}

	public focusLast(): boolean {
		const toasts = this.getToasts(ToastVisibility.VISIBLE);
		if (toasts.length > 0) {
			toasts[toasts.length - 1].list.focusFirst();

			return true;
		}

		return false;
	}

	public update(isCenterVisible: boolean): void {
		if (this.isNotificationsCenterVisible !== isCenterVisible) {
			this.isNotificationsCenterVisible = isCenterVisible;

			// Hide all toasts when the notificationcenter gets visible
			if (this.isNotificationsCenterVisible) {
				this.removeToasts();
			}
		}
	}

	protected updateStyles(): void {
		this.mapNotificationToToast.forEach(t => {
			const widgetShadowColor = this.getColor(widgetShadow);
			t.toast.style.boxShadow = widgetShadowColor ? `0 0px 8px ${widgetShadowColor}` : null;

			const borderColor = this.getColor(NOTIFICATIONS_TOAST_BORDER);
			t.toast.style.border = borderColor ? `1px solid ${borderColor}` : null;
		});
	}

	private getToasts(state: ToastVisibility): INotificationToast[] {
		const notificationToasts: INotificationToast[] = [];

		this.mapNotificationToToast.forEach(toast => {
			switch (state) {
				case ToastVisibility.HIDDEN_OR_VISIBLE:
					notificationToasts.push(toast);
					break;
				case ToastVisibility.HIDDEN:
					if (!this.isVisible(toast)) {
						notificationToasts.push(toast);
					}
					break;
				case ToastVisibility.VISIBLE:
					if (this.isVisible(toast)) {
						notificationToasts.push(toast);
					}
					break;
			}
		});

		return notificationToasts.reverse(); // from newest to oldest
	}

	public layout(dimension: Dimension): void {
		this.workbenchDimensions = dimension;

		const maxDimensions = this.computeMaxDimensions();

		// Hide toasts that exceed height
		if (maxDimensions.height) {
			this.layoutContainer(maxDimensions.height);
		}

		// Layout all lists of toasts
		this.layoutLists(maxDimensions.width);
	}

	private computeMaxDimensions(): Dimension {
		let maxWidth = NotificationsToasts.MAX_WIDTH;

		let availableWidth = maxWidth;
		let availableHeight: number;

		if (this.workbenchDimensions) {

			// Make sure notifications are not exceding available width
			availableWidth = this.workbenchDimensions.width;
			availableWidth -= (2 * 8); // adjust for paddings left and right

			// Make sure notifications are not exceeding available height
			availableHeight = this.workbenchDimensions.height;
			if (this.partService.isVisible(Parts.STATUSBAR_PART)) {
				availableHeight -= 22; // adjust for status bar
			}

			if (this.partService.isVisible(Parts.TITLEBAR_PART)) {
				availableHeight -= 22; // adjust for title bar
			}

			availableHeight -= (2 * 12); // adjust for paddings top and bottom
		}

		availableHeight = Math.round(availableHeight * 0.618); // try to not cover the full height for stacked toasts

		return new Dimension(Math.min(maxWidth, availableWidth), availableHeight);
	}

	private layoutLists(width: number): void {
		this.mapNotificationToToast.forEach(toast => toast.list.layout(width));
	}

	private layoutContainer(heightToGive: number): void {
		let visibleToasts = 0;
		this.getToasts(ToastVisibility.HIDDEN_OR_VISIBLE).forEach(toast => {

			// In order to measure the client height, the element cannot have display: none
			toast.container.style.opacity = '0';
			this.setVisibility(toast, true);

			heightToGive -= toast.container.offsetHeight;

			let makeVisible = false;
			if (visibleToasts === NotificationsToasts.MAX_NOTIFICATIONS) {
				makeVisible = false; // never show more than MAX_NOTIFICATIONS
			} else if (heightToGive >= 0) {
				makeVisible = true; // hide toast if available height is too little
			}

			// Hide or show toast based on context
			this.setVisibility(toast, makeVisible);
			toast.container.style.opacity = null;

			if (makeVisible) {
				visibleToasts++;
			}
		});
	}

	private setVisibility(toast: INotificationToast, visible: boolean): void {
		if (this.isVisible(toast) === visible) {
			return;
		}

		if (visible) {
			this.notificationsToastsContainer.appendChild(toast.container);
		} else {
			this.notificationsToastsContainer.removeChild(toast.container);
		}
	}

	private isVisible(toast: INotificationToast): boolean {
		return !!toast.container.parentElement;
	}
}
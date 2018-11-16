/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/debugActionsWidget';
import * as errors from 'vs/base/common/errors';
import * as strings from 'vs/base/common/strings';
import * as browser from 'vs/base/browser/browser';
import { $, Builder } from 'vs/base/browser/builder';
import * as dom from 'vs/base/browser/dom';
import * as arrays from 'vs/base/common/arrays';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { IAction, IRunEvent } from 'vs/base/common/actions';
import { ActionBar, ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IDebugConfiguration, IDebugService, State } from 'vs/workbench/parts/debug/common/debug';
import { AbstractDebugAction, PauseAction, ContinueAction, StepBackAction, ReverseContinueAction, StopAction, DisconnectAction, StepOverAction, StepIntoAction, StepOutAction, RestartAction, FocusSessionAction } from 'vs/workbench/parts/debug/browser/debugActions';
import { FocusSessionActionItem } from 'vs/workbench/parts/debug/browser/debugActionItems';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { Themable } from 'vs/workbench/common/theme';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { registerColor, contrastBorder, widgetShadow } from 'vs/platform/theme/common/colorRegistry';
import { localize } from 'vs/nls';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { RunOnceScheduler } from 'vs/base/common/async';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable } from 'vs/base/common/lifecycle';

const DEBUG_ACTIONS_WIDGET_POSITION_KEY = 'debug.actionswidgetposition';

export const debugToolBarBackground = registerColor('debugToolBar.background', {
	dark: '#333333',
	light: '#F3F3F3',
	hc: '#000000'
}, localize('debugToolBarBackground', "Debug toolbar background color."));
export const debugToolBarBorder = registerColor('debugToolBar.border', {
	dark: null,
	light: null,
	hc: null
}, localize('debugToolBarBorder', "Debug toolbar border color."));

export class DebugActionsWidget extends Themable implements IWorkbenchContribution {

	private $el: Builder;
	private dragArea: Builder;
	private actionBar: ActionBar;
	private allActions: AbstractDebugAction[] = [];
	private activeActions: AbstractDebugAction[];
	private updateScheduler: RunOnceScheduler;

	private isVisible: boolean;
	private isBuilt: boolean;

	constructor(
		@INotificationService private notificationService: INotificationService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IDebugService private debugService: IDebugService,
		@IPartService private partService: IPartService,
		@IStorageService private storageService: IStorageService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IContextViewService contextViewService: IContextViewService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		super(themeService);

		this.$el = $().div().addClass('debug-actions-widget').style('top', `${partService.getTitleBarOffset()}px`);
		this.dragArea = $().div().addClass('drag-area');
		this.$el.append(this.dragArea);

		const actionBarContainter = $().div().addClass('.action-bar-container');
		this.$el.append(actionBarContainter);

		this.activeActions = [];
		this.actionBar = new ActionBar(actionBarContainter.getHTMLElement(), {
			orientation: ActionsOrientation.HORIZONTAL,
			actionItemProvider: (action: IAction) => {
				if (action.id === FocusSessionAction.ID) {
					return new FocusSessionActionItem(action, this.debugService, this.themeService, contextViewService);
				}

				return null;
			}
		});

		this.updateScheduler = new RunOnceScheduler(() => {
			const state = this.debugService.state;
			const toolBarLocation = this.configurationService.getValue<IDebugConfiguration>('debug').toolBarLocation;
			if (state === State.Inactive || this.configurationService.getValue<IDebugConfiguration>('debug').hideActionBar
				|| toolBarLocation === 'docked' || toolBarLocation === 'hidden') {
				return this.hide();
			}

			const actions = DebugActionsWidget.getActions(this.allActions, this.toUnbind, this.debugService, this.keybindingService, this.instantiationService);
			if (!arrays.equals(actions, this.activeActions, (first, second) => first.id === second.id)) {
				this.actionBar.clear();
				this.actionBar.push(actions, { icon: true, label: false });
				this.activeActions = actions;
			}
			this.show();
		}, 20);

		this.updateStyles();

		this.toUnbind.push(this.actionBar);
		this.registerListeners();

		this.hide();
		this.isBuilt = false;
	}

	private registerListeners(): void {
		this.toUnbind.push(this.debugService.onDidChangeState(() => this.updateScheduler.schedule()));
		this.toUnbind.push(this.debugService.getViewModel().onDidFocusSession(() => this.updateScheduler.schedule()));
		this.toUnbind.push(this.configurationService.onDidChangeConfiguration(e => this.onDidConfigurationChange(e)));
		this.toUnbind.push(this.actionBar.actionRunner.onDidRun((e: IRunEvent) => {
			// check for error
			if (e.error && !errors.isPromiseCanceledError(e.error)) {
				this.notificationService.error(e.error);
			}

			// log in telemetry
			if (this.telemetryService) {
				/* __GDPR__
					"workbenchActionExecuted" : {
						"id" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
						"from": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
					}
				*/
				this.telemetryService.publicLog('workbenchActionExecuted', { id: e.action.id, from: 'debugActionsWidget' });
			}
		}));
		$(window).on(dom.EventType.RESIZE, () => this.setXCoordinate(), this.toUnbind);

		this.dragArea.on(dom.EventType.MOUSE_UP, (event: MouseEvent) => {
			const mouseClickEvent = new StandardMouseEvent(event);
			if (mouseClickEvent.detail === 2) {
				// double click on debug bar centers it again #8250
				const widgetWidth = this.$el.getHTMLElement().clientWidth;
				this.setXCoordinate(0.5 * window.innerWidth - 0.5 * widgetWidth);
				this.storePosition();
			}
		});

		this.dragArea.on(dom.EventType.MOUSE_DOWN, (event: MouseEvent) => {
			const $window = $(window);
			this.dragArea.addClass('dragged');

			$window.on('mousemove', (e: MouseEvent) => {
				const mouseMoveEvent = new StandardMouseEvent(e);
				// Prevent default to stop editor selecting text #8524
				mouseMoveEvent.preventDefault();
				// Reduce x by width of drag handle to reduce jarring #16604
				this.setXCoordinate(mouseMoveEvent.posx - 14);
			}).once('mouseup', (e: MouseEvent) => {
				this.storePosition();
				this.dragArea.removeClass('dragged');
				$window.off('mousemove');
			});
		});

		this.toUnbind.push(this.partService.onTitleBarVisibilityChange(() => this.positionDebugWidget()));
		this.toUnbind.push(browser.onDidChangeZoomLevel(() => this.positionDebugWidget()));
	}

	private storePosition(): void {
		const position = parseFloat(this.$el.getComputedStyle().left) / window.innerWidth;
		this.storageService.store(DEBUG_ACTIONS_WIDGET_POSITION_KEY, position, StorageScope.WORKSPACE);
	}

	protected updateStyles(): void {
		super.updateStyles();

		if (this.$el) {
			this.$el.style('background-color', this.getColor(debugToolBarBackground));

			const widgetShadowColor = this.getColor(widgetShadow);
			this.$el.style('box-shadow', widgetShadowColor ? `0 5px 8px ${widgetShadowColor}` : null);

			const contrastBorderColor = this.getColor(contrastBorder);
			const borderColor = this.getColor(debugToolBarBorder);

			if (contrastBorderColor) {
				this.$el.style('border', `1px solid ${contrastBorderColor}`);
			} else {
				this.$el.style({
					'border': borderColor ? `solid ${borderColor}` : 'none',
					'border-width': '1px 0'
				});
			}
		}
	}

	private positionDebugWidget(): void {
		const titlebarOffset = this.partService.getTitleBarOffset();

		$(this.$el).style('top', `${titlebarOffset}px`);
	}

	private setXCoordinate(x?: number): void {
		if (!this.isVisible) {
			return;
		}
		const widgetWidth = this.$el.getHTMLElement().clientWidth;
		if (x === undefined) {
			const positionPercentage = this.storageService.get(DEBUG_ACTIONS_WIDGET_POSITION_KEY, StorageScope.WORKSPACE);
			x = positionPercentage !== undefined ? parseFloat(positionPercentage) * window.innerWidth : (0.5 * window.innerWidth - 0.5 * widgetWidth);
		}

		x = Math.max(0, Math.min(x, window.innerWidth - widgetWidth)); // do not allow the widget to overflow on the right
		this.$el.style('left', `${x}px`);
	}

	private onDidConfigurationChange(event: IConfigurationChangeEvent): void {
		if (event.affectsConfiguration('debug.hideActionBar') || event.affectsConfiguration('debug.toolBarLocation')) {
			this.updateScheduler.schedule();
		}
	}

	private show(): void {
		if (this.isVisible) {
			return;
		}
		if (!this.isBuilt) {
			this.isBuilt = true;
			this.$el.build(document.getElementById(this.partService.getWorkbenchElementId()));
		}

		this.isVisible = true;
		this.$el.show();
		this.setXCoordinate();
	}

	private hide(): void {
		this.isVisible = false;
		this.$el.hide();
	}

	public static getActions(allActions: AbstractDebugAction[], toUnbind: IDisposable[], debugService: IDebugService, keybindingService: IKeybindingService, instantiationService: IInstantiationService): AbstractDebugAction[] {
		if (allActions.length === 0) {
			allActions.push(new ContinueAction(ContinueAction.ID, ContinueAction.LABEL, debugService, keybindingService));
			allActions.push(new PauseAction(PauseAction.ID, PauseAction.LABEL, debugService, keybindingService));
			allActions.push(new StopAction(StopAction.ID, StopAction.LABEL, debugService, keybindingService));
			allActions.push(new DisconnectAction(DisconnectAction.ID, DisconnectAction.LABEL, debugService, keybindingService));
			allActions.push(new StepOverAction(StepOverAction.ID, StepOverAction.LABEL, debugService, keybindingService));
			allActions.push(new StepIntoAction(StepIntoAction.ID, StepIntoAction.LABEL, debugService, keybindingService));
			allActions.push(new StepOutAction(StepOutAction.ID, StepOutAction.LABEL, debugService, keybindingService));
			allActions.push(instantiationService.createInstance(RestartAction, RestartAction.ID, RestartAction.LABEL));
			allActions.push(new StepBackAction(StepBackAction.ID, StepBackAction.LABEL, debugService, keybindingService));
			allActions.push(new ReverseContinueAction(ReverseContinueAction.ID, ReverseContinueAction.LABEL, debugService, keybindingService));
			allActions.push(instantiationService.createInstance(FocusSessionAction, FocusSessionAction.ID, FocusSessionAction.LABEL));
			allActions.forEach(a => {
				toUnbind.push(a);
			});
		}

		const state = debugService.state;
		const session = debugService.getViewModel().focusedSession;
		const attached = session && session.configuration.request === 'attach' && session.configuration.type && !strings.equalsIgnoreCase(session.configuration.type, 'extensionHost');

		return allActions.filter(a => {
			if (a.id === ContinueAction.ID) {
				return state !== State.Running;
			}
			if (a.id === PauseAction.ID) {
				return state === State.Running;
			}
			if (a.id === StepBackAction.ID) {
				return session && session.raw.capabilities.supportsStepBack;
			}
			if (a.id === ReverseContinueAction.ID) {
				return session && session.raw.capabilities.supportsStepBack;
			}
			if (a.id === DisconnectAction.ID) {
				return attached;
			}
			if (a.id === StopAction.ID) {
				return !attached;
			}
			if (a.id === FocusSessionAction.ID) {
				return debugService.getViewModel().isMultiSessionView();
			}

			return true;
		}).sort((first, second) => first.weight - second.weight);
	}

	public dispose(): void {
		super.dispose();

		if (this.$el) {
			this.$el.destroy();
			delete this.$el;
		}
	}
}

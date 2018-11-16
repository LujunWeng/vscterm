/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import * as nls from 'vs/nls';
import * as platform from 'vs/base/common/platform';
import * as terminalEnvironment from 'vs/workbench/parts/terminal/node/terminalEnvironment';
import { Action, IAction } from 'vs/base/common/actions';
import { IActionItem, Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ITerminalService, TERMINAL_PANEL_ID } from 'vs/workbench/parts/terminal/common/terminal';
import { IThemeService, ITheme, registerThemingParticipant, ICssStyleCollector } from 'vs/platform/theme/common/themeService';
import { TerminalFindWidget } from 'vs/workbench/parts/terminal/browser/terminalFindWidget';
import { editorHoverBackground, editorHoverBorder, editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { KillTerminalAction, SwitchTerminalAction, SwitchTerminalActionItem, CopyTerminalSelectionAction, TerminalPasteAction, ClearTerminalAction, SelectAllTerminalAction, CreateNewTerminalAction, SplitTerminalAction } from 'vs/workbench/parts/terminal/electron-browser/terminalActions';
import { Panel } from 'vs/workbench/browser/panel';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { TPromise } from 'vs/base/common/winjs.base';
import URI from 'vs/base/common/uri';
import { PANEL_BACKGROUND, PANEL_BORDER } from 'vs/workbench/common/theme';
import { TERMINAL_BACKGROUND_COLOR, TERMINAL_BORDER_COLOR } from 'vs/workbench/parts/terminal/common/terminalColorRegistry';
import { DataTransfers } from 'vs/base/browser/dnd';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { INotificationService, IPromptChoice, Severity } from 'vs/platform/notification/common/notification';
import { TerminalConfigHelper } from 'vs/workbench/parts/terminal/electron-browser/terminalConfigHelper';

export class TerminalPanel extends Panel {

	private _actions: IAction[];
	private _copyContextMenuAction: IAction;
	private _contextMenuActions: IAction[];
	private _cancelContextMenu: boolean = false;
	private _fontStyleElement: HTMLElement;
	private _parentDomElement: HTMLElement;
	private _terminalContainer: HTMLElement;
	private _findWidget: TerminalFindWidget;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IThemeService protected themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super(TERMINAL_PANEL_ID, telemetryService, themeService);
	}

	public create(parent: HTMLElement): TPromise<any> {
		super.create(parent);
		this._parentDomElement = parent;
		dom.addClass(this._parentDomElement, 'integrated-terminal');
		this._fontStyleElement = document.createElement('style');

		this._terminalContainer = document.createElement('div');
		dom.addClass(this._terminalContainer, 'terminal-outer-container');

		this._findWidget = this._instantiationService.createInstance(TerminalFindWidget);

		this._parentDomElement.appendChild(this._fontStyleElement);
		this._parentDomElement.appendChild(this._terminalContainer);
		this._parentDomElement.appendChild(this._findWidget.getDomNode());

		this._attachEventListeners();

		this._terminalService.setContainers(this.getContainer(), this._terminalContainer);

		this._register(this.themeService.onThemeChange(theme => this._updateTheme(theme)));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fontFamily')) {
				this._updateFont();
			}

			if (e.affectsConfiguration('terminal.integrated.fontFamily') || e.affectsConfiguration('editor.fontFamily')) {
				let configHelper = this._terminalService.configHelper;
				if (configHelper instanceof TerminalConfigHelper) {
					if (!configHelper.configFontIsMonospace()) {
						const choices: IPromptChoice[] = [{
							label: nls.localize('terminal.useMonospace', "Use 'monospace'"),
							run: () => this._configurationService.updateValue('terminal.integrated.fontFamily', 'monospace'),
						}];
						this._notificationService.prompt(Severity.Warning, nls.localize('terminal.monospaceOnly', "The terminal only supports monospace fonts."), choices);
					}
				}
			}
		}));
		this._updateFont();
		this._updateTheme();

		// Force another layout (first is setContainers) since config has changed
		this.layout(new dom.Dimension(this._terminalContainer.offsetWidth, this._terminalContainer.offsetHeight));
		return TPromise.as(void 0);
	}

	public layout(dimension?: dom.Dimension): void {
		if (!dimension) {
			return;
		}
		this._terminalService.terminalTabs.forEach(t => t.layout(dimension.width, dimension.height));
	}

	public setVisible(visible: boolean): TPromise<void> {
		if (visible) {
			if (this._terminalService.terminalInstances.length > 0) {
				this._updateFont();
				this._updateTheme();
			} else {
				return super.setVisible(visible).then(() => {
					// Ensure the "Running" lifecycle face has been reached before creating the
					// first terminal.
					this._lifecycleService.when(LifecyclePhase.Running).then(() => {
						// Allow time for the panel to display if it is being shown
						// for the first time. If there is not wait here the initial
						// dimensions of the pty could be wrong.
						setTimeout(() => {
							// Check if instances were already restored as part of workbench restore
							if (this._terminalService.terminalInstances.length > 0) {
								this._updateFont();
								this._updateTheme();
								return;
							}

							const instance = this._terminalService.createTerminal();
							if (instance) {
								this._updateFont();
								this._updateTheme();
							}
						}, 0);
					});
					return TPromise.as(void 0);
				});
			}
		}
		return super.setVisible(visible);
	}

	public getActions(): IAction[] {
		if (!this._actions) {
			this._actions = [
				this._instantiationService.createInstance(SwitchTerminalAction, SwitchTerminalAction.ID, SwitchTerminalAction.LABEL),
				this._instantiationService.createInstance(CreateNewTerminalAction, CreateNewTerminalAction.ID, CreateNewTerminalAction.PANEL_LABEL),
				this._instantiationService.createInstance(SplitTerminalAction, SplitTerminalAction.ID, SplitTerminalAction.LABEL),
				this._instantiationService.createInstance(KillTerminalAction, KillTerminalAction.ID, KillTerminalAction.PANEL_LABEL)
			];
			this._actions.forEach(a => {
				this._register(a);
			});
		}
		return this._actions;
	}

	private _getContextMenuActions(): IAction[] {
		if (!this._contextMenuActions) {
			this._copyContextMenuAction = this._instantiationService.createInstance(CopyTerminalSelectionAction, CopyTerminalSelectionAction.ID, nls.localize('copy', "Copy"));
			this._contextMenuActions = [
				this._instantiationService.createInstance(CreateNewTerminalAction, CreateNewTerminalAction.ID, CreateNewTerminalAction.PANEL_LABEL),
				this._instantiationService.createInstance(SplitTerminalAction, SplitTerminalAction.ID, nls.localize('split', "Split")),
				new Separator(),
				this._copyContextMenuAction,
				this._instantiationService.createInstance(TerminalPasteAction, TerminalPasteAction.ID, nls.localize('paste', "Paste")),
				this._instantiationService.createInstance(SelectAllTerminalAction, SelectAllTerminalAction.ID, nls.localize('selectAll', "Select All")),
				new Separator(),
				this._instantiationService.createInstance(ClearTerminalAction, ClearTerminalAction.ID, nls.localize('clear', "Clear"))
			];
			this._contextMenuActions.forEach(a => {
				this._register(a);
			});
		}
		const activeInstance = this._terminalService.getActiveInstance();
		this._copyContextMenuAction.enabled = activeInstance && activeInstance.hasSelection();
		return this._contextMenuActions;
	}

	public getActionItem(action: Action): IActionItem {
		if (action.id === SwitchTerminalAction.ID) {
			return this._instantiationService.createInstance(SwitchTerminalActionItem, action);
		}

		return super.getActionItem(action);
	}

	public focus(): void {
		const activeInstance = this._terminalService.getActiveInstance();
		if (activeInstance) {
			activeInstance.focus(true);
		}
	}

	public focusFindWidget() {
		const activeInstance = this._terminalService.getActiveInstance();
		if (activeInstance && activeInstance.hasSelection() && activeInstance.selection.indexOf('\n') === -1) {
			this._findWidget.reveal(activeInstance.selection);
		} else {
			this._findWidget.reveal();
		}
	}

	public hideFindWidget() {
		this._findWidget.hide();
	}

	public showNextFindTermFindWidget(): void {
		this._findWidget.showNextFindTerm();
	}

	public showPreviousFindTermFindWidget(): void {
		this._findWidget.showPreviousFindTerm();
	}

	private _attachEventListeners(): void {
		this._register(dom.addDisposableListener(this._parentDomElement, 'mousedown', (event: MouseEvent) => {
			if (this._terminalService.terminalInstances.length === 0) {
				return;
			}

			if (event.which === 2 && platform.isLinux) {
				// Drop selection and focus terminal on Linux to enable middle button paste when click
				// occurs on the selection itself.
				this._terminalService.getActiveInstance().focus();
			} else if (event.which === 3) {
				if (this._terminalService.configHelper.config.rightClickBehavior === 'copyPaste') {
					let terminal = this._terminalService.getActiveInstance();
					if (terminal.hasSelection()) {
						terminal.copySelection();
						terminal.clearSelection();
					} else {
						terminal.paste();
					}
					// Clear selection after all click event bubbling is finished on Mac to prevent
					// right-click selecting a word which is seemed cannot be disabled. There is a
					// flicker when pasting but this appears to give the best experience if the
					// setting is enabled.
					if (platform.isMacintosh) {
						setTimeout(() => {
							terminal.clearSelection();
						}, 0);
					}
					this._cancelContextMenu = true;
				}
			}
		}));
		this._register(dom.addDisposableListener(this._parentDomElement, 'mouseup', (event: MouseEvent) => {
			if (this._configurationService.getValue('terminal.integrated.copyOnSelection')) {
				if (this._terminalService.terminalInstances.length === 0) {
					return;
				}

				if (event.which === 1) {
					let terminal = this._terminalService.getActiveInstance();
					if (terminal.hasSelection()) {
						terminal.copySelection();
					}
				}
			}
		}));
		this._register(dom.addDisposableListener(this._parentDomElement, 'contextmenu', (event: MouseEvent) => {
			if (!this._cancelContextMenu) {
				const standardEvent = new StandardMouseEvent(event);
				let anchor: { x: number, y: number } = { x: standardEvent.posx, y: standardEvent.posy };
				this._contextMenuService.showContextMenu({
					getAnchor: () => anchor,
					getActions: () => TPromise.as(this._getContextMenuActions()),
					getActionsContext: () => this._parentDomElement
				});
			}
			this._cancelContextMenu = false;
		}));
		this._register(dom.addDisposableListener(document, 'keydown', (event: KeyboardEvent) => {
			this._terminalContainer.classList.toggle('alt-active', !!event.altKey);
		}));
		this._register(dom.addDisposableListener(document, 'keyup', (event: KeyboardEvent) => {
			this._terminalContainer.classList.toggle('alt-active', !!event.altKey);
		}));
		this._register(dom.addDisposableListener(this._parentDomElement, 'keyup', (event: KeyboardEvent) => {
			if (event.keyCode === 27) {
				// Keep terminal open on escape
				event.stopPropagation();
			}
		}));
		this._register(dom.addDisposableListener(this._parentDomElement, dom.EventType.DROP, (e: DragEvent) => {
			if (e.target === this._parentDomElement || dom.isAncestor(e.target as HTMLElement, this._parentDomElement)) {
				if (!e.dataTransfer) {
					return;
				}

				// Check if files were dragged from the tree explorer
				let path: string;
				let resources = e.dataTransfer.getData(DataTransfers.RESOURCES);
				if (resources) {
					path = URI.parse(JSON.parse(resources)[0]).path;
				} else if (e.dataTransfer.files.length > 0) {
					// Check if the file was dragged from the filesystem
					path = URI.file(e.dataTransfer.files[0].path).fsPath;
				}

				if (!path) {
					return;
				}

				const terminal = this._terminalService.getActiveInstance();
				terminal.sendText(terminalEnvironment.preparePathForTerminal(path), false);
			}
		}));
	}

	private _updateTheme(theme?: ITheme): void {
		if (!theme) {
			theme = this.themeService.getTheme();
		}

		this._findWidget.updateTheme(theme);
	}

	private _updateFont(): void {
		if (this._terminalService.terminalInstances.length === 0) {
			return;
		}
		// TODO: Can we support ligatures?
		// dom.toggleClass(this._parentDomElement, 'enable-ligatures', this._terminalService.configHelper.config.fontLigatures);
		this.layout(new dom.Dimension(this._parentDomElement.offsetWidth, this._parentDomElement.offsetHeight));
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {
	const backgroundColor = theme.getColor(TERMINAL_BACKGROUND_COLOR) || theme.getColor(PANEL_BACKGROUND);
	collector.addRule(`.monaco-workbench .panel.integrated-terminal .terminal-outer-container { background-color: ${backgroundColor ? backgroundColor.toString() : ''}; }`);

	const borderColor = theme.getColor(TERMINAL_BORDER_COLOR) || theme.getColor(PANEL_BORDER);
	if (borderColor) {
		collector.addRule(`.monaco-workbench .panel.integrated-terminal .split-view-view:not(:first-child) { border-color: ${borderColor.toString()}; }`);
	}

	// Borrow the editor's hover background for now
	let hoverBackground = theme.getColor(editorHoverBackground);
	if (hoverBackground) {
		collector.addRule(`.monaco-workbench .panel.integrated-terminal .terminal-message-widget { background-color: ${hoverBackground}; }`);
	}
	let hoverBorder = theme.getColor(editorHoverBorder);
	if (hoverBorder) {
		collector.addRule(`.monaco-workbench .panel.integrated-terminal .terminal-message-widget { border: 1px solid ${hoverBorder}; }`);
	}
	let hoverForeground = theme.getColor(editorForeground);
	if (hoverForeground) {
		collector.addRule(`.monaco-workbench .panel.integrated-terminal .terminal-message-widget { color: ${hoverForeground}; }`);
	}
});
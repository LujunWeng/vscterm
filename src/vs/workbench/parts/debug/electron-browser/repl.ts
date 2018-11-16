/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!vs/workbench/parts/debug/browser/media/repl';
import * as nls from 'vs/nls';
import uri from 'vs/base/common/uri';
import { wireCancellationToken } from 'vs/base/common/async';
import { TPromise } from 'vs/base/common/winjs.base';
import * as errors from 'vs/base/common/errors';
import { IAction } from 'vs/base/common/actions';
import * as dom from 'vs/base/browser/dom';
import { isMacintosh } from 'vs/base/common/platform';
import { CancellationToken } from 'vs/base/common/cancellation';
import { KeyCode } from 'vs/base/common/keyCodes';
import { ITree, ITreeOptions } from 'vs/base/parts/tree/browser/tree';
import { Context as SuggestContext } from 'vs/editor/contrib/suggest/suggest';
import { SuggestController } from 'vs/editor/contrib/suggest/suggestController';
import { ITextModel } from 'vs/editor/common/model';
import { Position } from 'vs/editor/common/core/position';
import * as modes from 'vs/editor/common/modes';
import { registerEditorAction, ServicesAccessor, EditorAction, EditorCommand, registerEditorCommand } from 'vs/editor/browser/editorExtensions';
import { IModelService } from 'vs/editor/common/services/modelService';
import { MenuId } from 'vs/platform/actions/common/actions';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { IContextKeyService, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService, createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ReplExpressionsRenderer, ReplExpressionsController, ReplExpressionsDataSource, ReplExpressionsActionProvider, ReplExpressionsAccessibilityProvider } from 'vs/workbench/parts/debug/electron-browser/replViewer';
import { SimpleDebugEditor } from 'vs/workbench/parts/debug/electron-browser/simpleDebugEditor';
import { ClearReplAction } from 'vs/workbench/parts/debug/browser/debugActions';
import { ReplHistory } from 'vs/workbench/parts/debug/common/replHistory';
import { Panel } from 'vs/workbench/browser/panel';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { clipboard } from 'electron';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { WorkbenchTree } from 'vs/platform/list/browser/listService';
import { memoize } from 'vs/base/common/decorators';
import { dispose } from 'vs/base/common/lifecycle';
import { OpenMode, ClickBehavior } from 'vs/base/parts/tree/browser/treeDefaults';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { IDebugService, REPL_ID, DEBUG_SCHEME, CONTEXT_ON_FIRST_DEBUG_REPL_LINE, CONTEXT_IN_DEBUG_REPL, CONTEXT_ON_LAST_DEBUG_REPL_LINE } from 'vs/workbench/parts/debug/common/debug';

const $ = dom.$;

const replTreeOptions: ITreeOptions = {
	twistiePixels: 20,
	ariaLabel: nls.localize('replAriaLabel', "Read Eval Print Loop Panel")
};

const HISTORY_STORAGE_KEY = 'debug.repl.history';
const IPrivateReplService = createDecorator<IPrivateReplService>('privateReplService');

export interface IPrivateReplService {
	_serviceBrand: any;
	navigateHistory(previous: boolean): void;
	acceptReplInput(): void;
	getVisibleContent(): string;
}

export class Repl extends Panel implements IPrivateReplService {
	public _serviceBrand: any;

	private static readonly HALF_WIDTH_TYPICAL = 'n';

	private static HISTORY: ReplHistory;
	private static readonly REFRESH_DELAY = 500; // delay in ms to refresh the repl for new elements to show
	private static readonly REPL_INPUT_INITIAL_HEIGHT = 19;
	private static readonly REPL_INPUT_MAX_HEIGHT = 170;

	private tree: ITree;
	private renderer: ReplExpressionsRenderer;
	private container: HTMLElement;
	private treeContainer: HTMLElement;
	private replInput: CodeEditorWidget;
	private replInputContainer: HTMLElement;
	private refreshTimeoutHandle: number;
	private actions: IAction[];
	private dimension: dom.Dimension;
	private replInputHeight: number;
	private model: ITextModel;

	constructor(
		@IDebugService private debugService: IDebugService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IStorageService private storageService: IStorageService,
		@IPanelService private panelService: IPanelService,
		@IThemeService protected themeService: IThemeService,
		@IModelService private modelService: IModelService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(REPL_ID, telemetryService, themeService);

		this.replInputHeight = Repl.REPL_INPUT_INITIAL_HEIGHT;
		this.registerListeners();
	}

	private registerListeners(): void {
		this.toUnbind.push(this.debugService.getModel().onDidChangeReplElements(() => {
			this.refreshReplElements(this.debugService.getModel().getReplElements().length === 0);
		}));
		this.toUnbind.push(this.panelService.onDidPanelOpen(panel => this.refreshReplElements(true)));
	}

	private refreshReplElements(noDelay: boolean): void {
		if (this.tree && this.isVisible()) {
			if (this.refreshTimeoutHandle) {
				return; // refresh already triggered
			}

			const delay = noDelay ? 0 : Repl.REFRESH_DELAY;
			this.refreshTimeoutHandle = setTimeout(() => {
				this.refreshTimeoutHandle = null;
				const previousScrollPosition = this.tree.getScrollPosition();
				this.tree.refresh().then(() => {
					if (previousScrollPosition === 1) {
						// Only scroll if we were scrolled all the way down before tree refreshed #10486
						this.tree.setScrollPosition(1);
					}
				}, errors.onUnexpectedError);
			}, delay);
		}
	}

	public create(parent: HTMLElement): TPromise<void> {
		super.create(parent);
		this.container = dom.append(parent, $('.repl'));
		this.treeContainer = dom.append(this.container, $('.repl-tree'));
		this.createReplInput(this.container);

		this.renderer = this.instantiationService.createInstance(ReplExpressionsRenderer);
		const controller = this.instantiationService.createInstance(ReplExpressionsController, new ReplExpressionsActionProvider(this.instantiationService, this.replInput), MenuId.DebugConsoleContext, { openMode: OpenMode.SINGLE_CLICK, clickBehavior: ClickBehavior.ON_MOUSE_UP /* do not change, to preserve focus behaviour in input field */ });
		controller.toFocusOnClick = this.replInput;

		this.tree = this.instantiationService.createInstance(WorkbenchTree, this.treeContainer, {
			dataSource: new ReplExpressionsDataSource(),
			renderer: this.renderer,
			accessibilityProvider: new ReplExpressionsAccessibilityProvider(),
			controller
		}, replTreeOptions);

		if (!Repl.HISTORY) {
			Repl.HISTORY = new ReplHistory(JSON.parse(this.storageService.get(HISTORY_STORAGE_KEY, StorageScope.WORKSPACE, '[]')));
		}

		return this.tree.setInput(this.debugService.getModel());
	}

	public setVisible(visible: boolean): TPromise<void> {
		if (!visible) {
			dispose(this.model);
		} else {
			this.model = this.modelService.createModel('', null, uri.parse(`${DEBUG_SCHEME}:input`), true);
			this.replInput.setModel(this.model);
		}

		return super.setVisible(visible);
	}

	private createReplInput(container: HTMLElement): void {
		this.replInputContainer = dom.append(container, $('.repl-input-wrapper'));

		const scopedContextKeyService = this.contextKeyService.createScoped(this.replInputContainer);
		this.toUnbind.push(scopedContextKeyService);
		CONTEXT_IN_DEBUG_REPL.bindTo(scopedContextKeyService).set(true);
		const onFirstReplLine = CONTEXT_ON_FIRST_DEBUG_REPL_LINE.bindTo(scopedContextKeyService);
		onFirstReplLine.set(true);
		const onLastReplLine = CONTEXT_ON_LAST_DEBUG_REPL_LINE.bindTo(scopedContextKeyService);
		onLastReplLine.set(true);

		const scopedInstantiationService = this.instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedContextKeyService], [IPrivateReplService, this]));
		this.replInput = scopedInstantiationService.createInstance(CodeEditorWidget, this.replInputContainer, SimpleDebugEditor.getEditorOptions(), SimpleDebugEditor.getCodeEditorWidgetOptions());

		modes.SuggestRegistry.register({ scheme: DEBUG_SCHEME, hasAccessToAllModels: true }, {
			triggerCharacters: ['.'],
			provideCompletionItems: (model: ITextModel, position: Position, _context: modes.SuggestContext, token: CancellationToken): Thenable<modes.ISuggestResult> => {
				const word = this.replInput.getModel().getWordAtPosition(position);
				const overwriteBefore = word ? word.word.length : 0;
				const text = this.replInput.getModel().getLineContent(position.lineNumber);
				const focusedStackFrame = this.debugService.getViewModel().focusedStackFrame;
				const frameId = focusedStackFrame ? focusedStackFrame.frameId : undefined;
				const focusedSession = this.debugService.getViewModel().focusedSession;
				const completions = focusedSession ? focusedSession.completions(frameId, text, position, overwriteBefore) : TPromise.as([]);
				return wireCancellationToken(token, completions.then(suggestions => ({
					suggestions
				})));
			}
		});

		this.toUnbind.push(this.replInput.onDidScrollChange(e => {
			if (!e.scrollHeightChanged) {
				return;
			}
			this.replInputHeight = Math.max(Repl.REPL_INPUT_INITIAL_HEIGHT, Math.min(Repl.REPL_INPUT_MAX_HEIGHT, e.scrollHeight, this.dimension.height));
			this.layout(this.dimension);
		}));
		this.toUnbind.push(this.replInput.onDidChangeCursorPosition(e => {
			onFirstReplLine.set(e.position.lineNumber === 1);
			onLastReplLine.set(e.position.lineNumber === this.replInput.getModel().getLineCount());
		}));

		this.toUnbind.push(dom.addStandardDisposableListener(this.replInputContainer, dom.EventType.FOCUS, () => dom.addClass(this.replInputContainer, 'synthetic-focus')));
		this.toUnbind.push(dom.addStandardDisposableListener(this.replInputContainer, dom.EventType.BLUR, () => dom.removeClass(this.replInputContainer, 'synthetic-focus')));
	}

	public navigateHistory(previous: boolean): void {
		const historyInput = previous ? Repl.HISTORY.previous() : Repl.HISTORY.next();
		if (historyInput) {
			Repl.HISTORY.remember(this.replInput.getValue(), previous);
			this.replInput.setValue(historyInput);
			// always leave cursor at the end.
			this.replInput.setPosition({ lineNumber: 1, column: historyInput.length + 1 });
		}
	}

	public acceptReplInput(): void {
		this.debugService.addReplExpression(this.replInput.getValue());
		Repl.HISTORY.evaluated(this.replInput.getValue());
		this.replInput.setValue('');
		// Trigger a layout to shrink a potential multi line input
		this.replInputHeight = Repl.REPL_INPUT_INITIAL_HEIGHT;
		this.layout(this.dimension);
	}

	public getVisibleContent(): string {
		let text = '';
		const navigator = this.tree.getNavigator();
		// skip first navigator element - the root node
		while (navigator.next()) {
			if (text) {
				text += `\n`;
			}
			text += navigator.current().toString();
		}

		return text;
	}

	public layout(dimension: dom.Dimension): void {
		this.dimension = dimension;
		if (this.tree) {
			this.renderer.setWidth(dimension.width - 25, this.characterWidth);
			const treeHeight = dimension.height - this.replInputHeight;
			this.treeContainer.style.height = `${treeHeight}px`;
			this.tree.layout(treeHeight);
		}
		this.replInputContainer.style.height = `${this.replInputHeight}px`;

		this.replInput.layout({ width: dimension.width - 20, height: this.replInputHeight });
	}

	@memoize
	private get characterWidth(): number {
		const characterWidthSurveyor = dom.append(this.container, $('.surveyor'));
		characterWidthSurveyor.textContent = Repl.HALF_WIDTH_TYPICAL;
		for (let i = 0; i < 10; i++) {
			characterWidthSurveyor.textContent += characterWidthSurveyor.textContent;
		}
		characterWidthSurveyor.style.fontSize = isMacintosh ? '12px' : '14px';

		return characterWidthSurveyor.clientWidth / characterWidthSurveyor.textContent.length;
	}

	public focus(): void {
		this.replInput.focus();
	}

	public getActions(): IAction[] {
		if (!this.actions) {
			this.actions = [
				this.instantiationService.createInstance(ClearReplAction, ClearReplAction.ID, ClearReplAction.LABEL)
			];

			this.actions.forEach(a => {
				this.toUnbind.push(a);
			});
		}

		return this.actions;
	}

	public shutdown(): void {
		const replHistory = Repl.HISTORY.save();
		if (replHistory.length) {
			this.storageService.store(HISTORY_STORAGE_KEY, JSON.stringify(replHistory), StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(HISTORY_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	public dispose(): void {
		this.replInput.dispose();
		super.dispose();
	}
}

class ReplHistoryPreviousAction extends EditorAction {

	constructor() {
		super({
			id: 'repl.action.historyPrevious',
			label: nls.localize('actions.repl.historyPrevious', "History Previous"),
			alias: 'History Previous',
			precondition: CONTEXT_IN_DEBUG_REPL,
			kbOpts: {
				kbExpr: CONTEXT_ON_FIRST_DEBUG_REPL_LINE,
				primary: KeyCode.UpArrow,
				weight: 50
			},
			menuOpts: {
				group: 'debug'
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void | TPromise<void> {
		accessor.get(IPrivateReplService).navigateHistory(true);
	}
}

class ReplHistoryNextAction extends EditorAction {

	constructor() {
		super({
			id: 'repl.action.historyNext',
			label: nls.localize('actions.repl.historyNext', "History Next"),
			alias: 'History Next',
			precondition: CONTEXT_IN_DEBUG_REPL,
			kbOpts: {
				kbExpr: CONTEXT_ON_LAST_DEBUG_REPL_LINE,
				primary: KeyCode.DownArrow,
				weight: 50
			},
			menuOpts: {
				group: 'debug'
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void | TPromise<void> {
		accessor.get(IPrivateReplService).navigateHistory(false);
	}
}

class AcceptReplInputAction extends EditorAction {

	constructor() {
		super({
			id: 'repl.action.acceptInput',
			label: nls.localize({ key: 'actions.repl.acceptInput', comment: ['Apply input from the debug console input box'] }, "REPL Accept Input"),
			alias: 'REPL Accept Input',
			precondition: CONTEXT_IN_DEBUG_REPL,
			kbOpts: {
				kbExpr: EditorContextKeys.textInputFocus,
				primary: KeyCode.Enter
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void | TPromise<void> {
		SuggestController.get(editor).acceptSelectedSuggestion();
		accessor.get(IPrivateReplService).acceptReplInput();
	}
}

export class ReplCopyAllAction extends EditorAction {

	constructor() {
		super({
			id: 'repl.action.copyAll',
			label: nls.localize('actions.repl.copyAll', "Debug: Console Copy All"),
			alias: 'Debug Console Copy All',
			precondition: CONTEXT_IN_DEBUG_REPL,
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void | TPromise<void> {
		clipboard.writeText(accessor.get(IPrivateReplService).getVisibleContent());
	}
}

registerEditorAction(ReplHistoryPreviousAction);
registerEditorAction(ReplHistoryNextAction);
registerEditorAction(AcceptReplInputAction);
registerEditorAction(ReplCopyAllAction);

const SuggestCommand = EditorCommand.bindToContribution<SuggestController>(SuggestController.get);
registerEditorCommand(new SuggestCommand({
	id: 'repl.action.acceptSuggestion',
	precondition: ContextKeyExpr.and(CONTEXT_IN_DEBUG_REPL, SuggestContext.Visible),
	handler: x => x.acceptSelectedSuggestion(),
	kbOpts: {
		weight: 50,
		kbExpr: EditorContextKeys.textInputFocus,
		primary: KeyCode.RightArrow
	}
}));

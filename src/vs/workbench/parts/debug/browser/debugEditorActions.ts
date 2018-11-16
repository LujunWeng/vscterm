/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { KeyMod, KeyChord, KeyCode } from 'vs/base/common/keyCodes';
import { Range } from 'vs/editor/common/core/range';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { ServicesAccessor, registerEditorAction, EditorAction, IActionOptions } from 'vs/editor/browser/editorExtensions';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { IDebugService, CONTEXT_IN_DEBUG_MODE, CONTEXT_NOT_IN_DEBUG_REPL, CONTEXT_DEBUG_STATE, State, REPL_ID, VIEWLET_ID, IDebugEditorContribution, EDITOR_CONTRIBUTION_ID, BreakpointWidgetContext, IBreakpoint } from 'vs/workbench/parts/debug/common/debug';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { openBreakpointSource } from 'vs/workbench/parts/debug/browser/breakpointsView';

class ToggleBreakpointAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.debug.action.toggleBreakpoint',
			label: nls.localize('toggleBreakpointAction', "Debug: Toggle Breakpoint"),
			alias: 'Debug: Toggle Breakpoint',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyCode.F9
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): TPromise<any> {
		const debugService = accessor.get(IDebugService);

		const position = editor.getPosition();
		const modelUri = editor.getModel().uri;
		const bps = debugService.getModel().getBreakpoints({ lineNumber: position.lineNumber, uri: modelUri });

		if (bps.length) {
			return TPromise.join(bps.map(bp => debugService.removeBreakpoints(bp.getId())));
		}
		if (debugService.getConfigurationManager().canSetBreakpointsIn(editor.getModel())) {
			return debugService.addBreakpoints(modelUri, [{ lineNumber: position.lineNumber }]);
		}

		return TPromise.as(null);
	}
}

class ConditionalBreakpointAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.debug.action.conditionalBreakpoint',
			label: nls.localize('conditionalBreakpointEditorAction', "Debug: Add Conditional Breakpoint..."),
			alias: 'Debug: Add Conditional Breakpoint...',
			precondition: null
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const debugService = accessor.get(IDebugService);

		const { lineNumber, column } = editor.getPosition();
		if (debugService.getConfigurationManager().canSetBreakpointsIn(editor.getModel())) {
			editor.getContribution<IDebugEditorContribution>(EDITOR_CONTRIBUTION_ID).showBreakpointWidget(lineNumber, column);
		}
	}
}

class LogPointAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.debug.action.toggleLogPoint',
			label: nls.localize('logPointEditorAction', "Debug: Add Logpoint..."),
			alias: 'Debug: Add Logpoint...',
			precondition: null
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const debugService = accessor.get(IDebugService);

		const { lineNumber, column } = editor.getPosition();
		if (debugService.getConfigurationManager().canSetBreakpointsIn(editor.getModel())) {
			editor.getContribution<IDebugEditorContribution>(EDITOR_CONTRIBUTION_ID).showBreakpointWidget(lineNumber, column, BreakpointWidgetContext.LOG_MESSAGE);
		}
	}
}

class RunToCursorAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.debug.action.runToCursor',
			label: nls.localize('runToCursor', "Run to Cursor"),
			alias: 'Debug: Run to Cursor',
			precondition: ContextKeyExpr.and(CONTEXT_IN_DEBUG_MODE, CONTEXT_NOT_IN_DEBUG_REPL, EditorContextKeys.writable, CONTEXT_DEBUG_STATE.isEqualTo('stopped')),
			menuOpts: {
				group: 'debug',
				order: 2
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): TPromise<void> {
		const debugService = accessor.get(IDebugService);
		if (debugService.state !== State.Stopped) {
			return TPromise.as(null);
		}

		let breakpointToRemove: IBreakpoint;
		const oneTimeListener = debugService.getViewModel().focusedSession.raw.onDidEvent(event => {
			if (event.event === 'stopped' || event.event === 'exit') {
				if (breakpointToRemove) {
					debugService.removeBreakpoints(breakpointToRemove.getId());
				}
				oneTimeListener.dispose();
			}
		});

		const position = editor.getPosition();
		const uri = editor.getModel().uri;
		const bpExists = !!(debugService.getModel().getBreakpoints({ column: position.column, lineNumber: position.lineNumber, uri }).length);
		return (bpExists ? TPromise.as(null) : debugService.addBreakpoints(uri, [{ lineNumber: position.lineNumber, column: position.column }])).then((breakpoints) => {
			if (breakpoints && breakpoints.length) {
				breakpointToRemove = breakpoints[0];
			}
			debugService.getViewModel().focusedThread.continue();
		});
	}
}

class SelectionToReplAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.debug.action.selectionToRepl',
			label: nls.localize('debugEvaluate', "Debug: Evaluate"),
			alias: 'Debug: Evaluate',
			precondition: ContextKeyExpr.and(EditorContextKeys.hasNonEmptySelection, CONTEXT_IN_DEBUG_MODE, CONTEXT_NOT_IN_DEBUG_REPL),
			menuOpts: {
				group: 'debug',
				order: 0
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): TPromise<void> {
		const debugService = accessor.get(IDebugService);
		const panelService = accessor.get(IPanelService);

		const text = editor.getModel().getValueInRange(editor.getSelection());
		return debugService.addReplExpression(text)
			.then(() => panelService.openPanel(REPL_ID, true))
			.then(_ => void 0);
	}
}

class SelectionToWatchExpressionsAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.debug.action.selectionToWatch',
			label: nls.localize('debugAddToWatch', "Debug: Add to Watch"),
			alias: 'Debug: Add to Watch',
			precondition: ContextKeyExpr.and(EditorContextKeys.hasNonEmptySelection, CONTEXT_IN_DEBUG_MODE, CONTEXT_NOT_IN_DEBUG_REPL),
			menuOpts: {
				group: 'debug',
				order: 1
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): TPromise<void> {
		const debugService = accessor.get(IDebugService);
		const viewletService = accessor.get(IViewletService);

		const text = editor.getModel().getValueInRange(editor.getSelection());
		return viewletService.openViewlet(VIEWLET_ID).then(() => debugService.addWatchExpression(text));
	}
}

class ShowDebugHoverAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.debug.action.showDebugHover',
			label: nls.localize('showDebugHover', "Debug: Show Hover"),
			alias: 'Debug: Show Hover',
			precondition: CONTEXT_IN_DEBUG_MODE,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | KeyCode.KEY_I)
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): TPromise<void> {
		const position = editor.getPosition();
		const word = editor.getModel().getWordAtPosition(position);
		if (!word) {
			return TPromise.as(null);
		}

		const range = new Range(position.lineNumber, position.column, position.lineNumber, word.endColumn);
		return editor.getContribution<IDebugEditorContribution>(EDITOR_CONTRIBUTION_ID).showHover(range, true);
	}
}

class GoToBreakpointAction extends EditorAction {
	constructor(private isNext: boolean, opts: IActionOptions) {
		super(opts);
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor, args: any): TPromise<any> {
		const debugService = accessor.get(IDebugService);
		const editorService = accessor.get(IEditorService);
		const currentUri = editor.getModel().uri;
		const currentLine = editor.getPosition().lineNumber;
		//Breakpoints returned from `getBreakpoints` are already sorted.
		const allEnabledBreakpoints = debugService.getModel().getBreakpoints({ enabledOnly: true });

		//Try to find breakpoint in current file
		let moveBreakpoint =
			this.isNext
				? allEnabledBreakpoints.filter(bp => bp.uri.toString() === currentUri.toString() && bp.lineNumber > currentLine).shift()
				: allEnabledBreakpoints.filter(bp => bp.uri.toString() === currentUri.toString() && bp.lineNumber < currentLine).pop();

		//Try to find breakpoints in following files
		if (!moveBreakpoint) {
			moveBreakpoint =
				this.isNext
					? allEnabledBreakpoints.filter(bp => bp.uri.toString() > currentUri.toString()).shift()
					: allEnabledBreakpoints.filter(bp => bp.uri.toString() < currentUri.toString()).pop();
		}

		//Move to first or last possible breakpoint
		if (!moveBreakpoint && allEnabledBreakpoints.length) {
			moveBreakpoint = this.isNext ? allEnabledBreakpoints[0] : allEnabledBreakpoints[allEnabledBreakpoints.length - 1];
		}

		if (moveBreakpoint) {
			return openBreakpointSource(moveBreakpoint, false, true, debugService, editorService);
		}

		return TPromise.as(null);
	}
}

class GoToNextBreakpointAction extends GoToBreakpointAction {
	constructor() {
		super(true, {
			id: 'editor.debug.action.goToNextBreakpoint',
			label: nls.localize('goToNextBreakpoint', "Debug: Go To Next Breakpoint"),
			alias: 'Debug: Go To Next Breakpoint',
			precondition: null
		});
	}
}

class GoToPreviousBreakpointAction extends GoToBreakpointAction {
	constructor() {
		super(false, {
			id: 'editor.debug.action.goToPreviousBreakpoint',
			label: nls.localize('goToPreviousBreakpoint', "Debug: Go To Previous Breakpoint"),
			alias: 'Debug: Go To Previous Breakpoint',
			precondition: null
		});
	}
}

registerEditorAction(ToggleBreakpointAction);
registerEditorAction(ConditionalBreakpointAction);
registerEditorAction(LogPointAction);
registerEditorAction(RunToCursorAction);
registerEditorAction(SelectionToReplAction);
registerEditorAction(SelectionToWatchExpressionsAction);
registerEditorAction(ShowDebugHoverAction);
registerEditorAction(GoToNextBreakpointAction);
registerEditorAction(GoToPreviousBreakpointAction);

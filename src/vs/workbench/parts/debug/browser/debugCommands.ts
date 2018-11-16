/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { TPromise } from 'vs/base/common/winjs.base';
import { List } from 'vs/base/browser/ui/list/listWidget';
import * as errors from 'vs/base/common/errors';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IListService } from 'vs/platform/list/browser/listService';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IDebugService, IEnablement, CONTEXT_BREAKPOINTS_FOCUSED, CONTEXT_WATCH_EXPRESSIONS_FOCUSED, CONTEXT_VARIABLES_FOCUSED, EDITOR_CONTRIBUTION_ID, IDebugEditorContribution, CONTEXT_IN_DEBUG_MODE, CONTEXT_NOT_IN_DEBUG_REPL, CONTEXT_EXPRESSION_SELECTED, CONTEXT_BREAKPOINT_SELECTED } from 'vs/workbench/parts/debug/common/debug';
import { Expression, Variable, Breakpoint, FunctionBreakpoint } from 'vs/workbench/parts/debug/common/debugModel';
import { IExtensionsViewlet, VIEWLET_ID as EXTENSIONS_VIEWLET_ID } from 'vs/workbench/parts/extensions/common/extensions';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { ICodeEditor, isCodeEditor } from 'vs/editor/browser/editorBrowser';
import { MenuRegistry, MenuId } from 'vs/platform/actions/common/actions';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { openBreakpointSource } from 'vs/workbench/parts/debug/browser/breakpointsView';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { InputFocusedContext } from 'vs/platform/workbench/common/contextkeys';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { ServicesAccessor } from 'vs/editor/browser/editorExtensions';

export function registerCommands(): void {

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.toggleBreakpoint',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(5),
		when: ContextKeyExpr.and(CONTEXT_BREAKPOINTS_FOCUSED, InputFocusedContext.toNegated()),
		primary: KeyCode.Space,
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const debugService = accessor.get(IDebugService);
			const list = listService.lastFocusedList;
			if (list instanceof List) {
				const focused = <IEnablement[]>list.getFocusedElements();
				if (focused && focused.length) {
					debugService.enableOrDisableBreakpoints(!focused[0].enabled, focused[0]).done(null, errors.onUnexpectedError);
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.enableOrDisableBreakpoint',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		primary: undefined,
		when: EditorContextKeys.editorTextFocus,
		handler: (accessor) => {
			const debugService = accessor.get(IDebugService);
			const editorService = accessor.get(IEditorService);
			const widget = editorService.activeTextEditorWidget;
			if (isCodeEditor(widget)) {
				const model = widget.getModel();
				if (model) {
					const position = widget.getPosition();
					const bps = debugService.getModel().getBreakpoints({ uri: model.uri, lineNumber: position.lineNumber });
					if (bps.length) {
						debugService.enableOrDisableBreakpoints(!bps[0].enabled, bps[0]).done(null, errors.onUnexpectedError);
					}
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.renameWatchExpression',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(5),
		when: CONTEXT_WATCH_EXPRESSIONS_FOCUSED,
		primary: KeyCode.F2,
		mac: { primary: KeyCode.Enter },
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const debugService = accessor.get(IDebugService);
			const focused = listService.lastFocusedList;

			// Tree only
			if (!(focused instanceof List)) {
				const element = focused.getFocus();
				if (element instanceof Expression) {
					debugService.getViewModel().setSelectedExpression(element);
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.setVariable',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(5),
		when: CONTEXT_VARIABLES_FOCUSED,
		primary: KeyCode.F2,
		mac: { primary: KeyCode.Enter },
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const debugService = accessor.get(IDebugService);
			const focused = listService.lastFocusedList;

			// Tree only
			if (!(focused instanceof List)) {
				const element = focused.getFocus();
				if (element instanceof Variable) {
					debugService.getViewModel().setSelectedExpression(element);
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.removeWatchExpression',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ContextKeyExpr.and(CONTEXT_WATCH_EXPRESSIONS_FOCUSED, CONTEXT_EXPRESSION_SELECTED.toNegated()),
		primary: KeyCode.Delete,
		mac: { primary: KeyMod.CtrlCmd | KeyCode.Backspace },
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const debugService = accessor.get(IDebugService);
			const focused = listService.lastFocusedList;

			// Tree only
			if (!(focused instanceof List)) {
				const element = focused.getFocus();
				if (element instanceof Expression) {
					debugService.removeWatchExpressions(element.getId());
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.removeBreakpoint',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: ContextKeyExpr.and(CONTEXT_BREAKPOINTS_FOCUSED, CONTEXT_BREAKPOINT_SELECTED.toNegated()),
		primary: KeyCode.Delete,
		mac: { primary: KeyMod.CtrlCmd | KeyCode.Backspace },
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const debugService = accessor.get(IDebugService);
			const list = listService.lastFocusedList;

			// Tree only
			if (list instanceof List) {
				const focused = list.getFocusedElements();
				const element = focused.length ? focused[0] : undefined;
				if (element instanceof Breakpoint) {
					debugService.removeBreakpoints(element.getId()).done(null, errors.onUnexpectedError);
				} else if (element instanceof FunctionBreakpoint) {
					debugService.removeFunctionBreakpoints(element.getId()).done(null, errors.onUnexpectedError);
				}
			}
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.installAdditionalDebuggers',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: undefined,
		primary: undefined,
		handler: (accessor) => {
			const viewletService = accessor.get(IViewletService);
			return viewletService.openViewlet(EXTENSIONS_VIEWLET_ID, true)
				.then(viewlet => viewlet as IExtensionsViewlet)
				.then(viewlet => {
					viewlet.search('tag:debuggers @sort:installs');
					viewlet.focus();
				});
		}
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.addConfiguration',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: undefined,
		primary: undefined,
		handler: (accessor, launchUri: string) => {
			const manager = accessor.get(IDebugService).getConfigurationManager();
			if (accessor.get(IWorkspaceContextService).getWorkbenchState() === WorkbenchState.EMPTY) {
				accessor.get(INotificationService).info(nls.localize('noFolderDebugConfig', "Please first open a folder in order to do advanced debug configuration."));
				return TPromise.as(null);
			}
			const launch = manager.getLaunches().filter(l => l.uri.toString() === launchUri).pop() || manager.selectedConfiguration.launch;

			return launch.openConfigFile(false).done(editor => {
				if (editor) {
					const codeEditor = <ICodeEditor>editor.getControl();
					if (codeEditor) {
						return codeEditor.getContribution<IDebugEditorContribution>(EDITOR_CONTRIBUTION_ID).addLaunchConfiguration();
					}
				}

				return undefined;
			});
		}
	});

	const INLINE_BREAKPOINT_COMMAND_ID = 'editor.debug.action.toggleInlineBreakpoint';
	const inlineBreakpointHandler = (accessor: ServicesAccessor) => {
		const debugService = accessor.get(IDebugService);
		const editorService = accessor.get(IEditorService);
		const widget = editorService.activeTextEditorWidget;
		if (isCodeEditor(widget)) {
			const position = widget.getPosition();
			const modelUri = widget.getModel().uri;
			const bp = debugService.getModel().getBreakpoints({ lineNumber: position.lineNumber, uri: modelUri })
				.filter(bp => (bp.column === position.column || !bp.column && position.column <= 1)).pop();

			if (bp) {
				return TPromise.as(null);
			}
			if (debugService.getConfigurationManager().canSetBreakpointsIn(widget.getModel())) {
				return debugService.addBreakpoints(modelUri, [{ lineNumber: position.lineNumber, column: position.column > 1 ? position.column : undefined }]);
			}
		}

		return TPromise.as(null);
	};
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		primary: KeyMod.Shift | KeyCode.F9,
		when: EditorContextKeys.editorTextFocus,
		id: INLINE_BREAKPOINT_COMMAND_ID,
		handler: inlineBreakpointHandler
	});
	CommandsRegistry.registerCommand({
		id: 'editor.debug.action.toggleColumnBreakpoint',
		handler: inlineBreakpointHandler
	});

	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: {
			id: INLINE_BREAKPOINT_COMMAND_ID,
			title: nls.localize('inlineBreakpoint', "Inline Breakpoint"),
			category: nls.localize('debug', "Debug")
		}
	});
	MenuRegistry.appendMenuItem(MenuId.EditorContext, {
		command: {
			id: INLINE_BREAKPOINT_COMMAND_ID,
			title: nls.localize('addInlineBreakpoint', "Add Inline Breakpoint")
		},
		when: ContextKeyExpr.and(CONTEXT_IN_DEBUG_MODE, CONTEXT_NOT_IN_DEBUG_REPL, EditorContextKeys.writable),
		group: 'debug',
		order: 1
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'debug.openBreakpointToSide',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: CONTEXT_BREAKPOINTS_FOCUSED,
		primary: KeyMod.CtrlCmd | KeyCode.Enter,
		secondary: [KeyMod.Alt | KeyCode.Enter],
		handler: (accessor) => {
			const listService = accessor.get(IListService);
			const list = listService.lastFocusedList;
			if (list instanceof List) {
				const focus = list.getFocusedElements();
				if (focus.length && focus[0] instanceof Breakpoint) {
					return openBreakpointSource(focus[0], true, false, accessor.get(IDebugService), accessor.get(IEditorService));
				}
			}

			return TPromise.as(undefined);
		}
	});
}

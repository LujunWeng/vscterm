/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';

import * as Proto from '../protocol';
import { ITypeScriptServiceClient } from '../typescriptService';
import * as typeConverters from '../utils/typeConverters';
import FormattingOptionsManager from './fileConfigurationManager';
import { CommandManager, Command } from '../utils/commandManager';

class ApplyRefactoringCommand implements Command {
	public static readonly ID = '_typescript.applyRefactoring';
	public readonly id = ApplyRefactoringCommand.ID;

	constructor(
		private readonly client: ITypeScriptServiceClient
	) { }

	public async execute(
		document: vscode.TextDocument,
		file: string,
		refactor: string,
		action: string,
		range: vscode.Range
	): Promise<boolean> {
		const args: Proto.GetEditsForRefactorRequestArgs = {
			...typeConverters.Range.toFileRangeRequestArgs(file, range),
			refactor,
			action
		};
		const response = await this.client.execute('getEditsForRefactor', args);
		if (!response || !response.body || !response.body.edits.length) {
			return false;
		}

		for (const edit of response.body.edits) {
			try {
				await vscode.workspace.openTextDocument(edit.fileName);
			} catch {
				try {
					if (!fs.existsSync(edit.fileName)) {
						fs.writeFileSync(edit.fileName, '');
					}
				} catch {
					// noop
				}
			}
		}

		const edit = typeConverters.WorkspaceEdit.fromFromFileCodeEdits(this.client, response.body.edits);
		if (!(await vscode.workspace.applyEdit(edit))) {
			return false;
		}

		const renameLocation = response.body.renameLocation;
		if (renameLocation) {
			if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath === document.uri.fsPath) {
				const pos = typeConverters.Position.fromLocation(renameLocation);
				vscode.window.activeTextEditor.selection = new vscode.Selection(pos, pos);
				await vscode.commands.executeCommand('editor.action.rename');
			}
		}
		return true;
	}
}

class SelectRefactorCommand implements Command {
	public static readonly ID = '_typescript.selectRefactoring';
	public readonly id = SelectRefactorCommand.ID;

	constructor(
		private readonly doRefactoring: ApplyRefactoringCommand
	) { }

	public async execute(
		document: vscode.TextDocument,
		file: string,
		info: Proto.ApplicableRefactorInfo,
		range: vscode.Range
	): Promise<boolean> {
		const selected = await vscode.window.showQuickPick(info.actions.map((action): vscode.QuickPickItem => ({
			label: action.name,
			description: action.description
		})));
		if (!selected) {
			return false;
		}
		return this.doRefactoring.execute(document, file, info.name, selected.label, range);
	}
}

export default class TypeScriptRefactorProvider implements vscode.CodeActionProvider {
	private static readonly extractFunctionKind = vscode.CodeActionKind.RefactorExtract.append('function');
	private static readonly extractConstantKind = vscode.CodeActionKind.RefactorExtract.append('constant');
	private static readonly moveKind = vscode.CodeActionKind.Refactor.append('move');

	constructor(
		private readonly client: ITypeScriptServiceClient,
		private readonly formattingOptionsManager: FormattingOptionsManager,
		commandManager: CommandManager
	) {
		const doRefactoringCommand = commandManager.register(new ApplyRefactoringCommand(this.client));
		commandManager.register(new SelectRefactorCommand(doRefactoringCommand));
	}

	public readonly metadata: vscode.CodeActionProviderMetadata = {
		providedCodeActionKinds: [vscode.CodeActionKind.Refactor]
	};

	public async provideCodeActions(
		document: vscode.TextDocument,
		rangeOrSelection: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		token: vscode.CancellationToken
	): Promise<vscode.CodeAction[]> {
		if (!this.client.apiVersion.has240Features()) {
			return [];
		}

		if (context.only && !vscode.CodeActionKind.Refactor.contains(context.only)) {
			return [];
		}

		if (!(rangeOrSelection instanceof vscode.Selection) || (rangeOrSelection.isEmpty && context.triggerKind !== vscode.CodeActionTrigger.Manual)) {
			return [];
		}

		const file = this.client.normalizePath(document.uri);
		if (!file) {
			return [];
		}

		await this.formattingOptionsManager.ensureConfigurationForDocument(document, undefined);

		const args: Proto.GetApplicableRefactorsRequestArgs = typeConverters.Range.toFileRangeRequestArgs(file, rangeOrSelection);
		try {
			const response = await this.client.execute('getApplicableRefactors', args, token);
			if (!response || !response.body) {
				return [];
			}

			const actions: vscode.CodeAction[] = [];
			for (const info of response.body) {
				if (info.inlineable === false) {
					const codeAction = new vscode.CodeAction(info.description, vscode.CodeActionKind.Refactor);
					codeAction.command = {
						title: info.description,
						command: SelectRefactorCommand.ID,
						arguments: [document, file, info, rangeOrSelection]
					};
					actions.push(codeAction);
				} else {
					for (const action of info.actions) {
						const codeAction = new vscode.CodeAction(action.description, TypeScriptRefactorProvider.getKind(action));
						codeAction.command = {
							title: action.description,
							command: ApplyRefactoringCommand.ID,
							arguments: [document, file, info.name, action.name, rangeOrSelection]
						};
						actions.push(codeAction);
					}
				}
			}
			return actions;
		} catch {
			return [];
		}
	}

	private static getKind(refactor: Proto.RefactorActionInfo) {
		if (refactor.name.startsWith('function_')) {
			return TypeScriptRefactorProvider.extractFunctionKind;
		} else if (refactor.name.startsWith('constant_')) {
			return TypeScriptRefactorProvider.extractConstantKind;
		} else if (refactor.name.startsWith('Move')) {
			return TypeScriptRefactorProvider.moveKind;
		}
		return vscode.CodeActionKind.Refactor;
	}
}
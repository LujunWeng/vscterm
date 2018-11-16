/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ImplementationProvider, TextDocument, Position, CancellationToken, Definition } from 'vscode';

import DefinitionProviderBase from './definitionProviderBase';

export default class TypeScriptImplementationProvider extends DefinitionProviderBase implements ImplementationProvider {
	public provideImplementation(document: TextDocument, position: Position, token: CancellationToken | boolean): Promise<Definition | undefined> {
		return this.getSymbolLocations('implementation', document, position, token);
	}
}
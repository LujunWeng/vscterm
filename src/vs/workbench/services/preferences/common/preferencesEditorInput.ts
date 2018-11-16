/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OS } from 'vs/base/common/platform';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import * as nls from 'vs/nls';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditorInput, SideBySideEditorInput, Verbosity } from 'vs/workbench/common/editor';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { IHashService } from 'vs/workbench/services/hash/common/hashService';
import { KeybindingsEditorModel } from 'vs/workbench/services/preferences/common/keybindingsEditorModel';
import { IPreferencesService } from './preferences';
import { DefaultSettingsEditorModel } from './preferencesModels';

export class PreferencesEditorInput extends SideBySideEditorInput {
	public static readonly ID: string = 'workbench.editorinputs.preferencesEditorInput';

	getTypeId(): string {
		return PreferencesEditorInput.ID;
	}

	public supportsSplitEditor(): boolean {
		return true;
	}

	public getTitle(verbosity: Verbosity): string {
		return this.master.getTitle(verbosity);
	}
}

export class DefaultPreferencesEditorInput extends ResourceEditorInput {
	public static readonly ID = 'workbench.editorinputs.defaultpreferences';
	constructor(defaultSettingsResource: URI,
		@ITextModelService textModelResolverService: ITextModelService,
		@IHashService hashService: IHashService
	) {
		super(nls.localize('settingsEditorName', "Default Settings"), '', defaultSettingsResource, textModelResolverService, hashService);
	}

	getTypeId(): string {
		return DefaultPreferencesEditorInput.ID;
	}

	matches(other: any): boolean {
		if (other instanceof DefaultPreferencesEditorInput) {
			return true;
		}
		if (!super.matches(other)) {
			return false;
		}
		return true;
	}
}

export class KeybindingsEditorInput extends EditorInput {

	public static readonly ID: string = 'workbench.input.keybindings';
	public readonly keybindingsModel: KeybindingsEditorModel;

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.keybindingsModel = instantiationService.createInstance(KeybindingsEditorModel, OS);
	}

	getTypeId(): string {
		return KeybindingsEditorInput.ID;
	}

	getName(): string {
		return nls.localize('keybindingsInputName', "Keyboard Shortcuts");
	}

	resolve(refresh?: boolean): TPromise<KeybindingsEditorModel> {
		return TPromise.as(this.keybindingsModel);
	}

	matches(otherInput: any): boolean {
		return otherInput instanceof KeybindingsEditorInput;
	}
}

export class SettingsEditor2Input extends EditorInput {

	public static readonly ID: string = 'workbench.input.settings2';

	constructor(
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super();
	}

	getTypeId(): string {
		return SettingsEditor2Input.ID;
	}

	getName(): string {
		return nls.localize('settingsEditor2InputName', "Settings (Preview)");
	}

	resolve(refresh?: boolean): TPromise<DefaultSettingsEditorModel> {
		return <TPromise<DefaultSettingsEditorModel>>this.preferencesService.createPreferencesEditorModel(URI.parse('vscode://defaultsettings/0/settings.json'));
	}

	matches(otherInput: any): boolean {
		return otherInput instanceof SettingsEditor2Input;
	}
}

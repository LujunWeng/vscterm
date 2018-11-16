/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MarkdownEngine } from './markdownEngine';
import { Slug, githubSlugifier } from './slugify';

export interface TocEntry {
	readonly slug: Slug;
	readonly text: string;
	readonly level: number;
	readonly line: number;
	readonly location: vscode.Location;
}

export class TableOfContentsProvider {
	private toc?: TocEntry[];

	public constructor(
		private engine: MarkdownEngine,
		private document: vscode.TextDocument
	) { }

	public async getToc(): Promise<TocEntry[]> {
		if (!this.toc) {
			try {
				this.toc = await this.buildToc(this.document);
			} catch (e) {
				this.toc = [];
			}
		}
		return this.toc;
	}

	public async lookup(fragment: string): Promise<TocEntry | undefined> {
		const toc = await this.getToc();
		const slug = githubSlugifier.fromHeading(fragment);
		return toc.find(entry => entry.slug.equals(slug));
	}

	private async buildToc(document: vscode.TextDocument): Promise<TocEntry[]> {
		const toc: TocEntry[] = [];
		const tokens = await this.engine.parse(document.uri, document.getText());

		for (const heading of tokens.filter(token => token.type === 'heading_open')) {
			const lineNumber = heading.map[0];
			const line = document.lineAt(lineNumber);
			toc.push({
				slug: githubSlugifier.fromHeading(line.text),
				text: TableOfContentsProvider.getHeaderText(line.text),
				level: TableOfContentsProvider.getHeaderLevel(heading.markup),
				line: lineNumber,
				location: new vscode.Location(document.uri, line.range)
			});
		}
		return toc;
	}

	private static getHeaderLevel(markup: string): number {
		if (markup === '=') {
			return 1;
		} else if (markup === '-') {
			return 2;
		} else { // '#', '##', ...
			return markup.length;
		}
	}

	private static getHeaderText(header: string): string {
		return header.replace(/^\s*#+\s*(.*?)\s*#*$/, (_, word) => word.trim());
	}
}

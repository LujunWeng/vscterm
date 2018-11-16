/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { SingleCursorState, CursorConfiguration, ICursorSimpleModel } from 'vs/editor/common/controller/cursorCommon';
import { Position } from 'vs/editor/common/core/position';
import { WordCharacterClassifier, WordCharacterClass, getMapForWordSeparators } from 'vs/editor/common/controller/wordCharacterClassifier';
import * as strings from 'vs/base/common/strings';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';

interface IFindWordResult {
	/**
	 * The index where the word starts.
	 */
	start: number;
	/**
	 * The index where the word ends.
	 */
	end: number;
	/**
	 * The word type.
	 */
	wordType: WordType;
	/**
	 * The reason the word ended.
	 */
	nextCharClass: WordCharacterClass;
}

const enum WordType {
	None = 0,
	Regular = 1,
	Separator = 2
}

export const enum WordNavigationType {
	WordStart = 0,
	WordEnd = 1
}

export class WordOperations {

	private static _createWord(lineContent: string, wordType: WordType, nextCharClass: WordCharacterClass, start: number, end: number): IFindWordResult {
		// console.log('WORD ==> ' + start + ' => ' + end + ':::: <<<' + lineContent.substring(start, end) + '>>>');
		return { start: start, end: end, wordType: wordType, nextCharClass: nextCharClass };
	}

	private static _findPreviousWordOnLine(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position): IFindWordResult {
		let lineContent = model.getLineContent(position.lineNumber);
		return this._doFindPreviousWordOnLine(lineContent, wordSeparators, position);
	}

	private static _doFindPreviousWordOnLine(lineContent: string, wordSeparators: WordCharacterClassifier, position: Position): IFindWordResult {
		let wordType = WordType.None;
		for (let chIndex = position.column - 2; chIndex >= 0; chIndex--) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === WordCharacterClass.Regular) {
				if (wordType === WordType.Separator) {
					return this._createWord(lineContent, wordType, chClass, chIndex + 1, this._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
				wordType = WordType.Regular;
			} else if (chClass === WordCharacterClass.WordSeparator) {
				if (wordType === WordType.Regular) {
					return this._createWord(lineContent, wordType, chClass, chIndex + 1, this._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
				wordType = WordType.Separator;
			} else if (chClass === WordCharacterClass.Whitespace) {
				if (wordType !== WordType.None) {
					return this._createWord(lineContent, wordType, chClass, chIndex + 1, this._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
			}
		}

		if (wordType !== WordType.None) {
			return this._createWord(lineContent, wordType, WordCharacterClass.Whitespace, 0, this._findEndOfWord(lineContent, wordSeparators, wordType, 0));
		}

		return null;
	}

	private static _findEndOfWord(lineContent: string, wordSeparators: WordCharacterClassifier, wordType: WordType, startIndex: number): number {
		let len = lineContent.length;
		for (let chIndex = startIndex; chIndex < len; chIndex++) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === WordCharacterClass.Whitespace) {
				return chIndex;
			}
			if (wordType === WordType.Regular && chClass === WordCharacterClass.WordSeparator) {
				return chIndex;
			}
			if (wordType === WordType.Separator && chClass === WordCharacterClass.Regular) {
				return chIndex;
			}
		}
		return len;
	}

	private static _findNextWordOnLine(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position): IFindWordResult {
		let lineContent = model.getLineContent(position.lineNumber);
		return this._doFindNextWordOnLine(lineContent, wordSeparators, position);
	}

	private static _doFindNextWordOnLine(lineContent: string, wordSeparators: WordCharacterClassifier, position: Position): IFindWordResult {
		let wordType = WordType.None;
		let len = lineContent.length;

		for (let chIndex = position.column - 1; chIndex < len; chIndex++) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === WordCharacterClass.Regular) {
				if (wordType === WordType.Separator) {
					return this._createWord(lineContent, wordType, chClass, this._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
				wordType = WordType.Regular;
			} else if (chClass === WordCharacterClass.WordSeparator) {
				if (wordType === WordType.Regular) {
					return this._createWord(lineContent, wordType, chClass, this._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
				wordType = WordType.Separator;
			} else if (chClass === WordCharacterClass.Whitespace) {
				if (wordType !== WordType.None) {
					return this._createWord(lineContent, wordType, chClass, this._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
			}
		}

		if (wordType !== WordType.None) {
			return this._createWord(lineContent, wordType, WordCharacterClass.Whitespace, this._findStartOfWord(lineContent, wordSeparators, wordType, len - 1), len);
		}

		return null;
	}

	private static _findStartOfWord(lineContent: string, wordSeparators: WordCharacterClassifier, wordType: WordType, startIndex: number): number {
		for (let chIndex = startIndex; chIndex >= 0; chIndex--) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === WordCharacterClass.Whitespace) {
				return chIndex + 1;
			}
			if (wordType === WordType.Regular && chClass === WordCharacterClass.WordSeparator) {
				return chIndex + 1;
			}
			if (wordType === WordType.Separator && chClass === WordCharacterClass.Regular) {
				return chIndex + 1;
			}
		}
		return 0;
	}

	public static moveWordLeft(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position, wordNavigationType: WordNavigationType): Position {
		let lineNumber = position.lineNumber;
		let column = position.column;

		if (column === 1) {
			if (lineNumber > 1) {
				lineNumber = lineNumber - 1;
				column = model.getLineMaxColumn(lineNumber);
			}
		}

		let prevWordOnLine = WordOperations._findPreviousWordOnLine(wordSeparators, model, new Position(lineNumber, column));

		if (wordNavigationType === WordNavigationType.WordStart) {
			if (prevWordOnLine && prevWordOnLine.wordType === WordType.Separator) {
				if (prevWordOnLine.end - prevWordOnLine.start === 1 && prevWordOnLine.nextCharClass === WordCharacterClass.Regular) {
					// Skip over a word made up of one single separator and followed by a regular character
					prevWordOnLine = WordOperations._findPreviousWordOnLine(wordSeparators, model, new Position(lineNumber, prevWordOnLine.start + 1));
				}
			}
			if (prevWordOnLine) {
				column = prevWordOnLine.start + 1;
			} else {
				column = 1;
			}
		} else {
			if (prevWordOnLine && column <= prevWordOnLine.end + 1) {
				prevWordOnLine = WordOperations._findPreviousWordOnLine(wordSeparators, model, new Position(lineNumber, prevWordOnLine.start + 1));
			}
			if (prevWordOnLine) {
				column = prevWordOnLine.end + 1;
			} else {
				column = 1;
			}
		}

		return new Position(lineNumber, column);
	}

	public static moveWordRight(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position, wordNavigationType: WordNavigationType): Position {
		let lineNumber = position.lineNumber;
		let column = position.column;

		if (column === model.getLineMaxColumn(lineNumber)) {
			if (lineNumber < model.getLineCount()) {
				lineNumber = lineNumber + 1;
				column = 1;
			}
		}

		let nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, new Position(lineNumber, column));

		if (wordNavigationType === WordNavigationType.WordEnd) {
			if (nextWordOnLine && nextWordOnLine.wordType === WordType.Separator) {
				if (nextWordOnLine.end - nextWordOnLine.start === 1 && nextWordOnLine.nextCharClass === WordCharacterClass.Regular) {
					// Skip over a word made up of one single separator and followed by a regular character
					nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, new Position(lineNumber, nextWordOnLine.end + 1));
				}
			}
			if (nextWordOnLine) {
				column = nextWordOnLine.end + 1;
			} else {
				column = model.getLineMaxColumn(lineNumber);
			}
		} else {
			if (nextWordOnLine && column >= nextWordOnLine.start + 1) {
				nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, new Position(lineNumber, nextWordOnLine.end + 1));
			}
			if (nextWordOnLine) {
				column = nextWordOnLine.start + 1;
			} else {
				column = model.getLineMaxColumn(lineNumber);
			}
		}

		return new Position(lineNumber, column);
	}

	private static _deleteWordLeftWhitespace(model: ICursorSimpleModel, position: Position): Range {
		const lineContent = model.getLineContent(position.lineNumber);
		const startIndex = position.column - 2;
		const lastNonWhitespace = strings.lastNonWhitespaceIndex(lineContent, startIndex);
		if (lastNonWhitespace + 1 < startIndex) {
			return new Range(position.lineNumber, lastNonWhitespace + 2, position.lineNumber, position.column);
		}
		return null;
	}

	public static deleteWordLeft(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, selection: Selection, whitespaceHeuristics: boolean, wordNavigationType: WordNavigationType): Range {
		if (!selection.isEmpty()) {
			return selection;
		}

		const position = new Position(selection.positionLineNumber, selection.positionColumn);

		let lineNumber = position.lineNumber;
		let column = position.column;

		if (lineNumber === 1 && column === 1) {
			// Ignore deleting at beginning of file
			return null;
		}

		if (whitespaceHeuristics) {
			let r = this._deleteWordLeftWhitespace(model, position);
			if (r) {
				return r;
			}
		}

		let prevWordOnLine = WordOperations._findPreviousWordOnLine(wordSeparators, model, position);

		if (wordNavigationType === WordNavigationType.WordStart) {
			if (prevWordOnLine) {
				column = prevWordOnLine.start + 1;
			} else {
				if (column > 1) {
					column = 1;
				} else {
					lineNumber--;
					column = model.getLineMaxColumn(lineNumber);
				}
			}
		} else {
			if (prevWordOnLine && column <= prevWordOnLine.end + 1) {
				prevWordOnLine = WordOperations._findPreviousWordOnLine(wordSeparators, model, new Position(lineNumber, prevWordOnLine.start + 1));
			}
			if (prevWordOnLine) {
				column = prevWordOnLine.end + 1;
			} else {
				if (column > 1) {
					column = 1;
				} else {
					lineNumber--;
					column = model.getLineMaxColumn(lineNumber);
				}
			}
		}

		return new Range(lineNumber, column, position.lineNumber, position.column);
	}

	private static _findFirstNonWhitespaceChar(str: string, startIndex: number): number {
		let len = str.length;
		for (let chIndex = startIndex; chIndex < len; chIndex++) {
			let ch = str.charAt(chIndex);
			if (ch !== ' ' && ch !== '\t') {
				return chIndex;
			}
		}
		return len;
	}

	private static _deleteWordRightWhitespace(model: ICursorSimpleModel, position: Position): Range {
		const lineContent = model.getLineContent(position.lineNumber);
		const startIndex = position.column - 1;
		const firstNonWhitespace = this._findFirstNonWhitespaceChar(lineContent, startIndex);
		if (startIndex + 1 < firstNonWhitespace) {
			// bingo
			return new Range(position.lineNumber, position.column, position.lineNumber, firstNonWhitespace + 1);
		}
		return null;
	}

	public static deleteWordRight(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, selection: Selection, whitespaceHeuristics: boolean, wordNavigationType: WordNavigationType): Range {
		if (!selection.isEmpty()) {
			return selection;
		}

		const position = new Position(selection.positionLineNumber, selection.positionColumn);

		let lineNumber = position.lineNumber;
		let column = position.column;

		const lineCount = model.getLineCount();
		const maxColumn = model.getLineMaxColumn(lineNumber);
		if (lineNumber === lineCount && column === maxColumn) {
			// Ignore deleting at end of file
			return null;
		}

		if (whitespaceHeuristics) {
			let r = this._deleteWordRightWhitespace(model, position);
			if (r) {
				return r;
			}
		}

		let nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, position);

		if (wordNavigationType === WordNavigationType.WordEnd) {
			if (nextWordOnLine) {
				column = nextWordOnLine.end + 1;
			} else {
				if (column < maxColumn || lineNumber === lineCount) {
					column = maxColumn;
				} else {
					lineNumber++;
					nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, new Position(lineNumber, 1));
					if (nextWordOnLine) {
						column = nextWordOnLine.start + 1;
					} else {
						column = model.getLineMaxColumn(lineNumber);
					}
				}
			}
		} else {
			if (nextWordOnLine && column >= nextWordOnLine.start + 1) {
				nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, new Position(lineNumber, nextWordOnLine.end + 1));
			}
			if (nextWordOnLine) {
				column = nextWordOnLine.start + 1;
			} else {
				if (column < maxColumn || lineNumber === lineCount) {
					column = maxColumn;
				} else {
					lineNumber++;
					nextWordOnLine = WordOperations._findNextWordOnLine(wordSeparators, model, new Position(lineNumber, 1));
					if (nextWordOnLine) {
						column = nextWordOnLine.start + 1;
					} else {
						column = model.getLineMaxColumn(lineNumber);
					}
				}
			}
		}

		return new Range(lineNumber, column, position.lineNumber, position.column);
	}

	public static word(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, position: Position): SingleCursorState {
		const wordSeparators = getMapForWordSeparators(config.wordSeparators);
		let prevWord = WordOperations._findPreviousWordOnLine(wordSeparators, model, position);
		let nextWord = WordOperations._findNextWordOnLine(wordSeparators, model, position);

		if (!inSelectionMode) {
			// Entering word selection for the first time
			const isTouchingPrevWord = (prevWord && prevWord.wordType === WordType.Regular && prevWord.start <= position.column - 1 && position.column - 1 <= prevWord.end);
			const isTouchingNextWord = (nextWord && nextWord.wordType === WordType.Regular && nextWord.start <= position.column - 1 && position.column - 1 <= nextWord.end);

			let startColumn: number;
			let endColumn: number;

			if (isTouchingPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isTouchingNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				if (prevWord) {
					startColumn = prevWord.end + 1;
				} else {
					startColumn = 1;
				}
				if (nextWord) {
					endColumn = nextWord.start + 1;
				} else {
					endColumn = model.getLineMaxColumn(position.lineNumber);
				}
			}

			return new SingleCursorState(
				new Range(position.lineNumber, startColumn, position.lineNumber, endColumn), 0,
				new Position(position.lineNumber, endColumn), 0
			);
		}

		const isInsidePrevWord = (prevWord && prevWord.wordType === WordType.Regular && prevWord.start < position.column - 1 && position.column - 1 < prevWord.end);
		const isInsideNextWord = (nextWord && nextWord.wordType === WordType.Regular && nextWord.start < position.column - 1 && position.column - 1 < nextWord.end);

		let startColumn: number;
		let endColumn: number;

		if (isInsidePrevWord) {
			startColumn = prevWord.start + 1;
			endColumn = prevWord.end + 1;
		} else if (isInsideNextWord) {
			startColumn = nextWord.start + 1;
			endColumn = nextWord.end + 1;
		} else {
			startColumn = position.column;
			endColumn = position.column;
		}

		let lineNumber = position.lineNumber;
		let column: number;
		if (cursor.selectionStart.containsPosition(position)) {
			column = cursor.selectionStart.endColumn;
		} else if (position.isBeforeOrEqual(cursor.selectionStart.getStartPosition())) {
			column = startColumn;
			let possiblePosition = new Position(lineNumber, column);
			if (cursor.selectionStart.containsPosition(possiblePosition)) {
				column = cursor.selectionStart.endColumn;
			}
		} else {
			column = endColumn;
			let possiblePosition = new Position(lineNumber, column);
			if (cursor.selectionStart.containsPosition(possiblePosition)) {
				column = cursor.selectionStart.startColumn;
			}
		}

		return cursor.move(true, lineNumber, column, 0);
	}
}

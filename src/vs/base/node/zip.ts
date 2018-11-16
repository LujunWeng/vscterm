/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as path from 'path';
import { createWriteStream, WriteStream } from 'fs';
import { Readable } from 'stream';
import { nfcall, ninvoke, SimpleThrottler } from 'vs/base/common/async';
import { mkdirp, rimraf } from 'vs/base/node/pfs';
import { TPromise } from 'vs/base/common/winjs.base';
import { open as _openZip, Entry, ZipFile } from 'yauzl';
import { ILogService } from 'vs/platform/log/common/log';

export interface IExtractOptions {
	overwrite?: boolean;

	/**
	 * Source path within the ZIP archive. Only the files contained in this
	 * path will be extracted.
	 */
	sourcePath?: string;
}

interface IOptions {
	sourcePathRegex: RegExp;
}

export type ExtractErrorType = 'CorruptZip' | 'Incomplete';

export class ExtractError extends Error {

	readonly type: ExtractErrorType;
	readonly cause: Error;

	constructor(type: ExtractErrorType, cause: Error) {
		let message = cause.message;

		switch (type) {
			case 'CorruptZip': message = `Corrupt ZIP: ${message}`; break;
		}

		super(message);
		this.type = type;
		this.cause = cause;
	}
}

function modeFromEntry(entry: Entry) {
	let attr = entry.externalFileAttributes >> 16 || 33188;

	return [448 /* S_IRWXU */, 56 /* S_IRWXG */, 7 /* S_IRWXO */]
		.map(mask => attr & mask)
		.reduce((a, b) => a + b, attr & 61440 /* S_IFMT */);
}

function toExtractError(err: Error): ExtractError {
	if (err instanceof ExtractError) {
		return err;
	}

	let type: ExtractErrorType = void 0;

	if (/end of central directory record signature not found/.test(err.message)) {
		type = 'CorruptZip';
	}

	return new ExtractError(type, err);
}

function extractEntry(stream: Readable, fileName: string, mode: number, targetPath: string, options: IOptions): TPromise<void> {
	const dirName = path.dirname(fileName);
	const targetDirName = path.join(targetPath, dirName);
	const targetFileName = path.join(targetPath, fileName);

	let istream: WriteStream;
	return mkdirp(targetDirName).then(() => new TPromise((c, e) => {
		istream = createWriteStream(targetFileName, { mode });
		istream.once('close', () => c(null));
		istream.once('error', e);
		stream.once('error', e);
		stream.pipe(istream);
	}, () => {
		if (istream) {
			istream.close();
		}
	}));
}

function extractZip(zipfile: ZipFile, targetPath: string, options: IOptions, logService: ILogService): TPromise<void> {
	let isCanceled = false;
	let last = TPromise.wrap<any>(null);
	let extractedEntriesCount = 0;

	return new TPromise((c, e) => {
		const throttler = new SimpleThrottler();

		const readNextEntry = () => {
			extractedEntriesCount++;
			zipfile.readEntry();
		};

		zipfile.once('error', e);
		zipfile.once('close', () => last.then(() => {
			if (isCanceled || zipfile.entryCount === extractedEntriesCount) {
				c(null);
			} else {
				e(new ExtractError('Incomplete', new Error(nls.localize('incompleteExtract', "Incomplete. Found {0} of {1} entries", extractedEntriesCount, zipfile.entryCount))));
			}
		}, e));
		zipfile.readEntry();
		zipfile.on('entry', (entry: Entry) => {
			logService.debug(targetPath, 'Found', entry.fileName);

			if (isCanceled) {
				return;
			}

			if (!options.sourcePathRegex.test(entry.fileName)) {
				readNextEntry();
				return;
			}

			const fileName = entry.fileName.replace(options.sourcePathRegex, '');

			// directory file names end with '/'
			if (/\/$/.test(fileName)) {
				const targetFileName = path.join(targetPath, fileName);
				last = mkdirp(targetFileName).then(() => readNextEntry());
				return;
			}

			const stream = ninvoke(zipfile, zipfile.openReadStream, entry);
			const mode = modeFromEntry(entry);

			last = throttler.queue(() => stream.then(stream => extractEntry(stream, fileName, mode, targetPath, options).then(() => readNextEntry())));
		});
	}, () => {
		logService.debug(targetPath, 'Cancelled.');
		isCanceled = true;
		last.cancel();
		zipfile.close();
	}).then(null, err => TPromise.wrapError(toExtractError(err)));
}

function openZip(zipFile: string, lazy: boolean = false): TPromise<ZipFile> {
	return nfcall<ZipFile>(_openZip, zipFile, lazy ? { lazyEntries: true } : void 0)
		.then(null, err => TPromise.wrapError(toExtractError(err)));
}

export function extract(zipPath: string, targetPath: string, options: IExtractOptions = {}, logService: ILogService): TPromise<void> {
	const sourcePathRegex = new RegExp(options.sourcePath ? `^${options.sourcePath}` : '');

	let promise = openZip(zipPath, true);

	if (options.overwrite) {
		promise = promise.then(zipfile => rimraf(targetPath).then(() => zipfile));
	}

	return promise.then(zipfile => extractZip(zipfile, targetPath, { sourcePathRegex }, logService));
}

function read(zipPath: string, filePath: string): TPromise<Readable> {
	return openZip(zipPath).then(zipfile => {
		return new TPromise<Readable>((c, e) => {
			zipfile.on('entry', (entry: Entry) => {
				if (entry.fileName === filePath) {
					ninvoke<Readable>(zipfile, zipfile.openReadStream, entry).done(stream => c(stream), err => e(err));
				}
			});

			zipfile.once('close', () => e(new Error(nls.localize('notFound', "{0} not found inside zip.", filePath))));
		});
	});
}

export function buffer(zipPath: string, filePath: string): TPromise<Buffer> {
	return read(zipPath, filePath).then(stream => {
		return new TPromise<Buffer>((c, e) => {
			const buffers: Buffer[] = [];
			stream.once('error', e);
			stream.on('data', b => buffers.push(b as Buffer));
			stream.on('end', () => c(Buffer.concat(buffers)));
		});
	});
}

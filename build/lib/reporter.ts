/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as es from 'event-stream';
import * as _ from 'underscore';
import * as util from 'gulp-util';
import * as fs from 'fs';
import * as path from 'path';

const allErrors: string[][] = [];
let startTime: number = null;
let count = 0;

function onStart(): void {
	if (count++ > 0) {
		return;
	}

	startTime = new Date().getTime();
	util.log(`Starting ${util.colors.green('compilation')}...`);
}

function onEnd(): void {
	if (--count > 0) {
		return;
	}

	log();
}

const buildLogPath = path.join(path.dirname(path.dirname(__dirname)), '.build', 'log');

try {
	fs.mkdirSync(path.dirname(buildLogPath));
} catch (err) {
	// ignore
}

function log(): void {
	const errors = _.flatten(allErrors);
	const seen = new Set<string>();

	errors.map(err => {
		if (!seen.has(err)) {
			seen.add(err);
			util.log(`${util.colors.red('Error')}: ${err}`);
		}
	});

	const regex = /^([^(]+)\((\d+),(\d+)\): (.*)$/;
	const messages = errors
		.map(err => regex.exec(err))
		.filter(match => !!match)
		.map(([, path, line, column, message]) => ({ path, line: parseInt(line), column: parseInt(column), message }));

	try {

		fs.writeFileSync(buildLogPath, JSON.stringify(messages));
	} catch (err) {
		//noop
	}

	util.log(`Finished ${util.colors.green('compilation')} with ${errors.length} errors after ${util.colors.magenta((new Date().getTime() - startTime) + ' ms')}`);
}

export interface IReporter {
	(err: string): void;
	hasErrors(): boolean;
	end(emitError: boolean): NodeJS.ReadWriteStream;
}

export function createReporter(): IReporter {
	const errors: string[] = [];
	allErrors.push(errors);

	class ReportFunc {
		constructor(err: string) {
			errors.push(err);
		}

		static hasErrors(): boolean {
			return errors.length > 0;
		}

		static end(emitError: boolean): NodeJS.ReadWriteStream {
			errors.length = 0;
			onStart();

			return es.through(null, function () {
				onEnd();

				if (emitError && errors.length > 0) {
					(errors as any).__logged__ = true;

					if (!(errors as any).__logged__) {
						log();
					}

					const err = new Error(`Found ${errors.length} errors`);
					(err as any).__reporter__ = true;
					this.emit('error', err);
				} else {
					this.emit('end');
				}
			});
		}
	}

	return <IReporter><any>ReportFunc;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as errors from 'vs/base/common/errors';
import { Promise, TPromise, ValueCallback, ErrorCallback, ProgressCallback } from 'vs/base/common/winjs.base';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { Event, Emitter } from 'vs/base/common/event';
import URI from 'vs/base/common/uri';

export function isThenable<T>(obj: any): obj is Thenable<T> {
	return obj && typeof (<Thenable<any>>obj).then === 'function';
}

export function toThenable<T>(arg: T | Thenable<T>): Thenable<T> {
	if (isThenable(arg)) {
		return arg;
	} else {
		return TPromise.as(arg);
	}
}

export function toWinJsPromise<T>(arg: Thenable<T> | TPromise<T>): TPromise<T> {
	if (arg instanceof TPromise) {
		return arg;
	}

	return new TPromise((resolve, reject) => arg.then(resolve, reject));
}

export function asWinJsPromise<T>(callback: (token: CancellationToken) => T | TPromise<T> | Thenable<T>): TPromise<T> {
	let source = new CancellationTokenSource();
	return new TPromise<T>((resolve, reject, progress) => {
		let item = callback(source.token);
		if (item instanceof TPromise) {
			item.then(result => {
				source.dispose();
				resolve(result);
			}, err => {
				source.dispose();
				reject(err);
			}, progress);
		} else if (isThenable<T>(item)) {
			item.then(result => {
				source.dispose();
				resolve(result);
			}, err => {
				source.dispose();
				reject(err);
			});
		} else {
			source.dispose();
			resolve(item);
		}
	}, () => {
		source.cancel();
	});
}

export function asWinJSImport<T>(importPromise: Thenable<T>): TPromise<T> {
	return toWinJsPromise(importPromise); // workaround for https://github.com/Microsoft/vscode/issues/48205
}

/**
 * Hook a cancellation token to a WinJS Promise
 */
export function wireCancellationToken<T>(token: CancellationToken, promise: TPromise<T>, resolveAsUndefinedWhenCancelled?: boolean): Thenable<T> {
	const subscription = token.onCancellationRequested(() => promise.cancel());
	if (resolveAsUndefinedWhenCancelled) {
		promise = promise.then<T>(undefined, err => {
			if (!errors.isPromiseCanceledError(err)) {
				return TPromise.wrapError(err);
			}
			return undefined;
		});
	}
	return always(promise, () => subscription.dispose());
}

export function asDisposablePromise<T>(input: Thenable<T>, cancelValue?: T, bucket?: IDisposable[]): { promise: Thenable<T> } & IDisposable {
	let dispose: () => void;
	let promise = new TPromise((resolve, reject) => {
		dispose = function () {
			resolve(cancelValue);
		};
		input.then(resolve, reject);
	});
	let res = {
		promise,
		dispose
	};
	if (Array.isArray(bucket)) {
		bucket.push(res);
	}
	return res;
}

export interface ITask<T> {
	(): T;
}

/**
 * A helper to prevent accumulation of sequential async tasks.
 *
 * Imagine a mail man with the sole task of delivering letters. As soon as
 * a letter submitted for delivery, he drives to the destination, delivers it
 * and returns to his base. Imagine that during the trip, N more letters were submitted.
 * When the mail man returns, he picks those N letters and delivers them all in a
 * single trip. Even though N+1 submissions occurred, only 2 deliveries were made.
 *
 * The throttler implements this via the queue() method, by providing it a task
 * factory. Following the example:
 *
 * 		const throttler = new Throttler();
 * 		const letters = [];
 *
 * 		function deliver() {
 * 			const lettersToDeliver = letters;
 * 			letters = [];
 * 			return makeTheTrip(lettersToDeliver);
 * 		}
 *
 * 		function onLetterReceived(l) {
 * 			letters.push(l);
 * 			throttler.queue(deliver);
 * 		}
 */
export class Throttler {

	private activePromise: Promise;
	private queuedPromise: Promise;
	private queuedPromiseFactory: ITask<Promise>;

	constructor() {
		this.activePromise = null;
		this.queuedPromise = null;
		this.queuedPromiseFactory = null;
	}

	queue<T>(promiseFactory: ITask<TPromise<T>>): TPromise<T> {
		if (this.activePromise) {
			this.queuedPromiseFactory = promiseFactory;

			if (!this.queuedPromise) {
				const onComplete = () => {
					this.queuedPromise = null;

					const result = this.queue(this.queuedPromiseFactory);
					this.queuedPromiseFactory = null;

					return result;
				};

				this.queuedPromise = new TPromise((c, e, p) => {
					this.activePromise.then(onComplete, onComplete, p).done(c);
				}, () => {
					this.activePromise.cancel();
				});
			}

			return new TPromise((c, e, p) => {
				this.queuedPromise.then(c, e, p);
			}, () => {
				// no-op
			});
		}

		this.activePromise = promiseFactory();

		return new TPromise((c, e, p) => {
			this.activePromise.done((result: any) => {
				this.activePromise = null;
				c(result);
			}, (err: any) => {
				this.activePromise = null;
				e(err);
			}, p);
		}, () => {
			this.activePromise.cancel();
		});
	}
}

// TODO@Joao: can the previous throttler be replaced with this?
export class SimpleThrottler {

	private current = TPromise.wrap<any>(null);

	queue<T>(promiseTask: ITask<TPromise<T>>): TPromise<T> {
		return this.current = this.current.then(() => promiseTask());
	}
}

/**
 * A helper to delay execution of a task that is being requested often.
 *
 * Following the throttler, now imagine the mail man wants to optimize the number of
 * trips proactively. The trip itself can be long, so he decides not to make the trip
 * as soon as a letter is submitted. Instead he waits a while, in case more
 * letters are submitted. After said waiting period, if no letters were submitted, he
 * decides to make the trip. Imagine that N more letters were submitted after the first
 * one, all within a short period of time between each other. Even though N+1
 * submissions occurred, only 1 delivery was made.
 *
 * The delayer offers this behavior via the trigger() method, into which both the task
 * to be executed and the waiting period (delay) must be passed in as arguments. Following
 * the example:
 *
 * 		const delayer = new Delayer(WAITING_PERIOD);
 * 		const letters = [];
 *
 * 		function letterReceived(l) {
 * 			letters.push(l);
 * 			delayer.trigger(() => { return makeTheTrip(); });
 * 		}
 */
export class Delayer<T> {

	private timeout: number;
	private completionPromise: Promise;
	private onSuccess: ValueCallback;
	private task: ITask<T | TPromise<T>>;

	constructor(public defaultDelay: number) {
		this.timeout = null;
		this.completionPromise = null;
		this.onSuccess = null;
		this.task = null;
	}

	trigger(task: ITask<T | TPromise<T>>, delay: number = this.defaultDelay): TPromise<T> {
		this.task = task;
		this.cancelTimeout();

		if (!this.completionPromise) {
			this.completionPromise = new TPromise((c) => {
				this.onSuccess = c;
			}, () => {
				// no-op
			}).then(() => {
				this.completionPromise = null;
				this.onSuccess = null;
				const task = this.task;
				this.task = null;

				return task();
			});
		}

		this.timeout = setTimeout(() => {
			this.timeout = null;
			this.onSuccess(null);
		}, delay);

		return this.completionPromise;
	}

	isTriggered(): boolean {
		return this.timeout !== null;
	}

	cancel(): void {
		this.cancelTimeout();

		if (this.completionPromise) {
			this.completionPromise.cancel();
			this.completionPromise = null;
		}
	}

	private cancelTimeout(): void {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
	}
}

/**
 * A helper to delay execution of a task that is being requested often, while
 * preventing accumulation of consecutive executions, while the task runs.
 *
 * Simply combine the two mail men's strategies from the Throttler and Delayer
 * helpers, for an analogy.
 */
export class ThrottledDelayer<T> extends Delayer<TPromise<T>> {

	private throttler: Throttler;

	constructor(defaultDelay: number) {
		super(defaultDelay);

		this.throttler = new Throttler();
	}

	trigger(promiseFactory: ITask<TPromise<T>>, delay?: number): TPromise {
		return super.trigger(() => this.throttler.queue(promiseFactory), delay);
	}
}

/**
 * A barrier that is initially closed and then becomes opened permanently.
 */
export class Barrier {

	private _isOpen: boolean;
	private _promise: TPromise<boolean>;
	private _completePromise: (v: boolean) => void;

	constructor() {
		this._isOpen = false;
		this._promise = new TPromise<boolean>((c, e, p) => {
			this._completePromise = c;
		}, () => {
			console.warn('You should really not try to cancel this ready promise!');
		});
	}

	isOpen(): boolean {
		return this._isOpen;
	}

	open(): void {
		this._isOpen = true;
		this._completePromise(true);
	}

	wait(): TPromise<boolean> {
		return this._promise;
	}
}

export class ShallowCancelThenPromise<T> extends TPromise<T> {

	constructor(outer: TPromise<T>) {

		let completeCallback: ValueCallback,
			errorCallback: ErrorCallback,
			progressCallback: ProgressCallback;

		super((c, e, p) => {
			completeCallback = c;
			errorCallback = e;
			progressCallback = p;
		}, () => {
			// cancel this promise but not the
			// outer promise
			errorCallback(errors.canceled());
		});

		outer.then(completeCallback, errorCallback, progressCallback);
	}
}

/**
 * Replacement for `WinJS.Promise.timeout`.
 */
export function timeout(n: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, n));
}

function isWinJSPromise(candidate: any): candidate is TPromise {
	return TPromise.is(candidate) && typeof (<TPromise>candidate).done === 'function';
}

/**
 * Returns a new promise that joins the provided promise. Upon completion of
 * the provided promise the provided function will always be called. This
 * method is comparable to a try-finally code block.
 * @param promise a promise
 * @param f a function that will be call in the success and error case.
 */
export function always<T>(thenable: TPromise<T>, f: Function): TPromise<T>;
export function always<T>(promise: Thenable<T>, f: Function): Thenable<T>;
export function always<T>(winjsPromiseOrThenable: Thenable<T> | TPromise<T>, f: Function): TPromise<T> | Thenable<T> {
	if (isWinJSPromise(winjsPromiseOrThenable)) {
		return new TPromise<T>((c, e, p) => {
			winjsPromiseOrThenable.done((result) => {
				try {
					f(result);
				} catch (e1) {
					errors.onUnexpectedError(e1);
				}
				c(result);
			}, (err) => {
				try {
					f(err);
				} catch (e1) {
					errors.onUnexpectedError(e1);
				}
				e(err);
			}, (progress) => {
				p(progress);
			});
		}, () => {
			winjsPromiseOrThenable.cancel();
		});

	} else {
		// simple
		winjsPromiseOrThenable.then(_ => f(), _ => f());
		return winjsPromiseOrThenable;
	}
}

/**
 * Runs the provided list of promise factories in sequential order. The returned
 * promise will complete to an array of results from each promise.
 */

export function sequence<T>(promiseFactories: ITask<Thenable<T>>[]): TPromise<T[]> {
	const results: T[] = [];

	// reverse since we start with last element using pop()
	promiseFactories = promiseFactories.reverse();

	function next(): Thenable<any> {
		if (promiseFactories.length) {
			return promiseFactories.pop()();
		}

		return null;
	}

	function thenHandler(result: any): Thenable<any> {
		if (result !== undefined && result !== null) {
			results.push(result);
		}

		const n = next();
		if (n) {
			return n.then(thenHandler);
		}

		return TPromise.as(results);
	}

	return TPromise.as(null).then(thenHandler);
}

export function first<T>(promiseFactories: ITask<TPromise<T>>[], shouldStop: (t: T) => boolean = t => !!t): TPromise<T> {
	promiseFactories = [...promiseFactories.reverse()];

	const loop: () => TPromise<T> = () => {
		if (promiseFactories.length === 0) {
			return TPromise.as(null);
		}

		const factory = promiseFactories.pop();
		const promise = factory();

		return promise.then(result => {
			if (shouldStop(result)) {
				return TPromise.as(result);
			}

			return loop();
		});
	};

	return loop();
}

interface ILimitedTaskFactory {
	factory: ITask<Promise>;
	c: ValueCallback;
	e: ErrorCallback;
	p: ProgressCallback;
}

/**
 * A helper to queue N promises and run them all with a max degree of parallelism. The helper
 * ensures that at any time no more than M promises are running at the same time.
 */
export class Limiter<T> {
	private runningPromises: number;
	private maxDegreeOfParalellism: number;
	private outstandingPromises: ILimitedTaskFactory[];
	private readonly _onFinished: Emitter<void>;

	constructor(maxDegreeOfParalellism: number) {
		this.maxDegreeOfParalellism = maxDegreeOfParalellism;
		this.outstandingPromises = [];
		this.runningPromises = 0;
		this._onFinished = new Emitter<void>();
	}

	public get onFinished(): Event<void> {
		return this._onFinished.event;
	}

	public get size(): number {
		return this.runningPromises + this.outstandingPromises.length;
	}

	queue(promiseFactory: ITask<Promise>): Promise;
	queue(promiseFactory: ITask<TPromise<T>>): TPromise<T> {
		return new TPromise<T>((c, e, p) => {
			this.outstandingPromises.push({
				factory: promiseFactory,
				c: c,
				e: e,
				p: p
			});

			this.consume();
		});
	}

	private consume(): void {
		while (this.outstandingPromises.length && this.runningPromises < this.maxDegreeOfParalellism) {
			const iLimitedTask = this.outstandingPromises.shift();
			this.runningPromises++;

			const promise = iLimitedTask.factory();
			promise.done(iLimitedTask.c, iLimitedTask.e, iLimitedTask.p);
			promise.done(() => this.consumed(), () => this.consumed());
		}
	}

	private consumed(): void {
		this.runningPromises--;

		if (this.outstandingPromises.length > 0) {
			this.consume();
		} else {
			this._onFinished.fire();
		}
	}

	public dispose(): void {
		this._onFinished.dispose();
	}
}

/**
 * A queue is handles one promise at a time and guarantees that at any time only one promise is executing.
 */
export class Queue<T> extends Limiter<T> {

	constructor() {
		super(1);
	}
}

/**
 * A helper to organize queues per resource. The ResourceQueue makes sure to manage queues per resource
 * by disposing them once the queue is empty.
 */
export class ResourceQueue {
	private queues: { [path: string]: Queue<void> };

	constructor() {
		this.queues = Object.create(null);
	}

	public queueFor(resource: URI): Queue<void> {
		const key = resource.toString();
		if (!this.queues[key]) {
			const queue = new Queue<void>();
			queue.onFinished(() => {
				queue.dispose();
				delete this.queues[key];
			});

			this.queues[key] = queue;
		}

		return this.queues[key];
	}
}

export function setDisposableTimeout(handler: Function, timeout: number, ...args: any[]): IDisposable {
	const handle = setTimeout(handler, timeout, ...args);
	return { dispose() { clearTimeout(handle); } };
}

export class TimeoutTimer extends Disposable {
	private _token: number;

	constructor() {
		super();
		this._token = -1;
	}

	dispose(): void {
		this.cancel();
		super.dispose();
	}

	cancel(): void {
		if (this._token !== -1) {
			clearTimeout(this._token);
			this._token = -1;
		}
	}

	cancelAndSet(runner: () => void, timeout: number): void {
		this.cancel();
		this._token = setTimeout(() => {
			this._token = -1;
			runner();
		}, timeout);
	}

	setIfNotSet(runner: () => void, timeout: number): void {
		if (this._token !== -1) {
			// timer is already set
			return;
		}
		this._token = setTimeout(() => {
			this._token = -1;
			runner();
		}, timeout);
	}
}

export class IntervalTimer extends Disposable {

	private _token: number;

	constructor() {
		super();
		this._token = -1;
	}

	dispose(): void {
		this.cancel();
		super.dispose();
	}

	cancel(): void {
		if (this._token !== -1) {
			clearInterval(this._token);
			this._token = -1;
		}
	}

	cancelAndSet(runner: () => void, interval: number): void {
		this.cancel();
		this._token = setInterval(() => {
			runner();
		}, interval);
	}
}

export class RunOnceScheduler {

	protected runner: (...args: any[]) => void;

	private timeoutToken: number;
	private timeout: number;
	private timeoutHandler: () => void;

	constructor(runner: (...args: any[]) => void, timeout: number) {
		this.timeoutToken = -1;
		this.runner = runner;
		this.timeout = timeout;
		this.timeoutHandler = this.onTimeout.bind(this);
	}

	/**
	 * Dispose RunOnceScheduler
	 */
	dispose(): void {
		this.cancel();
		this.runner = null;
	}

	/**
	 * Cancel current scheduled runner (if any).
	 */
	cancel(): void {
		if (this.isScheduled()) {
			clearTimeout(this.timeoutToken);
			this.timeoutToken = -1;
		}
	}

	/**
	 * Cancel previous runner (if any) & schedule a new runner.
	 */
	schedule(delay = this.timeout): void {
		this.cancel();
		this.timeoutToken = setTimeout(this.timeoutHandler, delay);
	}

	/**
	 * Returns true if scheduled.
	 */
	isScheduled(): boolean {
		return this.timeoutToken !== -1;
	}

	private onTimeout() {
		this.timeoutToken = -1;
		if (this.runner) {
			this.doRun();
		}
	}

	protected doRun(): void {
		this.runner();
	}
}

export class RunOnceWorker<T> extends RunOnceScheduler {
	private units: T[] = [];

	constructor(runner: (units: T[]) => void, timeout: number) {
		super(runner, timeout);
	}

	work(unit: T): void {
		this.units.push(unit);

		if (!this.isScheduled()) {
			this.schedule();
		}
	}

	protected doRun(): void {
		const units = this.units;
		this.units = [];

		this.runner(units);
	}

	dispose(): void {
		this.units = [];

		super.dispose();
	}
}

export function nfcall(fn: Function, ...args: any[]): Promise;
export function nfcall<T>(fn: Function, ...args: any[]): TPromise<T>;
export function nfcall(fn: Function, ...args: any[]): any {
	return new TPromise((c, e) => fn(...args, (err: any, result: any) => err ? e(err) : c(result)), () => null);
}

export function ninvoke(thisArg: any, fn: Function, ...args: any[]): Promise;
export function ninvoke<T>(thisArg: any, fn: Function, ...args: any[]): TPromise<T>;
export function ninvoke(thisArg: any, fn: Function, ...args: any[]): any {
	return new TPromise((c, e) => fn.call(thisArg, ...args, (err: any, result: any) => err ? e(err) : c(result)), () => null);
}

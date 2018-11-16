/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as assert from 'assert';
import * as sinon from 'sinon';
import { TestInstantiationService } from 'vs/platform/instantiation/test/common/instantiationServiceMock';
import { DeferredPPromise } from 'vs/base/test/common/utils';
import { PPromise } from 'vs/base/common/winjs.base';
import { SearchModel } from 'vs/workbench/parts/search/common/searchModel';
import URI from 'vs/base/common/uri';
import { IFileMatch, IFolderQuery, ILineMatch, ISearchService, ISearchComplete, ISearchProgressItem, IUncachedSearchStats } from 'vs/platform/search/common/search';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { Range } from 'vs/editor/common/core/range';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { TestConfigurationService } from 'vs/platform/configuration/test/common/testConfigurationService';
import { ModelServiceImpl } from 'vs/editor/common/services/modelServiceImpl';
import { timeout } from 'vs/base/common/async';

const nullEvent = new class {

	public id: number;
	public topic: string;
	public name: string;
	public description: string;
	public data: any;

	public startTime: Date;
	public stopTime: Date;

	public stop(): void {
		return;
	}

	public timeTaken(): number {
		return -1;
	}
};


suite('SearchModel', () => {

	let instantiationService: TestInstantiationService;
	let restoreStubs: sinon.SinonStub[];

	const testSearchStats: IUncachedSearchStats = {
		fromCache: false,
		resultCount: 4,
		traversal: 'node',
		errors: [],
		fileWalkStartTime: 0,
		fileWalkResultTime: 1,
		directoriesWalked: 2,
		filesWalked: 3
	};

	const folderQueries: IFolderQuery[] = [
		{ folder: URI.parse('file://c:/') }
	];

	setup(() => {
		restoreStubs = [];
		instantiationService = new TestInstantiationService();
		instantiationService.stub(ITelemetryService, NullTelemetryService);
		instantiationService.stub(IModelService, stubModelService(instantiationService));
		instantiationService.stub(ISearchService, {});
		instantiationService.stub(ISearchService, 'search', PPromise.as({ results: [] }));
	});

	teardown(() => {
		restoreStubs.forEach(element => {
			element.restore();
		});
	});

	function ppromiseWithProgress(results: IFileMatch[]): () => PPromise<any, IFileMatch> {
		return () => new PPromise((resolve, reject, progress) => {
			process.nextTick(() => {
				results.forEach(progress);
				resolve(null);
			});
		});
	}

	test('Search Model: Search adds to results', async () => {
		let results = [aRawMatch('file://c:/1', aLineMatch('preview 1', 1, [[1, 3], [4, 7]])), aRawMatch('file://c:/2', aLineMatch('preview 2'))];
		instantiationService.stub(ISearchService, 'search', ppromiseWithProgress(results));

		let testObject: SearchModel = instantiationService.createInstance(SearchModel);
		await testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		let actual = testObject.searchResult.matches();

		assert.equal(2, actual.length);
		assert.equal('file://c:/1', actual[0].resource().toString());

		let actuaMatches = actual[0].matches();
		assert.equal(2, actuaMatches.length);
		assert.equal('preview 1', actuaMatches[0].text());
		assert.ok(new Range(2, 2, 2, 5).equalsRange(actuaMatches[0].range()));
		assert.equal('preview 1', actuaMatches[1].text());
		assert.ok(new Range(2, 5, 2, 12).equalsRange(actuaMatches[1].range()));

		actuaMatches = actual[1].matches();
		assert.equal(1, actuaMatches.length);
		assert.equal('preview 2', actuaMatches[0].text());
		assert.ok(new Range(2, 1, 2, 2).equalsRange(actuaMatches[0].range()));
	});

	test('Search Model: Search reports telemetry on search completed', async () => {
		let target = instantiationService.spy(ITelemetryService, 'publicLog');
		let results = [aRawMatch('file://c:/1', aLineMatch('preview 1', 1, [[1, 3], [4, 7]])), aRawMatch('file://c:/2', aLineMatch('preview 2'))];
		instantiationService.stub(ISearchService, 'search', ppromiseWithProgress(results));

		let testObject = instantiationService.createInstance(SearchModel);
		await testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		assert.ok(target.calledThrice);
		const data = target.args[0];
		data[1].duration = -1;
		assert.deepEqual(['searchResultsFirstRender', { duration: -1 }], data);
	});

	test('Search Model: Search reports timed telemetry on search when progress is not called', () => {
		let target2 = sinon.spy();
		stub(nullEvent, 'stop', target2);
		let target1 = sinon.stub().returns(nullEvent);
		instantiationService.stub(ITelemetryService, 'publicLog', target1);

		instantiationService.stub(ISearchService, 'search', ppromiseWithProgress([]));

		let testObject = instantiationService.createInstance(SearchModel);
		const result = testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		return result.then(() => {
			return timeout(1).then(() => {
				assert.ok(target1.calledWith('searchResultsFirstRender'));
				assert.ok(target1.calledWith('searchResultsFinished'));
			});
		});
	});

	test('Search Model: Search reports timed telemetry on search when progress is called', () => {
		let target2 = sinon.spy();
		stub(nullEvent, 'stop', target2);
		let target1 = sinon.stub().returns(nullEvent);
		instantiationService.stub(ITelemetryService, 'publicLog', target1);

		let promise = new DeferredPPromise<ISearchComplete, ISearchProgressItem>();
		instantiationService.stub(ISearchService, 'search', promise);

		let testObject = instantiationService.createInstance(SearchModel);
		let result = testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		promise.progress(aRawMatch('file://c:/1', aLineMatch('some preview')));
		promise.complete({ results: [], stats: testSearchStats });

		return timeout(1).then(() => {
			return result.then(() => {
				assert.ok(target1.calledWith('searchResultsFirstRender'));
				assert.ok(target1.calledWith('searchResultsFinished'));
				// assert.equal(1, target2.callCount);
			});
		});
	});

	test('Search Model: Search reports timed telemetry on search when error is called', () => {
		let target2 = sinon.spy();
		stub(nullEvent, 'stop', target2);
		let target1 = sinon.stub().returns(nullEvent);
		instantiationService.stub(ITelemetryService, 'publicLog', target1);

		let promise = new DeferredPPromise<ISearchComplete, ISearchProgressItem>();
		instantiationService.stub(ISearchService, 'search', promise);

		let testObject = instantiationService.createInstance(SearchModel);
		let result = testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		promise.error('error');

		return timeout(1).then(() => {
			return result.then(() => { }, () => {
				assert.ok(target1.calledWith('searchResultsFirstRender'));
				assert.ok(target1.calledWith('searchResultsFinished'));
				// assert.ok(target2.calledOnce);
			});
		});
	});

	test('Search Model: Search reports timed telemetry on search when error is cancelled error', () => {
		let target2 = sinon.spy();
		stub(nullEvent, 'stop', target2);
		let target1 = sinon.stub().returns(nullEvent);
		instantiationService.stub(ITelemetryService, 'publicLog', target1);

		let promise = new DeferredPPromise<ISearchComplete, ISearchProgressItem>();
		instantiationService.stub(ISearchService, 'search', promise);

		let testObject = instantiationService.createInstance(SearchModel);
		let result = testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		promise.cancel();

		return timeout(1).then(() => {
			return result.then(() => { }, () => {
				assert.ok(target1.calledWith('searchResultsFirstRender'));
				assert.ok(target1.calledWith('searchResultsFinished'));
				// assert.ok(target2.calledOnce);
			});
		});
	});

	test('Search Model: Search results are cleared during search', async () => {
		let results = [aRawMatch('file://c:/1', aLineMatch('preview 1', 1, [[1, 3], [4, 7]])), aRawMatch('file://c:/2', aLineMatch('preview 2'))];
		instantiationService.stub(ISearchService, 'search', ppromiseWithProgress(results));
		let testObject: SearchModel = instantiationService.createInstance(SearchModel);
		await testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });
		assert.ok(!testObject.searchResult.isEmpty());

		instantiationService.stub(ISearchService, 'search', new DeferredPPromise<ISearchComplete, ISearchProgressItem>());

		testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });
		assert.ok(testObject.searchResult.isEmpty());
	});

	test('Search Model: Previous search is cancelled when new search is called', async () => {
		let target = sinon.spy();
		instantiationService.stub(ISearchService, 'search', new DeferredPPromise((c, e, p) => { }, target));
		let testObject: SearchModel = instantiationService.createInstance(SearchModel);

		testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });
		instantiationService.stub(ISearchService, 'search', new DeferredPPromise<ISearchComplete, ISearchProgressItem>());
		testObject.search({ contentPattern: { pattern: 'somestring' }, type: 1, folderQueries });

		assert.ok(target.calledOnce);
	});

	test('getReplaceString returns proper replace string for regExpressions', async () => {
		let results = [aRawMatch('file://c:/1', aLineMatch('preview 1', 1, [[1, 3], [4, 7]]))];
		instantiationService.stub(ISearchService, 'search', ppromiseWithProgress(results));

		let testObject: SearchModel = instantiationService.createInstance(SearchModel);
		await testObject.search({ contentPattern: { pattern: 're' }, type: 1, folderQueries });
		testObject.replaceString = 'hello';
		let match = testObject.searchResult.matches()[0].matches()[0];
		assert.equal('hello', match.replaceString);

		await testObject.search({ contentPattern: { pattern: 're', isRegExp: true }, type: 1, folderQueries });
		match = testObject.searchResult.matches()[0].matches()[0];
		assert.equal('hello', match.replaceString);

		await testObject.search({ contentPattern: { pattern: 're(?:vi)', isRegExp: true }, type: 1, folderQueries });
		match = testObject.searchResult.matches()[0].matches()[0];
		assert.equal('hello', match.replaceString);

		await testObject.search({ contentPattern: { pattern: 'r(e)(?:vi)', isRegExp: true }, type: 1, folderQueries });
		match = testObject.searchResult.matches()[0].matches()[0];
		assert.equal('hello', match.replaceString);

		await testObject.search({ contentPattern: { pattern: 'r(e)(?:vi)', isRegExp: true }, type: 1, folderQueries });
		testObject.replaceString = 'hello$1';
		match = testObject.searchResult.matches()[0].matches()[0];
		assert.equal('helloe', match.replaceString);
	});

	function aRawMatch(resource: string, ...lineMatches: ILineMatch[]): IFileMatch {
		return { resource: URI.parse(resource), lineMatches };
	}

	function aLineMatch(preview: string, lineNumber: number = 1, offsetAndLengths: number[][] = [[0, 1]]): ILineMatch {
		return { preview, lineNumber, offsetAndLengths };
	}

	function stub(arg1: any, arg2: any, arg3: any): sinon.SinonStub {
		const stub = sinon.stub(arg1, arg2, arg3);
		restoreStubs.push(stub);
		return stub;
	}

	function stubModelService(instantiationService: TestInstantiationService): IModelService {
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		return instantiationService.createInstance(ModelServiceImpl);
	}

});

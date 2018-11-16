/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
var es = require("event-stream");
var _ = require("underscore");
var util = require("gulp-util");
var fs = require("fs");
var path = require("path");
var allErrors = [];
var startTime = null;
var count = 0;
function onStart() {
    if (count++ > 0) {
        return;
    }
    startTime = new Date().getTime();
    util.log("Starting " + util.colors.green('compilation') + "...");
}
function onEnd() {
    if (--count > 0) {
        return;
    }
    log();
}
var buildLogPath = path.join(path.dirname(path.dirname(__dirname)), '.build', 'log');
try {
    fs.mkdirSync(path.dirname(buildLogPath));
}
catch (err) {
    // ignore
}
function log() {
    var errors = _.flatten(allErrors);
    var seen = new Set();
    errors.map(function (err) {
        if (!seen.has(err)) {
            seen.add(err);
            util.log(util.colors.red('Error') + ": " + err);
        }
    });
    var regex = /^([^(]+)\((\d+),(\d+)\): (.*)$/;
    var messages = errors
        .map(function (err) { return regex.exec(err); })
        .filter(function (match) { return !!match; })
        .map(function (_a) {
        var path = _a[1], line = _a[2], column = _a[3], message = _a[4];
        return ({ path: path, line: parseInt(line), column: parseInt(column), message: message });
    });
    try {
        fs.writeFileSync(buildLogPath, JSON.stringify(messages));
    }
    catch (err) {
        //noop
    }
    util.log("Finished " + util.colors.green('compilation') + " with " + errors.length + " errors after " + util.colors.magenta((new Date().getTime() - startTime) + ' ms'));
}
function createReporter() {
    var errors = [];
    allErrors.push(errors);
    var ReportFunc = /** @class */ (function () {
        function ReportFunc(err) {
            errors.push(err);
        }
        ReportFunc.hasErrors = function () {
            return errors.length > 0;
        };
        ReportFunc.end = function (emitError) {
            errors.length = 0;
            onStart();
            return es.through(null, function () {
                onEnd();
                if (emitError && errors.length > 0) {
                    errors.__logged__ = true;
                    if (!errors.__logged__) {
                        log();
                    }
                    var err = new Error("Found " + errors.length + " errors");
                    err.__reporter__ = true;
                    this.emit('error', err);
                }
                else {
                    this.emit('end');
                }
            });
        };
        return ReportFunc;
    }());
    return ReportFunc;
}
exports.createReporter = createReporter;

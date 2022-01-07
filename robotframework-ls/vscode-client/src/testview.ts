import * as vscode from "vscode";
import { logError, OUTPUT_CHANNEL } from "./channel";
import { readLaunchTemplate } from "./run";
import { sleep } from "./time";
import { WeakValueMap } from "./weakValueMap";

export interface IPosition {
    // Line position in a document (zero-based).
    line: number;

    // Character offset on a line in a document (zero-based). Assuming that
    // the line is represented as a string, the `character` value represents
    // the gap between the `character` and `character + 1`.
    //
    // If the character value is greater than the line length it defaults back
    // to the line length.
    character: number;
}

export interface IRange {
    start: IPosition;
    end: IPosition;
}

export interface ITestInfoFromSymbolsCache {
    name: string;
    range: IRange;
}

export interface ITestInfoFromUri {
    uri: string;
    testInfo: ITestInfoFromSymbolsCache[];
}

const controller = vscode.tests.createTestController("robotframework-lsp.testController", "Robot Framework");
controller.resolveHandler = async (test) => {
    if (!test) {
        // Wait for the first full refresh.
        await vscode.commands.executeCommand("robot.waitFirstTestCollection.internal");
    }
};

enum ItemType {
    File,
    TestCase,
}

interface ITestData {
    type: ItemType;
    testInfo: ITestInfoFromSymbolsCache | undefined;
}

const testData = new WeakMap<vscode.TestItem, ITestData>(); // Actually weak key map.

let lastRunId = 0;
function nextRunId(): string {
    lastRunId += 1;
    return `TestRun: ${lastRunId}`;
}

const runIdToTestRun = new Map<string, vscode.TestRun>();
const runIdToDebugSession = new Map<string, vscode.DebugSession>();

// Note: a test item id is uri a string such as:
// `${uri} [${testName}]`
const testItemIdToTestItem = new WeakValueMap<string, vscode.TestItem>();

function computeTestIdFromTestInfo(uriAsStr: string, test: ITestInfoFromSymbolsCache): string {
    OUTPUT_CHANNEL.appendLine("Computed: " + `${uriAsStr} [${test.name}]`);
    return `${uriAsStr} [${test.name}]`;
}

function computeTestId(uri: string, name: string): string {
    return `${uri} [${name}]`;
}

function getType(testItem: vscode.TestItem): ItemType {
    const data = testData.get(testItem);
    if (!data) {
        return undefined;
    }
    return data.type;
}

export async function handleTestsCollected(testInfo: ITestInfoFromUri) {
    const uri = vscode.Uri.parse(testInfo.uri);
    const uriAsStr = uri.toString();
    let file = controller.items.get(uriAsStr);
    if (testInfo.testInfo.length === 0) {
        if (file !== undefined) {
            controller.items.delete(uriAsStr);
        }
        return;
    }

    // We actually have tests to add.
    if (file !== undefined) {
        // This is a hack to work around https://github.com/microsoft/vscode/issues/140166
        // Ideally we wouldn't delete it in this case, just replace the children.
        controller.items.delete(uriAsStr);
        await sleep(500);
    }

    file = controller.createTestItem(uriAsStr, uri.path.split("/").pop()!, uri);
    testItemIdToTestItem.set(uriAsStr, file);
    testData.set(file, { type: ItemType.File, testInfo: undefined });
    controller.items.add(file);

    const children: vscode.TestItem[] = [];

    const found = new Set();

    for (const test of testInfo.testInfo) {
        const testItemId = computeTestIdFromTestInfo(uriAsStr, test);
        if (found.has(testItemId)) {
            continue;
        }
        found.add(testItemId);
        const testItem: vscode.TestItem = controller.createTestItem(testItemId, test.name, uri);
        testItemIdToTestItem.set(testItemId, testItem);
        const start = new vscode.Position(test.range.start.line, test.range.start.character);
        const end = new vscode.Position(test.range.end.line, test.range.end.character);
        testItem.range = new vscode.Range(start, end);
        testData.set(testItem, { type: ItemType.TestCase, testInfo: test });
        children.push(testItem);
    }

    file.children.replace(children);
}

export async function setupTestExplorerSupport() {
    async function runHandler(shouldDebug: boolean, request: vscode.TestRunRequest, token: vscode.CancellationToken) {
        const run = controller.createTestRun(request);
        const queue: vscode.TestItem[] = [];

        // Loop through all included tests, or all known tests, and add them to our queue
        if (request.include) {
            request.include.forEach((test) => queue.push(test));
        } else {
            controller.items.forEach((test) => queue.push(test));
        }

        const testCases: vscode.TestItem[] = [];
        while (queue.length > 0 && !token.isCancellationRequested) {
            const test = queue.pop()!;

            // Skip tests the user asked to exclude
            if (request.exclude?.includes(test)) {
                continue;
            }

            switch (getType(test)) {
                case ItemType.TestCase:
                    testCases.push(test);
                    break;
            }

            test.children.forEach((test) => queue.push(test));
        }
        if (!testCases) {
            vscode.window.showInformationMessage("Nothing was run because all test cases were filtered out.");
            return;
        }
        let firstTestCase = testCases[0];
        let uri = firstTestCase.uri;

        let workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            let folders = vscode.workspace.workspaceFolders;
            if (folders) {
                // Use the currently opened folder.
                workspaceFolder = folders[0];
            }
        }

        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Unable to launch because workspace folder is not available.");
            return;
        }

        const runId = nextRunId();
        runIdToTestRun.set(runId, run);
        // Make sure to end the run after all tests have been executed:

        let launched = await launch(workspaceFolder, runId, testCases, shouldDebug);
        if (!launched) {
            handleTestRunFinished(runId);
        }
        // For each test we need to call something as:
        // const start = Date.now();
        // run.started();
        // run.passed(test, Date.now() - start);
        // run.failed(test, new vscode.TestMessage(e.message), Date.now() - start);

        // When finished:
        // run.end();
    }

    async function launch(
        workspaceFolder: vscode.WorkspaceFolder,
        runId: string,
        testCases: vscode.TestItem[],
        shouldDebug: boolean
    ): Promise<boolean> {
        let cwd: string;
        let launchTemplate: vscode.DebugConfiguration = undefined;
        cwd = workspaceFolder.uri.fsPath;
        launchTemplate = await readLaunchTemplate(workspaceFolder);

        let args: string[] = [];
        let targets = new Set();

        // We want the events both in run and debug in this case.
        args.push("--listener=robotframework_debug_adapter.events_listener.EventsListenerV2");

        for (const test of testCases) {
            const data = testData.get(test);
            if (data === undefined) {
                OUTPUT_CHANNEL.appendLine("Unable to get data for: " + test.id);
                continue;
            }
            targets.add(test.uri.fsPath);
            args.push("-t");
            args.push(data.testInfo.name);
        }

        const targetsAsArray = [];
        for (const t of targets) {
            targetsAsArray.push(t);
        }

        let debugConfiguration: vscode.DebugConfiguration = {
            "type": "robotframework-lsp",
            "runId": runId,
            "name": "Robot Framework: Launch " + runId,
            "request": "launch",
            "cwd": cwd,
            "target": targetsAsArray[0], // TODO: Handle multiple targets.
            "terminal": "integrated",
            "env": {},
            "args": args,
        };

        if (launchTemplate) {
            for (var key of Object.keys(launchTemplate)) {
                if (key !== "type" && key !== "name" && key !== "request") {
                    let value = launchTemplate[key];
                    if (value !== undefined) {
                        if (key === "args") {
                            try {
                                debugConfiguration.args = debugConfiguration.args.concat(value);
                            } catch (err) {
                                logError(
                                    "Unable to concatenate: " + debugConfiguration.args + " to: " + value,
                                    err,
                                    "RUN_CONCAT_ARGS"
                                );
                            }
                        } else {
                            debugConfiguration[key] = value;
                        }
                    }
                }
            }
        }

        let debugSessionOptions: vscode.DebugSessionOptions = { "noDebug": !shouldDebug };
        let started = await vscode.debug.startDebugging(workspaceFolder, debugConfiguration, debugSessionOptions);
        return started;
    }

    const runProfile = controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request, token) => {
        runHandler(false, request, token);
    });

    const debugProfile = controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, (request, token) => {
        runHandler(true, request, token);
    });

    function handleTestRunFinished(runId: string) {
        if (runIdToDebugSession.has(runId)) {
            runIdToDebugSession.delete(runId);
        }
        if (runIdToTestRun.has(runId)) {
            const testRun = runIdToTestRun.get(runId);
            runIdToTestRun.delete(runId);
            testRun.end();
        }
    }

    function isRelatedSession(session: vscode.DebugSession) {
        return session.configuration.type === "robotframework-lsp" && session.configuration.runId !== undefined;
    }

    vscode.debug.onDidStartDebugSession((session: vscode.DebugSession) => {
        if (isRelatedSession(session)) {
            OUTPUT_CHANNEL.appendLine("Started testview debug session " + session.configuration.runId);
            if (runIdToTestRun.has(session.configuration.runId)) {
                runIdToDebugSession.set(session.configuration.runId, session);
            }
        }
    });

    vscode.debug.onDidTerminateDebugSession((session: vscode.DebugSession) => {
        if (isRelatedSession(session)) {
            handleTestRunFinished(session.configuration.runId);
        }
    });

    vscode.debug.onDidReceiveDebugSessionCustomEvent((event: vscode.DebugSessionCustomEvent) => {
        if (isRelatedSession(event.session)) {
            OUTPUT_CHANNEL.appendLine("Received event: " + event.event + " -- " + JSON.stringify(event.body));
            const runId = event.session.configuration.runId;
            const testRun = runIdToTestRun.get(runId);
            if (testRun) {
                switch (event.event) {
                    case "startSuite":
                        handleSuiteStart(testRun, event);
                        break;
                    case "endSuite":
                        handleSuiteEnd(testRun, event);
                        break;
                    case "startTest":
                        handleTestStart(testRun, event);
                        break;
                    case "endTest":
                        handleTestEnd(testRun, event);
                        break;
                }
            }
        }
    });
}

function handleSuiteStart(testRun: vscode.TestRun, event: vscode.DebugSessionCustomEvent) {
    const uriStr = vscode.Uri.file(event.body.source).toString();
    const testNames: string[] = event.body.tests;
    for (const testName of testNames) {
        const testId = computeTestId(uriStr, testName);
        const testItem = testItemIdToTestItem.get(testId);
        if (!testItem) {
            OUTPUT_CHANNEL.appendLine("Did not find test item: " + testId);
            continue;
        } else {
            testRun.enqueued(testItem);
        }
    }
}

function handleTestStart(testRun: vscode.TestRun, event: vscode.DebugSessionCustomEvent) {
    const testUriStr = vscode.Uri.file(event.body.source).toString();
    const testName = event.body.name;
    const testId = computeTestId(testUriStr, testName);
    const testItem = testItemIdToTestItem.get(testId);
    if (!testItem) {
        OUTPUT_CHANNEL.appendLine("Did not find test item: " + testId);
    } else {
        testRun.started(testItem);
    }
}

function failedKeywordsToTestMessage(event: vscode.DebugSessionCustomEvent): vscode.TestMessage[] {
    let messages: vscode.TestMessage[] = [];
    let msg = event.body.message;
    if (!msg) {
        msg = "";
    }
    let failedKeywords = event.body.failed_keywords;
    if (failedKeywords) {
        for (const failed of failedKeywords) {
            // "name": name,
            // "source": source,
            // "lineno": lineno,
            // "failure_messages": self._keyword_failure_messages,
            let errorMsg = "";
            for (const s of failed.failure_messages) {
                errorMsg += s;
            }

            if (failed.source) {
                messages.push({
                    "message": errorMsg,
                    "location": {
                        "uri": vscode.Uri.file(failed.source),
                        "range": new vscode.Range(
                            new vscode.Position(failed.lineno - 1, 0),
                            new vscode.Position(failed.lineno - 1, 0)
                        ),
                    },
                });
            } else {
                if (msg.length == 0) {
                    msg += "\n";
                }
                msg += errorMsg;
            }
        }
    }
    messages.push({
        "message": msg,
    });
    return messages;
}

function handleSuiteEnd(testRun: vscode.TestRun, event: vscode.DebugSessionCustomEvent) {
    const uriStr = vscode.Uri.file(event.body.source).toString();
    const testItem = testItemIdToTestItem.get(uriStr);
    markTestRun(testItem, uriStr, testRun, event);
}

function handleTestEnd(testRun: vscode.TestRun, event: vscode.DebugSessionCustomEvent) {
    const testUriStr = vscode.Uri.file(event.body.source).toString();
    const testName = event.body.name;
    const testId = computeTestId(testUriStr, testName);
    const testItem = testItemIdToTestItem.get(testId);
    markTestRun(testItem, testId, testRun, event);
}

function markTestRun(
    testItem: vscode.TestItem,
    testId: string,
    testRun: vscode.TestRun,
    event: vscode.DebugSessionCustomEvent
) {
    if (!testItem) {
        OUTPUT_CHANNEL.appendLine("Did not find test item: " + testId);
    } else {
        switch (event.body.status) {
            case "SKIP":
                testRun.skipped(testItem);
                break;
            case "PASS":
                testRun.passed(testItem, event.body.elapsedtime);
                break;
            case "FAIL":
                testRun.failed(testItem, failedKeywordsToTestMessage(event), event.body.elapsedtime);
                break;
            default:
                testRun.errored(testItem, failedKeywordsToTestMessage(event), event.body.elapsedtime);
                break;
        }
    }
}
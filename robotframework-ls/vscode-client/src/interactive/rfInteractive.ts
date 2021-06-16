/**
 * The idea is doing an interactive shell for Robot Framework inside of VSCode.
 *
 * There is previous work on this in https://github.com/microsoft/vscode-jupyter.
 * 
 * Interesting docs related to webviews:
 * https://medium.com/younited-tech-blog/reactception-extending-vs-code-extension-with-webviews-and-react-12be2a5898fd
 * https://github.com/Ciaanh/reactception/
 * https://code.visualstudio.com/api/extension-guides/webview
 * https://marketplace.visualstudio.com/items?itemName=leocll.vscode-extension-webview-template
 * https://github.com/leocll/vscode-extension-webview-template
 */

import { commands, ExtensionContext, WebviewPanel, window } from "vscode";
import * as vscode from 'vscode';

let DEV = 1;
function getWebviewOptions(localResourceRoot: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
        // Enable javascript in the webview
        enableScripts: true,

        // We may have a lot of context in the interactive shell webview, and it may be tricky to save/restore it all.
        retainContextWhenHidden: true,

        // And restrict the webview to only loading content from our extension's directory.
        localResourceRoots: [localResourceRoot]
    };
}

let _consoleId = 0;
function nextConsoleId() {
    _consoleId += 1;
    return _consoleId;
}


class InteractiveShellPanel {
    // public static currentPanel: InteractiveShellPanel | undefined;

    public static readonly viewType = 'InteractiveShellPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _consoleId: number;
    private readonly _localResourceRoot: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private _lastMessageId: number = 0;

    nextMessageSeq(): number {
        this._lastMessageId += 1;
        return this._lastMessageId;
    }

    public static async createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        // if (InteractiveShellPanel.currentPanel) {
        //     InteractiveShellPanel.currentPanel._panel.reveal(column);
        //     return;
        // }

        let localResourceRoot = extensionUri;
        if (DEV) {
            localResourceRoot = vscode.Uri.file("X:/vscode-robot/robotframework-lsp/robotframework-interactive/vscode-interpreter-webview/dist")
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            InteractiveShellPanel.viewType,
            'Robot Framework Interpreter',
            column || vscode.ViewColumn.One,
            getWebviewOptions(localResourceRoot),
        );

        // InteractiveShellPanel.currentPanel = new InteractiveShellPanel(panel, localResourceRoot);
        new InteractiveShellPanel(panel, localResourceRoot);
    }

    private constructor(panel: vscode.WebviewPanel, localResourceRoot: vscode.Uri) {
        this._panel = panel;
        this._localResourceRoot = localResourceRoot;
        this._consoleId = nextConsoleId();

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'evaluate':
                        // TODO: Actually handle on language server.
                        let response = {
                            type: 'response',
                            seq: this.nextMessageSeq(),
                            command: message.command,
                            request_seq: message.seq,
                            body: 'from vscode'
                        }
                        this._panel.webview.postMessage(response);
                        return;
                }
            },
            null,
            this._disposables
        );
    }


    public dispose() {
        // InteractiveShellPanel.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Note: we can't really load from file://
        // See: https://github.com/microsoft/vscode/issues/87282
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._localResourceRoot, 'bundle.js'));
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Robot Interactive Interpreter</title>
                <script>
                const vscode = acquireVsCodeApi();
                </script>
                <script defer src="${scriptUri}"></script>
            </head>
			<body style="overflow: hidden">
			</body>
			</html>`;
    }
}

export async function registerInteractiveCommands(context: ExtensionContext) {
    let extensionUri = context.extensionUri;

    async function createInteractiveShell() {
        // If we already have a panel, show it.
        await InteractiveShellPanel.createOrShow(extensionUri);
    }
    context.subscriptions.push(commands.registerCommand('robot.interactiveShell', createInteractiveShell));
}
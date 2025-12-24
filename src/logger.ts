import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Icon Preview');
    context.subscriptions.push(outputChannel);
}

export function log(message: string): void {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}

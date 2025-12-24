import * as vscode from 'vscode';
import { initLogger, log } from './logger';
import { initCacheDir, cleanupOldCache } from './cache';
import { updateDecorations, clearDecorations } from './decorations';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    initLogger(context);
    log('Extension activated');

    // 캐시 디렉토리 초기화 및 오래된 캐시 정리 (비동기, non-blocking)
    initCacheDir().then(() => {
        cleanupOldCache();
    });

    // 활성 에디터 변경 시
    vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            if (editor) {
                updateDecorations(editor);
            }
        },
        null,
        context.subscriptions
    );

    // 문서 변경 시 (debounce)
    let timeout: NodeJS.Timeout | undefined;
    vscode.workspace.onDidChangeTextDocument(
        (event) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                if (timeout) {
                    clearTimeout(timeout);
                }
                timeout = setTimeout(() => updateDecorations(editor), 500);
            }
        },
        null,
        context.subscriptions
    );

    // 초기 실행
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }
}

export function deactivate(): void {
    clearDecorations();
}

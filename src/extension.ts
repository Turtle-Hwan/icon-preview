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

    // 테마 변경 시 데코레이션 새로 적용 (배경색 변경을 위해)
    vscode.window.onDidChangeActiveColorTheme(
        () => {
            clearDecorations();
            vscode.window.visibleTextEditors.forEach((editor) => {
                updateDecorations(editor);
            });
        },
        null,
        context.subscriptions
    );

    // 초기 실행: 현재 열려있는 모든 에디터에 대해 데코레이션 적용
    // 약간의 딜레이를 주어 에디터가 완전히 준비된 후 실행
    setTimeout(() => {
        // 모든 visible 에디터에 대해 적용
        vscode.window.visibleTextEditors.forEach((editor) => {
            updateDecorations(editor);
        });
    }, 100);
}

export function deactivate(): void {
    clearDecorations();
}

import * as vscode from 'vscode';
import { log } from './logger';
import { getConfig } from './config';
import { downloadImage } from './imageDownloader';
import { findImportedSymbolsWithPreview, SymbolInfo } from './symbolResolver';

const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

export function clearDecorations(): void {
    decorationTypes.forEach((decorationType) => {
        decorationType.dispose();
    });
    decorationTypes.clear();
}

export async function updateDecorations(editor: vscode.TextEditor): Promise<void> {
    const config = getConfig();
    if (!config.enabled) {
        return;
    }

    const document = editor.document;

    // JS/TS/JSX/TSX 파일만 처리
    const validLanguages = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
    if (!validLanguages.includes(document.languageId)) {
        return;
    }

    log(`Processing file: ${document.fileName} (${document.languageId})`);

    // 기존 데코레이션 정리
    decorationTypes.forEach((decorationType, key) => {
        if (key.startsWith(document.uri.toString())) {
            editor.setDecorations(decorationType, []);
            decorationType.dispose();
            decorationTypes.delete(key);
        }
    });

    try {
        const symbols = await findImportedSymbolsWithPreview(document);
        log(`Found ${symbols.length} symbols with @preview`);

        for (const symbolInfo of symbols) {
            try {
                const imagePath = await downloadImage(symbolInfo.url);
                const key = `${document.uri.toString()}:${symbolInfo.line}:${symbolInfo.column}`;

                let decorationType: vscode.TextEditorDecorationType;
                let range: vscode.Range;

                if (config.position === 'inline') {
                    // inline 모드: 컴포넌트명 바로 뒤에 아이콘 표시 (글자 크기와 동일)
                    decorationType = vscode.window.createTextEditorDecorationType({
                        after: {
                            contentIconPath: vscode.Uri.file(imagePath),
                            margin: '0 1ch 0 1ch',
                            width: '1ch',
                            height: '1ch',
                        },
                    });
                    // 컴포넌트명 끝 위치에 range 설정
                    range = new vscode.Range(
                        symbolInfo.line,
                        symbolInfo.column,
                        symbolInfo.line,
                        symbolInfo.column
                    );
                } else {
                    // gutter 모드: VSCode 공식 gutterIconPath 사용
                    decorationType = vscode.window.createTextEditorDecorationType({
                        gutterIconPath: vscode.Uri.file(imagePath),
                        gutterIconSize: 'contain',
                    });
                    const line = document.lineAt(symbolInfo.line);
                    range = new vscode.Range(symbolInfo.line, 0, symbolInfo.line, line.text.length);
                }

                decorationTypes.set(key, decorationType);

                editor.setDecorations(decorationType, [
                    {
                        range,
                        hoverMessage: new vscode.MarkdownString(`![preview](${symbolInfo.url})`),
                    },
                ]);
                log(`Decoration applied at line ${symbolInfo.line}, col ${symbolInfo.column} (${config.position}) for: ${symbolInfo.url}`);
            } catch (error) {
                log(`Failed to load image for line ${symbolInfo.line}: ${error}`);
            }
        }
    } catch (error) {
        log(`Error processing file: ${error}`);
    }
}

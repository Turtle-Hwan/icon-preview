import * as vscode from 'vscode';
import { log } from './logger';
import { getConfig } from './config';
import { downloadImage } from './imageDownloader';
import { findImportedSymbolsWithPreview } from './symbolResolver';

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
        const previewUrls = await findImportedSymbolsWithPreview(document);
        log(`Found ${previewUrls.size} symbols with @preview`);

        for (const [lineIndex, url] of previewUrls) {
            try {
                const imagePath = await downloadImage(url);
                const key = `${document.uri.toString()}:${lineIndex}`;

                let decorationType: vscode.TextEditorDecorationType;

                if (config.position === 'inline') {
                    decorationType = vscode.window.createTextEditorDecorationType({
                        before: {
                            contentIconPath: vscode.Uri.file(imagePath),
                            width: `${config.imageSize}px`,
                            height: `${config.imageSize}px`,
                            textDecoration: `none; position: absolute; z-index: 1; margin-top: -${config.imageSize}px; pointer-events: none;`,
                        },
                    });
                } else {
                    decorationType = vscode.window.createTextEditorDecorationType({
                        gutterIconPath: vscode.Uri.file(imagePath),
                        gutterIconSize: 'contain',
                    });
                }

                decorationTypes.set(key, decorationType);

                const line = document.lineAt(lineIndex);
                const range = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);

                editor.setDecorations(decorationType, [
                    {
                        range,
                        hoverMessage: new vscode.MarkdownString(`![preview](${url})`),
                    },
                ]);
                log(`Decoration applied at line ${lineIndex} (${config.position}) for: ${url}`);
            } catch (error) {
                log(`Failed to load image for line ${lineIndex}: ${error}`);
            }
        }
    } catch (error) {
        log(`Error processing file: ${error}`);
    }
}

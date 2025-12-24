import * as vscode from 'vscode';
import { log } from './logger';

export async function findImportedSymbolsWithPreview(
    document: vscode.TextDocument
): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const text = document.getText();

    // 멀티라인 import 문에서 심볼 찾기 (개행 포함)
    const importRegex = /import\s+(?:(\w+)\s*,?\s*)?(?:{([\s\S]*?)})?[\s]*from\s*['"]([^'"]+)['"]/g;
    let importMatch: RegExpExecArray | null;

    const symbols: string[] = [];

    while ((importMatch = importRegex.exec(text))) {
        const defaultImport = importMatch[1];
        const namedImports = importMatch[2];
        const modulePath = importMatch[3];

        log(`Found import from "${modulePath}": default=${defaultImport}, named=${namedImports?.replace(/\s+/g, ' ')}`);

        if (defaultImport) {
            symbols.push(defaultImport);
        }
        if (namedImports) {
            const names = namedImports.split(',').map((s) => {
                const trimmed = s.trim();
                if (!trimmed) return '';
                const parts = trimmed.split(/\s+as\s+/);
                return parts[0].trim();
            });
            symbols.push(...names.filter((n) => n && /^[A-Z]/.test(n)));
        }
    }

    log(`Total symbols found: ${symbols.join(', ')}`);

    // 각 심볼에 대해 문서에서 사용 위치 찾기
    for (const symbol of symbols) {
        const usageRegex = new RegExp(`<${symbol}[\\s/>]`, 'g');
        let usageMatch: RegExpExecArray | null;

        while ((usageMatch = usageRegex.exec(text))) {
            const position = document.positionAt(usageMatch.index + 1);
            const line = position.line;

            if (result.has(line)) {
                continue;
            }

            try {
                const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                    'vscode.executeDefinitionProvider',
                    document.uri,
                    new vscode.Position(position.line, position.character)
                );

                log(`Definition result for ${symbol}: ${JSON.stringify(definitions?.length)} items`);

                if (definitions && definitions.length > 0) {
                    const def = definitions[0];
                    let targetUri: vscode.Uri;
                    if ('targetUri' in def) {
                        targetUri = def.targetUri;
                    } else if ('uri' in def) {
                        targetUri = def.uri;
                    } else {
                        log(`Unknown definition type for ${symbol}: ${JSON.stringify(def)}`);
                        continue;
                    }

                    log(`Definition for ${symbol}: ${targetUri.fsPath}`);
                    const defDoc = await vscode.workspace.openTextDocument(targetUri);
                    const defText = defDoc.getText();

                    // @preview URL 찾기
                    const symbolJsDocRegex = new RegExp(
                        `@(?:component\\s+)?@name\\s+${symbol}[\\s\\S]*?@preview\\s+!\\[img\\]\\((data:image[^)]+)\\)(?:\\s*-\\s*(https?://[^\\s*]+))?`,
                        'i'
                    );
                    let previewMatch = defText.match(symbolJsDocRegex);

                    if (!previewMatch) {
                        const simpleRegex = /@preview\s*(?:[—\-]+\s*)?(?:img\s*[—\-]*\s*)?(https?:\/\/[^\s\*\)]+)/i;
                        previewMatch = defText.match(simpleRegex);
                    }

                    if (previewMatch) {
                        const previewUrl = previewMatch[1].startsWith('data:') ? previewMatch[1] : previewMatch[1];
                        log(`Found @preview for ${symbol} at line ${line}: ${previewUrl.substring(0, 50)}...`);
                        result.set(line, previewUrl);
                    } else {
                        log(`No @preview found in definition for ${symbol}`);
                    }
                } else {
                    log(`No definition found for ${symbol}`);
                }
            } catch (error) {
                log(`Error getting definition for ${symbol}: ${error}`);
            }
        }
    }

    return result;
}

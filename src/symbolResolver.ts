import * as vscode from 'vscode';
import { log } from './logger';

export interface SymbolInfo {
    line: number;
    column: number; // 컴포넌트명 끝 위치
    url: string;
}

export async function findImportedSymbolsWithPreview(
    document: vscode.TextDocument
): Promise<SymbolInfo[]> {
    const result: SymbolInfo[] = [];
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

            // 컴포넌트명 끝 위치 계산: <Symbol 에서 Symbol 끝
            const componentEndColumn = position.character + symbol.length;

            // 이미 같은 위치에 있으면 스킵
            if (result.some((r) => r.line === line && r.column === componentEndColumn)) {
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
                    // 1. 먼저 심볼 이름이 정확히 일치하는 경우 찾기
                    const symbolJsDocRegex = new RegExp(
                        `@(?:component\\s+)?@name\\s+${symbol}[\\s\\S]*?@preview\\s+!\\[img\\]\\((data:image[^)]+)\\)(?:\\s*-\\s*(https?://[^\\s*]+))?`,
                        'i'
                    );
                    let previewMatch = defText.match(symbolJsDocRegex);

                    // 2. 심볼 이름이 정확히 일치하지 않으면 일반적인 @preview 패턴 찾기
                    if (!previewMatch) {
                        // import한 심볼이 정의 파일에 존재하는지 확인 (alias 등을 고려)
                        const symbolExistsRegex = new RegExp(`(?:export\\s+)?(?:const|function|class)\\s+${symbol}\\b`, 'm');
                        if (symbolExistsRegex.test(defText)) {
                            // 심볼이 존재하면 가장 가까운 @preview 찾기
                            const simpleRegex = /@preview\s*(?:[—\-]+\s*)?(?:img\s*[—\-]*\s*)?(https?:\/\/[^\s\*\)]+)/i;
                            previewMatch = defText.match(simpleRegex);
                        }
                    }

                    if (previewMatch) {
                        const previewUrl = previewMatch[1].startsWith('data:') ? previewMatch[1] : previewMatch[1];
                        log(`Found @preview for ${symbol} at line ${line}, col ${componentEndColumn}: ${previewUrl.substring(0, 50)}...`);
                        result.push({ line, column: componentEndColumn, url: previewUrl });
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

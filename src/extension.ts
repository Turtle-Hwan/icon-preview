import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// 캐시 디렉토리
const cacheDir = path.join(os.tmpdir(), 'icon-preview-cache');

// 데코레이션 타입 맵 (파일+라인별로 관리)
const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

// Output channel for debugging
let outputChannel: vscode.OutputChannel;

function log(message: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Icon Preview');
    context.subscriptions.push(outputChannel);

    log('Extension activated');

    // 캐시 디렉토리 생성
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    log(`Cache directory: ${cacheDir}`);

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

/**
 * URL 변환 함수 (lucide.dev 등 특수 URL 처리)
 */
function transformUrl(url: string): string {
    // lucide.dev/icons/icon-name -> CDN SVG URL로 변환
    const lucideMatch = url.match(/lucide\.dev\/icons\/([a-z0-9-]+)/i);
    if (lucideMatch) {
        const iconName = lucideMatch[1];
        return `https://unpkg.com/lucide-static@latest/icons/${iconName}.svg`;
    }
    return url;
}

/**
 * SVG의 currentColor를 실제 색상으로 변환
 */
function processSvgContent(content: string, color: string = '#ffffff'): string {
    let processed = content.replace(/currentColor/gi, color);
    if (!processed.includes('stroke=') && !processed.includes('fill=')) {
        processed = processed.replace('<svg', `<svg fill="${color}"`);
    }
    return processed;
}

/**
 * HTTP(S) 요청으로 데이터 가져오기
 */
function fetchUrl(url: string): Promise<{ data: Buffer; contentType: string }> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const request = protocol.get(url, (response) => {
            if ((response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) && response.headers.location) {
                let redirectUrl = response.headers.location;
                if (redirectUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                }
                log(`Redirecting to: ${redirectUrl}`);
                fetchUrl(redirectUrl).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const data = Buffer.concat(chunks);
                const contentType = response.headers['content-type'] || '';
                resolve({ data, contentType });
            });
            response.on('error', reject);
        });

        request.on('error', reject);
        request.setTimeout(10000, () => {
            request.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * 이미지 다운로드 함수
 */
async function downloadImage(originalUrl: string): Promise<string> {
    // data:image URL 처리
    if (originalUrl.startsWith('data:image')) {
        const hash = crypto.createHash('md5').update(originalUrl).digest('hex');
        const match = originalUrl.match(/^data:image\/([^;]+);base64,(.+)$/);
        if (match) {
            const mimeType = match[1];
            const ext = mimeType === 'svg+xml' ? 'svg' : mimeType;
            const base64Data = match[2];
            const filePath = path.join(cacheDir, `${hash}.${ext}`);

            if (fs.existsSync(filePath)) {
                log(`Cache hit (data URL): ${filePath}`);
                return filePath;
            }

            const buffer = Buffer.from(base64Data, 'base64');
            if (ext === 'svg') {
                const config = vscode.workspace.getConfiguration('iconPreview');
                const svgColor = config.get<string>('svgColor', '#ffffff');
                const processedSvg = processSvgContent(buffer.toString('utf-8'), svgColor);
                fs.writeFileSync(filePath, processedSvg);
            } else {
                fs.writeFileSync(filePath, buffer);
            }
            log(`Saved data URL image to: ${filePath}`);
            return filePath;
        }
    }

    const url = transformUrl(originalUrl);
    log(`Downloading: ${url} (original: ${originalUrl})`);

    const hash = crypto.createHash('md5').update(url).digest('hex');
    const svgPath = path.join(cacheDir, `${hash}.svg`);
    const pngPath = path.join(cacheDir, `${hash}.png`);

    // 캐시 확인
    if (fs.existsSync(svgPath)) {
        log(`Cache hit: ${svgPath}`);
        return svgPath;
    }
    if (fs.existsSync(pngPath)) {
        log(`Cache hit: ${pngPath}`);
        return pngPath;
    }

    try {
        const { data, contentType } = await fetchUrl(url);
        log(`Fetched ${data.length} bytes, content-type: ${contentType}`);

        const dataStr = data.toString('utf-8');
        if (contentType.includes('svg') || url.endsWith('.svg') || dataStr.includes('<svg')) {
            const config = vscode.workspace.getConfiguration('iconPreview');
            const svgColor = config.get<string>('svgColor', '#ffffff');
            const processedSvg = processSvgContent(dataStr, svgColor);
            fs.writeFileSync(svgPath, processedSvg);
            log(`Saved SVG to: ${svgPath}`);
            return svgPath;
        } else {
            const ext = path.extname(new URL(url).pathname) || '.png';
            const filePath = path.join(cacheDir, `${hash}${ext}`);
            fs.writeFileSync(filePath, data);
            log(`Saved image to: ${filePath}`);
            return filePath;
        }
    } catch (error) {
        log(`Error downloading ${url}: ${error}`);
        throw error;
    }
}

/**
 * 파일에서 import 심볼들을 찾아서 정의 위치의 @preview URL을 가져옴
 */
async function findImportedSymbolsWithPreview(
    document: vscode.TextDocument
): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const text = document.getText();

    // 멀티라인 import 문에서 심볼 찾기 (개행 포함)
    // import { Foo, Bar } from 'xxx' 또는 import Foo from 'xxx'
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
            // { Foo, Bar as Baz, \n Qux } -> ['Foo', 'Bar', 'Qux']
            const names = namedImports.split(',').map((s) => {
                const trimmed = s.trim();
                if (!trimmed) return '';
                const parts = trimmed.split(/\s+as\s+/);
                return parts[0].trim();
            });
            symbols.push(...names.filter((n) => n && /^[A-Z]/.test(n))); // PascalCase만 (컴포넌트)
        }
    }

    log(`Total symbols found: ${symbols.join(', ')}`);

    // 각 심볼에 대해 문서에서 사용 위치 찾기
    for (const symbol of symbols) {
        // JSX에서 사용되는 패턴: <Symbol 또는 <Symbol> 또는 <Symbol />
        const usageRegex = new RegExp(`<${symbol}[\\s/>]`, 'g');
        let usageMatch: RegExpExecArray | null;

        while ((usageMatch = usageRegex.exec(text))) {
            const position = document.positionAt(usageMatch.index + 1); // '<' 다음 위치
            const line = position.line;

            // 이미 처리된 라인이면 스킵
            if (result.has(line)) {
                continue;
            }

            try {
                // 심볼 위치에서 정의로 이동
                const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                    'vscode.executeDefinitionProvider',
                    document.uri,
                    new vscode.Position(position.line, position.character)
                );

                log(`Definition result for ${symbol}: ${JSON.stringify(definitions?.length)} items`);

                if (definitions && definitions.length > 0) {
                    const def = definitions[0];
                    // Location 또는 LocationLink 처리
                    let targetUri: vscode.Uri;
                    if ('targetUri' in def) {
                        // LocationLink
                        targetUri = def.targetUri;
                    } else if ('uri' in def) {
                        // Location
                        targetUri = def.uri;
                    } else {
                        log(`Unknown definition type for ${symbol}: ${JSON.stringify(def)}`);
                        continue;
                    }

                    log(`Definition for ${symbol}: ${targetUri.fsPath}`);
                    const defDoc = await vscode.workspace.openTextDocument(targetUri);
                    const defText = defDoc.getText();

                    // @preview URL 찾기 - 심볼 이름으로 JSDoc 블록 찾기
                    // lucide-react 형식: @component @name ThumbsUp ... @preview ![img](data:...) - https://...
                    const symbolJsDocRegex = new RegExp(
                        `@(?:component\\s+)?@name\\s+${symbol}[\\s\\S]*?@preview\\s+!\\[img\\]\\((data:image[^)]+)\\)(?:\\s*-\\s*(https?://[^\\s*]+))?`,
                        'i'
                    );
                    let previewMatch = defText.match(symbolJsDocRegex);

                    // 일반 @preview URL 형식도 시도
                    if (!previewMatch) {
                        const simpleRegex = /@preview\s*(?:[—\-]+\s*)?(?:img\s*[—\-]*\s*)?(https?:\/\/[^\s\*\)]+)/i;
                        previewMatch = defText.match(simpleRegex);
                    }

                    if (previewMatch) {
                        // data:image URL 또는 https URL
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

/**
 * 데코레이션 업데이트
 */
async function updateDecorations(editor: vscode.TextEditor) {
    const config = vscode.workspace.getConfiguration('iconPreview');
    if (!config.get<boolean>('enabled', true)) {
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
        // import된 심볼들에서 @preview URL 찾기
        const previewUrls = await findImportedSymbolsWithPreview(document);
        log(`Found ${previewUrls.size} symbols with @preview`);

        const position = config.get<string>('position', 'gutter');
        const imageSize = config.get<number>('imageSize', 16);

        for (const [lineIndex, url] of previewUrls) {
            try {
                const imagePath = await downloadImage(url);
                const key = `${document.uri.toString()}:${lineIndex}`;

                let decorationType: vscode.TextEditorDecorationType;

                if (position === 'inline') {
                    // inline: 코드 앞에 인라인 아이콘 표시 (중단점과 겹치지 않음)
                    decorationType = vscode.window.createTextEditorDecorationType({
                        before: {
                            contentIconPath: vscode.Uri.file(imagePath),
                            margin: '0 4px 0 0',
                            width: `${imageSize}px`,
                            height: `${imageSize}px`,
                        },
                    });
                } else {
                    // gutter: 기존 gutter 위치에 표시 (중단점과 겹칠 수 있음)
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
                log(`Decoration applied at line ${lineIndex} (${position}) for: ${url}`);
            } catch (error) {
                log(`Failed to load image for line ${lineIndex}: ${error}`);
            }
        }
    } catch (error) {
        log(`Error processing file: ${error}`);
    }
}

export function deactivate() {
    decorationTypes.forEach((decorationType) => {
        decorationType.dispose();
    });
    decorationTypes.clear();
}

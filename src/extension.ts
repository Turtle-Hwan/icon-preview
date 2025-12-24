import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

interface PreviewMatch {
    lineIndex: number;
    url: string;
    start: number;
    end: number;
}

// 캐시 디렉토리
const cacheDir = path.join(os.tmpdir(), 'jsdoc-image-preview-cache');

// 데코레이션 타입 맵 (URL별로 관리)
const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

// 이미지 캐시 (URL -> 로컬 경로)
const imageCache = new Map<string, string>();

// Output channel for debugging
let outputChannel: vscode.OutputChannel;

function log(message: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('JSDoc Image Preview');
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
                timeout = setTimeout(() => updateDecorations(editor), 300);
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
 * JSDoc @preview 패턴을 찾는 함수
 */
function findPreviewMatches(document: vscode.TextDocument): PreviewMatch[] {
    const matches: PreviewMatch[] = [];
    const pattern = /@preview\s*(?:[—\-]+\s*)?(?:img\s*[—\-]*\s*)?(https?:\/\/[^\s\*\)]+)/gi;

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;

        while ((match = pattern.exec(line))) {
            const url = match[1];
            if (url) {
                matches.push({
                    lineIndex: i,
                    url: url,
                    start: match.index,
                    end: match.index + match[0].length,
                });
            }
        }
    }

    return matches;
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
    // currentColor를 실제 색상으로 변환
    let processed = content.replace(/currentColor/gi, color);
    // stroke나 fill이 없으면 추가
    if (!processed.includes('stroke=') && !processed.includes('fill=')) {
        processed = processed.replace('<svg', `<svg fill="${color}"`);
    }
    return processed;
}

/**
 * HTTP(S) 요청으로 데이터 가져오기
 */
function fetchUrl(url: string): Promise<{ data: string; contentType: string }> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const request = protocol.get(url, (response) => {
            // 리다이렉트 처리
            if ((response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) && response.headers.location) {
                let redirectUrl = response.headers.location;
                // 상대 경로 처리
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
                const data = Buffer.concat(chunks).toString('utf-8');
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
    const url = transformUrl(originalUrl);
    log(`Downloading: ${url} (original: ${originalUrl})`);

    // 캐시 확인
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const svgPath = path.join(cacheDir, `${hash}.svg`);

    if (fs.existsSync(svgPath)) {
        log(`Cache hit: ${svgPath}`);
        return svgPath;
    }

    try {
        const { data, contentType } = await fetchUrl(url);
        log(`Fetched ${data.length} bytes, content-type: ${contentType}`);

        // SVG인 경우 currentColor 처리
        if (contentType.includes('svg') || url.endsWith('.svg') || data.includes('<svg')) {
            const config = vscode.workspace.getConfiguration('jsdocImagePreview');
            const svgColor = config.get<string>('svgColor', '#ffffff');
            const processedSvg = processSvgContent(data, svgColor);
            fs.writeFileSync(svgPath, processedSvg);
            log(`Saved SVG to: ${svgPath}`);
            return svgPath;
        } else {
            // 일반 이미지
            const ext = path.extname(new URL(url).pathname) || '.png';
            const filePath = path.join(cacheDir, `${hash}${ext}`);
            fs.writeFileSync(filePath, data, 'binary');
            log(`Saved image to: ${filePath}`);
            return filePath;
        }
    } catch (error) {
        log(`Error downloading ${url}: ${error}`);
        throw error;
    }
}

/**
 * 데코레이션 업데이트
 */
async function updateDecorations(editor: vscode.TextEditor) {
    const config = vscode.workspace.getConfiguration('jsdocImagePreview');
    if (!config.get<boolean>('enabled', true)) {
        return;
    }

    const document = editor.document;
    const matches = findPreviewMatches(document);
    log(`Found ${matches.length} @preview matches in ${document.fileName}`);

    // 기존 데코레이션 정리
    decorationTypes.forEach((decorationType) => {
        editor.setDecorations(decorationType, []);
    });

    // 새 데코레이션 적용
    for (const match of matches) {
        try {
            log(`Processing: ${match.url} at line ${match.lineIndex}`);
            const imagePath = await downloadImage(match.url);

            // 기존 데코레이션 타입 dispose
            const existingType = decorationTypes.get(match.url);
            if (existingType) {
                existingType.dispose();
            }

            // 새 데코레이션 타입 생성
            const decorationType = vscode.window.createTextEditorDecorationType({
                gutterIconPath: vscode.Uri.file(imagePath),
                gutterIconSize: 'contain',
            });
            decorationTypes.set(match.url, decorationType);

            const range = new vscode.Range(
                match.lineIndex,
                match.start,
                match.lineIndex,
                match.end
            );

            editor.setDecorations(decorationType, [
                {
                    range,
                    hoverMessage: new vscode.MarkdownString(`![preview](${match.url})`),
                },
            ]);
            log(`Decoration applied for: ${match.url}`);
        } catch (error) {
            log(`Failed to load image: ${match.url} - ${error}`);
        }
    }
}

export function deactivate() {
    // 데코레이션 정리
    decorationTypes.forEach((decorationType) => {
        decorationType.dispose();
    });
    decorationTypes.clear();
}

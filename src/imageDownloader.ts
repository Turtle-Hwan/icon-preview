import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import { FetchResult } from './types';
import { log } from './logger';
import { cacheDir, fileExists, writeFile } from './cache';

function transformUrl(url: string): string {
    const lucideMatch = url.match(/lucide\.dev\/icons\/([a-z0-9-]+)/i);
    if (lucideMatch) {
        const iconName = lucideMatch[1];
        return `https://unpkg.com/lucide-static@latest/icons/${iconName}.svg`;
    }
    return url;
}

function isDarkTheme(): boolean {
    const theme = vscode.window.activeColorTheme.kind;
    // ColorThemeKind: Light = 1, Dark = 2, HighContrast = 3 (dark), HighContrastLight = 4
    return theme === vscode.ColorThemeKind.Dark || theme === vscode.ColorThemeKind.HighContrast;
}

function getSvgColor(): string {
    // 다크 테마면 흰색, 라이트 테마면 검정색
    return isDarkTheme() ? '#ffffff' : '#000000';
}

function processSvgContent(content: string, size?: number): string {
    const color = getSvgColor();
    let processed = content.replace(/currentColor/gi, color);
    if (!processed.includes('stroke=') && !processed.includes('fill=')) {
        processed = processed.replace('<svg', `<svg fill="${color}"`);
    }

    // inline 모드용으로 크기를 지정하면 SVG에 width/height 강제 적용
    if (size) {
        // 기존 width/height 속성 제거 후 새로 추가
        processed = processed.replace(/\s*width="[^"]*"/gi, '');
        processed = processed.replace(/\s*height="[^"]*"/gi, '');
        processed = processed.replace('<svg', `<svg width="${size}" height="${size}"`);
    }

    return processed;
}

function fetchUrl(url: string): Promise<FetchResult> {
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

function getThemeSuffix(): string {
    return isDarkTheme() ? 'dark' : 'light';
}

export async function downloadImage(originalUrl: string, inlineSize?: number): Promise<string> {
    const themeSuffix = getThemeSuffix();
    const sizeSuffix = inlineSize ? `-${inlineSize}px` : '';

    // data:image URL 처리
    if (originalUrl.startsWith('data:image')) {
        const hash = crypto.createHash('md5').update(originalUrl).digest('hex');
        const match = originalUrl.match(/^data:image\/([^;]+);base64,(.+)$/);
        if (match) {
            const mimeType = match[1];
            const ext = mimeType === 'svg+xml' ? 'svg' : mimeType;
            const base64Data = match[2];
            const filePath = path.join(cacheDir, `${hash}-${themeSuffix}${sizeSuffix}.${ext}`);

            if (await fileExists(filePath)) {
                log(`Cache hit (data URL): ${filePath}`);
                return filePath;
            }

            const buffer = Buffer.from(base64Data, 'base64');
            if (ext === 'svg') {
                const processedSvg = processSvgContent(buffer.toString('utf-8'), inlineSize);
                await writeFile(filePath, processedSvg);
            } else {
                await writeFile(filePath, buffer);
            }
            log(`Saved data URL image to: ${filePath}`);
            return filePath;
        }
    }

    const url = transformUrl(originalUrl);
    log(`Downloading: ${url} (original: ${originalUrl})`);

    const hash = crypto.createHash('md5').update(url).digest('hex');
    const svgPath = path.join(cacheDir, `${hash}-${themeSuffix}${sizeSuffix}.svg`);
    const pngPath = path.join(cacheDir, `${hash}-${themeSuffix}${sizeSuffix}.png`);

    // 캐시 확인
    if (await fileExists(svgPath)) {
        log(`Cache hit: ${svgPath}`);
        return svgPath;
    }
    if (await fileExists(pngPath)) {
        log(`Cache hit: ${pngPath}`);
        return pngPath;
    }

    try {
        const { data, contentType } = await fetchUrl(url);
        log(`Fetched ${data.length} bytes, content-type: ${contentType}`);

        const dataStr = data.toString('utf-8');
        if (contentType.includes('svg') || url.endsWith('.svg') || dataStr.includes('<svg')) {
            const processedSvg = processSvgContent(dataStr, inlineSize);
            await writeFile(svgPath, processedSvg);
            log(`Saved SVG to: ${svgPath}`);
            return svgPath;
        } else {
            const ext = path.extname(new URL(url).pathname) || '.png';
            const filePath = path.join(cacheDir, `${hash}-${themeSuffix}${sizeSuffix}${ext}`);
            await writeFile(filePath, data);
            log(`Saved image to: ${filePath}`);
            return filePath;
        }
    } catch (error) {
        log(`Error downloading ${url}: ${error}`);
        throw error;
    }
}

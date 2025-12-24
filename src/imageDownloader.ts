import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import { FetchResult } from './types';
import { log } from './logger';
import { getConfig } from './config';
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

function getContrastBackgroundColor(): string {
    return isDarkTheme() ? '#ffffff' : '#1e1e1e';
}

function addBackgroundToSvg(svg: string, bgColor: string): string {
    // viewBox 파싱
    const viewBoxMatch = svg.match(/viewBox=["']([^"']+)["']/);
    if (!viewBoxMatch) {
        // viewBox가 없으면 width/height에서 추론
        const widthMatch = svg.match(/width=["'](\d+)["']/);
        const heightMatch = svg.match(/height=["'](\d+)["']/);
        const width = widthMatch ? parseInt(widthMatch[1]) : 24;
        const height = heightMatch ? parseInt(heightMatch[1]) : 24;
        const bgRect = `<rect x="0" y="0" width="${width}" height="${height}" fill="${bgColor}" rx="2"/>`;
        return svg.replace(/<svg([^>]*)>/, `<svg$1>${bgRect}`);
    }

    const [minX, minY, vbWidth, vbHeight] = viewBoxMatch[1].split(/\s+/).map(Number);
    const bgRect = `<rect x="${minX}" y="${minY}" width="${vbWidth}" height="${vbHeight}" fill="${bgColor}" rx="2"/>`;
    return svg.replace(/<svg([^>]*)>/, `<svg$1>${bgRect}`);
}

function processSvgContent(content: string, color: string = '#ffffff'): string {
    let processed = content.replace(/currentColor/gi, color);
    if (!processed.includes('stroke=') && !processed.includes('fill=')) {
        processed = processed.replace('<svg', `<svg fill="${color}"`);
    }
    // 테마에 맞는 배경색 추가
    const bgColor = getContrastBackgroundColor();
    processed = addBackgroundToSvg(processed, bgColor);
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

export async function downloadImage(originalUrl: string): Promise<string> {
    const config = getConfig();
    const themeSuffix = getThemeSuffix();

    // data:image URL 처리
    if (originalUrl.startsWith('data:image')) {
        const hash = crypto.createHash('md5').update(originalUrl).digest('hex');
        const match = originalUrl.match(/^data:image\/([^;]+);base64,(.+)$/);
        if (match) {
            const mimeType = match[1];
            const ext = mimeType === 'svg+xml' ? 'svg' : mimeType;
            const base64Data = match[2];
            const filePath = path.join(cacheDir, `${hash}-${themeSuffix}.${ext}`);

            if (await fileExists(filePath)) {
                log(`Cache hit (data URL): ${filePath}`);
                return filePath;
            }

            const buffer = Buffer.from(base64Data, 'base64');
            if (ext === 'svg') {
                const processedSvg = processSvgContent(buffer.toString('utf-8'), config.svgColor);
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
    const svgPath = path.join(cacheDir, `${hash}-${themeSuffix}.svg`);
    const pngPath = path.join(cacheDir, `${hash}-${themeSuffix}.png`);

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
            const processedSvg = processSvgContent(dataStr, config.svgColor);
            await writeFile(svgPath, processedSvg);
            log(`Saved SVG to: ${svgPath}`);
            return svgPath;
        } else {
            const ext = path.extname(new URL(url).pathname) || '.png';
            const filePath = path.join(cacheDir, `${hash}-${themeSuffix}${ext}`);
            await writeFile(filePath, data);
            log(`Saved image to: ${filePath}`);
            return filePath;
        }
    } catch (error) {
        log(`Error downloading ${url}: ${error}`);
        throw error;
    }
}

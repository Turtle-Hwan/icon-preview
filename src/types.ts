import * as vscode from 'vscode';

export interface ExtensionConfig {
    enabled: boolean;
    imageSize: number;
    svgColor: string;
    position: 'gutter' | 'inline';
    cacheMaxAgeDays: number;
}

export interface FetchResult {
    data: Buffer;
    contentType: string;
}

export interface DecorationInfo {
    type: vscode.TextEditorDecorationType;
    line: number;
}

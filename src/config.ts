import * as vscode from 'vscode';
import { ExtensionConfig } from './types';

export function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('iconPreview');
    const editorConfig = vscode.workspace.getConfiguration('editor');
    const editorFontSize = editorConfig.get<number>('fontSize') || 14;

    return {
        enabled: config.get<boolean>('enabled', true),
        imageSize: config.get<number>('imageSize', editorFontSize),
        svgColor: config.get<string>('svgColor', '#ffffff'),
        position: config.get<'gutter' | 'inline'>('position', 'gutter'),
        cacheMaxAgeDays: config.get<number>('cacheMaxAgeDays', 7),
    };
}

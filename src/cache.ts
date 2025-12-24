import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';
import { getConfig } from './config';

export const cacheDir = path.join(os.tmpdir(), 'icon-preview-cache');

export async function initCacheDir(): Promise<void> {
    try {
        await fs.mkdir(cacheDir, { recursive: true });
        log(`Cache directory: ${cacheDir}`);
    } catch (error) {
        log(`Error creating cache directory: ${error}`);
    }
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function writeFile(filePath: string, data: string | Buffer): Promise<void> {
    await fs.writeFile(filePath, data);
}

export async function cleanupOldCache(): Promise<void> {
    const config = getConfig();
    const maxAgeDays = config.cacheMaxAgeDays;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
        const files = await fs.readdir(cacheDir);
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(cacheDir, file);
            try {
                const stat = await fs.stat(filePath);
                const fileAge = now - stat.mtimeMs;

                if (fileAge > maxAgeMs) {
                    await fs.unlink(filePath);
                    deletedCount++;
                }
            } catch (error) {
                log(`Error checking/deleting cache file ${file}: ${error}`);
            }
        }

        if (deletedCount > 0) {
            log(`Cleaned up ${deletedCount} old cache files (older than ${maxAgeDays} days)`);
        }
    } catch (error) {
        log(`Error cleaning up cache: ${error}`);
    }
}

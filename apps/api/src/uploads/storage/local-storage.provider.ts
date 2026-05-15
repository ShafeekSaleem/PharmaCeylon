import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StorageProvider } from './storage.interface';

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly root = path.join(process.cwd(), 'storage', 'uploads');

  async save(buffer: Buffer, filename: string, folder: string): Promise<string> {
    const dir = path.join(this.root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
    return `/uploads/${folder}/${filename}`;
  }

  async delete(url: string): Promise<void> {
    const relative = url.replace(/^\/uploads\//, '');
    const filePath = path.join(this.root, relative);
    await fs.unlink(filePath).catch(() => {});
  }
}

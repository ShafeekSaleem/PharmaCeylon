/// <reference types="multer" />
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { STORAGE_PROVIDER, StorageProvider } from './storage/storage.interface';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

@Injectable()
export class UploadsService {
  constructor(
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
  ) {}

  async uploadImage(
    file: Express.Multer.File,
    folder: string,
  ): Promise<{ url: string; thumbUrl: string }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Allowed: jpeg, png, webp',
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('File size exceeds 2 MB limit');
    }

    const id = crypto.randomUUID();
    const mainFilename = `${id}.webp`;
    const thumbFilename = `${id}_thumb.webp`;

    const mainBuffer = await sharp(file.buffer)
      .resize({ width: 800, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const thumbBuffer = await sharp(file.buffer)
      .resize({ width: 80, height: 80, fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();

    const [url, thumbUrl] = await Promise.all([
      this.storage.save(mainBuffer, mainFilename, folder),
      this.storage.save(thumbBuffer, thumbFilename, folder),
    ]);

    return { url, thumbUrl };
  }

  async deleteImage(url: string): Promise<void> {
    await this.storage.delete(url);
    if (url.endsWith('.webp') && !url.endsWith('_thumb.webp')) {
      await this.storage.delete(url.replace(/\.webp$/, '_thumb.webp'));
    }
  }
}

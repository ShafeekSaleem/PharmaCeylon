export interface StorageProvider {
  save(buffer: Buffer, filename: string, folder: string): Promise<string>;
  delete(url: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

import { Module } from '@nestjs/common';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { STORAGE_PROVIDER } from './storage/storage.interface';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useClass: LocalStorageProvider,
    },
    UploadsService,
  ],
  controllers: [UploadsController],
  exports: [UploadsService],
})
export class UploadsModule {}

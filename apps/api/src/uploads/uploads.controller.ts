/// <reference types="multer" />
import {
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermission } from '../security/decorators/require-permission.decorator';
import { UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @RequirePermission('uploads.image')
  @UseInterceptors(FileInterceptor('file'))
  @Post('image')
  uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Query('context') context = 'products',
  ) {
    return this.uploads.uploadImage(file, context);
  }
}

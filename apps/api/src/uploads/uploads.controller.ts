/// <reference types="multer" />
import {
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RoleName } from '@prisma/client';
import { Roles } from '../security/decorators/roles.decorator';
import { UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.inventory_clerk,
    RoleName.pharmacist,
  )
  @UseInterceptors(FileInterceptor('file'))
  @Post('image')
  uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Query('context') context = 'products',
  ) {
    return this.uploads.uploadImage(file, context);
  }
}

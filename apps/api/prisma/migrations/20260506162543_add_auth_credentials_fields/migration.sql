/*
  Warnings:

  - Added the required column `password_hash` to the `app_user` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "password_hash" TEXT NOT NULL,
ADD COLUMN     "refresh_token_hash" TEXT;

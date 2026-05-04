/*
  Warnings:

  - You are about to drop the column `caption` on the `Post` table. All the data in the column will be lost.
  - You are about to drop the column `imageUrl` on the `Post` table. All the data in the column will be lost.
  - You are about to drop the column `matchId` on the `Post` table. All the data in the column will be lost.
  - Added the required column `postDate` to the `Post` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_matchId_fkey";

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "awayLogo" TEXT,
ADD COLUMN     "homeLogo" TEXT;

-- AlterTable
ALTER TABLE "Post" DROP COLUMN "caption",
DROP COLUMN "imageUrl",
DROP COLUMN "matchId",
ADD COLUMN     "postDate" TEXT NOT NULL,
ADD COLUMN     "telegramFileId" TEXT;

-- CreateTable
CREATE TABLE "Background" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "lastUsedDate" TEXT,

    CONSTRAINT "Background_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Background_filename_key" ON "Background"("filename");

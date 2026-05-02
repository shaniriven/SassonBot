ALTER TABLE "League" ADD COLUMN "seasonApiId" INTEGER;
CREATE UNIQUE INDEX "League_seasonApiId_key" ON "League"("seasonApiId");

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

// 「你是 AI 嗎」的固定圖片（AC-7）。圖片有版權，不進 Git：scripts/support-assets.sh 從 repo 外複製過來
const FILES: Record<string, string> = { 'super-ai': 'super-ai.jpeg' };

@Controller('api/assets')
export class AssetsController {
  @Get(':key')
  get(@Param('key') key: string, @Res() res: Response) {
    const file = Object.hasOwn(FILES, key)
      ? join(process.cwd(), 'assets', FILES[key])
      : null;
    if (!file || !existsSync(file)) throw new NotFoundException();
    res.sendFile(file);
  }
}

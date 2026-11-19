import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  MethodNotAllowedException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunTokenService } from './run-token.service.js';
import { ToolsService } from './tools.service.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * MCP（Streamable HTTP）的最小實作，只給這台服務自己的 CLI 用。
 * 只接受這次執行的 run token；工具清單依 token 裡的角色決定
 */
@Controller('mcp')
export class McpController {
  constructor(
    @Inject(RunTokenService) private readonly tokens: RunTokenService,
    @Inject(ToolsService) private readonly tools: ToolsService,
  ) {}

  @Get()
  get() {
    throw new MethodNotAllowedException(); // 不提供伺服器推送
  }

  @Post()
  @HttpCode(200)
  async post(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const ctx = this.tokens.verify(token);
    if (!ctx)
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
      });

    const msg = (body ?? {}) as RpcRequest;
    if (
      Array.isArray(body) ||
      msg.jsonrpc !== '2.0' ||
      typeof msg.method !== 'string'
    ) {
      return res.json({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32600, message: 'Invalid Request' },
      });
    }
    if (msg.id === undefined) return res.status(202).end(); // 通知不用回應
    const reply = (result: unknown) =>
      res.json({ jsonrpc: '2.0', id: msg.id, result });

    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion:
            typeof msg.params?.protocolVersion === 'string'
              ? msg.params.protocolVersion
              : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'support', version: '1.0.0' },
        });
      case 'tools/list':
        return reply({ tools: this.tools.listFor(ctx.role) });
      case 'tools/call': {
        const { content, isError } = await this.tools.call(
          ctx,
          typeof msg.params?.name === 'string' ? msg.params.name : '',
          msg.params?.arguments,
        );
        return reply({ content: [{ type: 'text', text: content }], isError });
      }
      default:
        // 未知方法一定要回錯誤：CLI 連線時會先送版本探測，不回應要白等 5 秒（AIC-001 實測）
        return res.json({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        });
    }
  }
}

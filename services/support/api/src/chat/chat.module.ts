import { Module } from '@nestjs/common';
import { AskService } from '../ask/ask.service.js';
import { AiRunLog } from '../audit/ai-run-log.js';
import { AuthModule } from '../auth/auth.module.js';
import { HandoffService } from '../handoff/handoff.service.js';
import { JoinService } from '../join/join.service.js';
import { ProposalController } from '../proposals/proposal.controller.js';
import { ProposalService } from '../proposals/proposal.service.js';
import { TraceController } from '../trace/trace.controller.js';
import { ToolsModule } from '../tools/tools.module.js';
import {
  ConsoleController,
  ConversationController,
} from './chat.controller.js';
import { CustomerGateway, StaffGateway } from './chat.gateways.js';
import { ChatRealtime } from './chat.realtime.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [AuthModule, ToolsModule],
  controllers: [
    ConversationController,
    ConsoleController,
    ProposalController,
    TraceController,
  ],
  providers: [
    ChatService,
    ChatRealtime,
    CustomerGateway,
    StaffGateway,
    AskService,
    AiRunLog,
    HandoffService,
    JoinService,
    ProposalService,
  ],
})
export class ChatModule {}

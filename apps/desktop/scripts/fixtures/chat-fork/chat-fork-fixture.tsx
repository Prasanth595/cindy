import { mountPage } from '../../ui-page/harness';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { AssistantMessage } from '../../../src/renderer/components/chat/AssistantMessage';
void mountPage({
  route: '/cc-agent/shared-task',
  host: { maker: { getCapabilities: async () => ({ availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [], fork: { supported: true }, rewind: { supported: false } }) } },
  render: (ctx) => <div className="p-8 space-y-10" data-ui-page-subject>
    <UserMessage workingDir="/project" content="技术上能想办法实现吗？" sessionId="shared-task" messageClientId="user-2" agentKind="cc" remoteHostId={ctx.case === 'ssh' ? 'ssh-host' : undefined} />
    <AssistantMessage workingDir="/project" content="可以。分叉后会保留历史上下文，继续使用原来那台电脑上的共享模型。" currentSessionId="shared-task" messageClientId="reply-2" agentKind="cc" remoteHostId={ctx.case === 'ssh' ? 'ssh-host' : undefined} showActionBar />
  </div>,
});

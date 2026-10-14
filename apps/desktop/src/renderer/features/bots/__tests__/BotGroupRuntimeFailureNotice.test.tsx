// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotGroupRuntimeFailureNotice } from '../BotGroupRuntimeFailureNotice';
import zhCN from '../../../i18n/locales/zh-CN/common.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { name?: string }) => {
  if (key === 'commonUi.retry') return zhCN.commonUi.retry;
  const code = key.split('.').at(-1)!;
  return zhCN.bots.groupChat.notice.runtimeFailure[code as keyof typeof zhCN.bots.groupChat.notice.runtimeFailure].replace('{{name}}', options?.name ?? '');
} }) }));
afterEach(cleanup);

describe('group failure notice', () => {
  it('shows the image failure and the actual recovery settings', () => {
    render(<BotGroupRuntimeFailureNotice name="m" code="IMAGE_INPUT_UNSUPPORTED" />);
    expect(screen.getByText(/当前模型不支持图片/).textContent).toContain('设置 → 个性化 → 视觉桥');
    expect(screen.getByText(/当前模型不支持图片/).textContent).toContain('重新发送');
  });
  it('does not render an unknown or private diagnostic as group content', () => {
    const { container } = render(<BotGroupRuntimeFailureNotice name="m" code="private-token-and-path" />);
    expect(container.textContent).toBe('');
  });
  it('explains upstream capacity and offers a retry without attributing it to request frequency', () => {
    render(<BotGroupRuntimeFailureNotice name="m" code="UPSTREAM_OVERLOADED" />);
    expect(screen.getByText(/模型服务暂时繁忙/).textContent).toContain('稍后重新发送');
    expect(screen.getByText(/模型服务暂时繁忙/).textContent).toContain('其他可用模型');
  });
  it('offers a retry button only when the host can re-issue the request', () => {
    const { rerender } = render(<BotGroupRuntimeFailureNotice name="m" code="RUNTIME_TIMEOUT" />);
    expect(screen.queryByRole('button', { name: zhCN.commonUi.retry })).toBeNull();
    const onRetry = vi.fn();
    rerender(<BotGroupRuntimeFailureNotice name="m" code="RUNTIME_TIMEOUT" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: zhCN.commonUi.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/本次回复超时/)).toBeTruthy();
  });
});

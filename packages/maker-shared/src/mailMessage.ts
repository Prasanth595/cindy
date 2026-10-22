import { parseMailAttachmentItems, type GhostCardFormField, type MailAttachmentItem } from './ghostCardForm.js';

/** Mail providers return data; Cindy owns the read-only presentation. */
export interface MailReaderDeclaration {
  tool: string;
  hosts: string[];
  /** The reader accepts markRead:true for an explicit user opening, never background reads. */
  markRead?: true;
}
export function parseMailReader(value: unknown): MailReaderDeclaration | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.tool !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(p.tool) ||
      (p.markRead !== undefined && p.markRead !== true) ||
      !Array.isArray(p.hosts) || !p.hosts.length || p.hosts.length > 16 ||
      !p.hosts.every(h => typeof h === 'string' && h.length <= 253 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(h))) return null;
  return { tool: p.tool, hosts: [...new Set(p.hosts as string[])], ...(p.markRead === true ? { markRead: true } : {}) };
}
export function mailReaderMatches(reader: MailReaderDeclaration, url: string): boolean {
  try {
    const target = new URL(url);
    return url.length <= 2048 && target.protocol === 'https:' && !target.username && !target.password &&
      !target.port && reader.hosts.includes(target.hostname);
  } catch { return false; }
}
export interface MailMessage {
  accountId: string;
  messageId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  attachments: MailAttachmentItem[];
  /** Optional, chronological metadata only. Bodies are read on explicit expansion. */
  conversation?: MailConversation;
  conversationUnavailable?: boolean;
  markReadFailed?: boolean;
}
export interface MailMessageSummary {
  messageId: string;
  url: string;
  from: string;
  date: string;
  subject: string;
  snippet: string;
}
export interface MailConversation {
  threadId: string;
  messages: MailMessageSummary[];
}
function parseConversation(value: unknown, selectedId: string): MailConversation | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as MailConversation;
  if (typeof p.threadId !== 'string' || !p.threadId || p.threadId.length > 512 ||
      !Array.isArray(p.messages) || !p.messages.length || p.messages.length > 1000) return null;
  const ids = new Set<string>();
  const messages: MailMessageSummary[] = [];
  const limits = { messageId: 512, url: 2048, from: 16000, date: 256, subject: 16000, snippet: 2048 };
  for (const item of p.messages) {
    if (!item || typeof item !== 'object' || Object.entries(limits).some(([key, max]) =>
      typeof item[key as keyof MailMessageSummary] !== 'string' || item[key as keyof MailMessageSummary].length > max) ||
      !item.messageId || ids.has(item.messageId)) return null;
    try {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    } catch { return null; }
    ids.add(item.messageId);
    messages.push(Object.fromEntries(Object.keys(limits).map(k => [k, item[k as keyof MailMessageSummary]])) as unknown as MailMessageSummary);
  }
  return ids.has(selectedId) ? { threadId: p.threadId, messages } : null;
}
export function parseMailMessage(value: unknown): MailMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const limits = { accountId: 256, messageId: 512, from: 16000, to: 16000, cc: 16000, bcc: 16000,
    subject: 16000, date: 256, bodyText: 1024 * 1024, bodyHtml: 1024 * 1024 };
  if (Object.entries(limits).some(([key, max]) => typeof p[key] !== 'string' || (p[key] as string).length > max) ||
      !p.accountId || !p.messageId) return null;
  const attachments = parseMailAttachmentItems(JSON.stringify(p.attachments));
  if (!attachments) return null;
  const conversation = parseConversation(p.conversation, p.messageId as string);
  return { ...Object.fromEntries(Object.keys(limits).map(k => [k, p[k]])), attachments,
    ...(p.markReadFailed === true ? { markReadFailed: true } : {}),
    ...(conversation ? { conversation } : {}),
    ...(p.conversationUnavailable === true || (p.conversation !== undefined && !conversation) ? { conversationUnavailable: true } : {}),
  } as unknown as MailMessage;
}
/** Reuse the compose card's HTML, recipients, CID and attachment renderers, with no actions. */
export function mailMessageFields(mail: MailMessage, label: (key: string) => string): GhostCardFormField[] {
  return [
    ...(['to', 'cc', 'bcc'] as const).map(name => ({ name, label: label(name), value: mail[name], kind: 'recipients' as const, row: 'recipients' })),
    { name: 'subject', label: label('subject'), value: mail.subject },
    mail.bodyHtml ? { name: 'bodyHtml', label: '', value: mail.bodyHtml, kind: 'mail-html' } : { name: 'body', label: '', value: mail.bodyText, multiline: true },
    { name: 'attachmentItems', label: '', value: JSON.stringify(mail.attachments), kind: 'mail-attachments' },
  ];
}

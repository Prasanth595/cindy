/**
 * 云端伙伴（docs/product-rules/cloud-companions.md）：把伙伴交给另一台电脑前，先确认那台电脑的
 * Cindy 支持接手云端伙伴。只读能力探测，返回 `{ companionCloud: 1 }`；老版本没有该 channel →
 * CHANNEL_NOT_ALLOWED，交出方据此拒绝目标（不把伙伴交给接不住它的电脑）。
 */
export const COMPANION_CLOUD_CAPS_CHANNEL = 'maker:companion-cloud:caps';
export const COMPANION_CLOUD_VERSION = 1;

export interface CompanionCloudCaps {
  companionCloud: number;
}

/** True when the remote answer declares cloud-companion support. */
export function isCompanionCloudCaps(value: unknown): value is CompanionCloudCaps {
  return !!value && typeof value === 'object' && typeof (value as { companionCloud?: unknown }).companionCloud === 'number'
    && (value as { companionCloud: number }).companionCloud >= COMPANION_CLOUD_VERSION;
}

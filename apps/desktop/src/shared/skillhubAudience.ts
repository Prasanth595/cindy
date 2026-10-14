export interface SkillAudienceDepartment { id: string; name: string; parentId: string | null }
export interface SkillAudienceInput {
  visibilityDepartmentIds?: string[];
  audienceMode?: 'all' | 'departments';
  expectedUpdatedAt?: string;
}

/** Validate Renderer input before it reaches privileged publication requests. */
export function validateSkillAudience(input: SkillAudienceInput): void {
  const ids = input.visibilityDepartmentIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500
    || ids.some(id => typeof id !== 'string' || !id || id.trim() !== id || id.length > 191))) {
    throw new Error('Invalid department selection');
  }
  if (ids !== undefined && (input.audienceMode !== 'all' && input.audienceMode !== 'departments')) {
    throw new Error('Invalid audience mode');
  }
  if (ids !== undefined && ((input.audienceMode === 'departments') !== (ids.length > 0))) {
    throw new Error('Select at least one department');
  }
  if (input.expectedUpdatedAt !== undefined && (typeof input.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(input.expectedUpdatedAt)))) throw new Error('Invalid audience version');
}
